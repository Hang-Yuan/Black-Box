#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const claudeBinary = process.env.BLACKBOX_SMOKE_CLAUDE_BIN;
const providerFile = process.env.BLACKBOX_SMOKE_PROVIDER_FILE;
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const automationHome = process.env.BLACKBOX_AUTOMATION_HOME;
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const marketplace = join(scriptDir, 'fixtures', 'claude-plugin-marketplace');

function requirePath(value, label) {
  if (!value || !existsSync(value)) throw new Error(`${label} is required and must exist`);
  return resolve(value);
}

const cli = requirePath(claudeBinary, 'BLACKBOX_SMOKE_CLAUDE_BIN');
const providersPath = requirePath(providerFile, 'BLACKBOX_SMOKE_PROVIDER_FILE');
const workspaceRoot = requirePath(isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT');
requirePath(marketplace, 'plugin marketplace fixture');
if (!automationHome) throw new Error('BLACKBOX_AUTOMATION_HOME is required');
if (!claudeConfigDir) throw new Error('CLAUDE_CONFIG_DIR is required');

const runtimeRoot = dirname(workspaceRoot);
if (!resolve(claudeConfigDir).startsWith(runtimeRoot) || !resolve(automationHome).startsWith(runtimeRoot)) {
  throw new Error('Plugin smoke requires Claude and Black Box state inside the isolated runtime');
}

const providers = JSON.parse(readFileSync(providersPath, 'utf8'));
const provider = providers.providers?.find((item) => item.id === providers.activeProviderId);
if (!provider?.apiKey) throw new Error('Isolated active provider with API key is required');
const model = process.env.BLACKBOX_SMOKE_MODEL
  || provider.modelMappings?.find((item) => item.tier === 'haiku')?.providerModel
  || provider.modelMappings?.find((item) => item.tier === 'sonnet')?.providerModel
  || 'claude-haiku-4-5-20251001';
if (/opus|fable/i.test(model)) {
  throw new Error(`Plugin smoke refuses Opus/Fable models; choose Haiku or Sonnet (received ${model})`);
}

const childEnv = { ...process.env };
childEnv.ANTHROPIC_BASE_URL = provider.baseUrl;
childEnv.ANTHROPIC_API_KEY = provider.apiKey;
childEnv.CLAUDE_CODE_SUBAGENT_MODEL = model;
childEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
for (const [key, value] of Object.entries(provider.extraEnv || {})) {
  if (value === '') delete childEnv[key];
  else childEnv[key] = String(value);
}
if (provider.proxyUrl) {
  for (const key of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) childEnv[key] = provider.proxyUrl;
}
for (const key of [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
]) delete childEnv[key];

function runCli(args, options = {}) {
  const result = spawnSync(cli, args, {
    cwd: options.cwd || repoRoot,
    env: childEnv,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`claude ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout || '';
}

runCli(['plugin', 'validate', '--strict', marketplace]);
const configuredMarketplaces = JSON.parse(runCli(['plugin', 'marketplace', 'list', '--json']));
if (configuredMarketplaces.some((item) => item.name === 'blackbox-smoke')) {
  runCli(['plugin', 'marketplace', 'update', 'blackbox-smoke']);
} else {
  runCli(['plugin', 'marketplace', 'add', marketplace]);
}
const installed = JSON.parse(runCli(['plugin', 'list', '--json']));
const installedFixture = installed.find((item) => item.id === 'blackbox-trace-plugin@blackbox-smoke');
if (installedFixture) {
  runCli(['plugin', 'update', 'blackbox-trace-plugin@blackbox-smoke', '--scope', 'user']);
  if (!installedFixture.enabled) {
    runCli(['plugin', 'enable', 'blackbox-trace-plugin@blackbox-smoke', '--scope', 'user']);
  }
} else {
  runCli(['plugin', 'install', 'blackbox-trace-plugin@blackbox-smoke', '--scope', 'user']);
}
const details = runCli(['plugin', 'details', 'blackbox-trace-plugin@blackbox-smoke']);
if (!/Skills \(1\)/.test(details) || !/Agents \(1\)/.test(details)) {
  throw new Error('Installed plugin inventory did not expose one skill and one agent');
}

const runId = `plugin-subagent-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(workspaceRoot, runId);
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || automationHome;
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const resultFile = join(workspace, 'plugin-subagent-result.txt');
const traceFile = join(runRoot, 'stream.jsonl');
const reportFile = join(runRoot, 'report.json');
const marker = `PLUGIN_SUBAGENT_OK_${Date.now()}`;
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });

const prompt = [
  'Use the Skill tool to invoke blackbox-trace-plugin:delegated-write and follow it exactly.',
  `Delegate this exact output file to the plugin agent: ${resultFile}`,
  `The exact marker is: ${marker}`,
  'Do not write the file in the main agent.',
].join('\n');
const result = spawnSync(cli, [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--model', model,
  '--permission-mode', 'dontAsk',
  '--allowedTools', 'Skill,Agent,Write',
  '--tools', 'Skill,Agent,Write',
  '--setting-sources', 'user,project,local',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--no-chrome',
  '--no-session-persistence',
  '--max-turns', '20',
], {
  cwd: workspace,
  env: childEnv,
  encoding: 'utf8',
  timeout: Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 240_000),
  maxBuffer: 30 * 1024 * 1024,
});

writeFileSync(traceFile, result.stdout || '', 'utf8');
const trace = [];
for (const line of (result.stdout || '').split('\n')) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const blocks = event?.message?.content;
  if (event.type === 'assistant' && Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue;
      trace.push({
        type: 'tool_use',
        name: block.name,
        id: block.id || null,
        parentToolUseId: event.parent_tool_use_id || null,
        agentId: event.agent_id || event.agentId || null,
      });
    }
  }
  if (event.type === 'user' && Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;
      trace.push({
        type: 'tool_result',
        id: block.tool_use_id || null,
        isError: !!block.is_error,
        parentToolUseId: event.parent_tool_use_id || null,
        agentId: event.agent_id || event.agentId || null,
      });
    }
  }
  if (event.type === 'system' && ['task_started', 'task_notification'].includes(event.subtype)) {
    trace.push({
      type: event.subtype === 'task_started' ? 'agent_start' : 'agent_result',
      id: event.tool_use_id || null,
      taskId: event.task_id || null,
      status: event.status || (event.subtype === 'task_started' ? 'started' : 'completed'),
      agentType: event.subagent_type || null,
    });
  }
  if (event.type === 'result') {
    trace.push({
      type: 'result',
      subtype: event.subtype || null,
      isError: !!event.is_error,
      parentToolUseId: event.parent_tool_use_id || null,
      agentId: event.agent_id || event.agentId || null,
    });
  }
}

const toolUses = trace.filter((event) => event.type === 'tool_use');
const writeEvents = toolUses.filter((event) => event.name === 'Write');
const agentTool = toolUses.find((event) => event.name === 'Agent' || event.name === 'Task');
const subagentWrite = writeEvents.find((event) => event.parentToolUseId === agentTool?.id);
const toolResults = trace.filter((event) => event.type === 'tool_result');
const report = {
  runId,
  model,
  workspace,
  traceFile,
  resultFile,
  pluginId: 'blackbox-trace-plugin@blackbox-smoke',
  toolUses: toolUses.map((event) => event.name),
  trace,
  skillObserved: toolUses.some((event) => event.name === 'Skill'),
  agentObserved: toolUses.some((event) => event.name === 'Agent' || event.name === 'Task'),
  subagentWriteObserved: writeEvents.some((event) => event.parentToolUseId || event.agentId),
  mainAgentWriteObserved: writeEvents.some((event) => !event.parentToolUseId && !event.agentId),
  agentLifecycleObserved: trace.some((event) => event.type === 'agent_start' && event.id === agentTool?.id)
    && trace.some((event) => event.type === 'agent_result' && event.id === agentTool?.id && event.status === 'completed'),
  agentToolResultObserved: toolResults.some((event) => event.id === agentTool?.id && !event.isError),
  subagentWriteResultObserved: toolResults.some((event) => event.id === subagentWrite?.id
    && event.parentToolUseId === agentTool?.id && !event.isError),
  markerVerified: existsSync(resultFile) && readFileSync(resultFile, 'utf8').trim() === marker,
  cliStatus: result.status,
  stderr: (result.stderr || '').trim().slice(0, 2000),
};
report.passed = result.status === 0
  && report.skillObserved
  && report.agentObserved
  && report.subagentWriteObserved
  && !report.mainAgentWriteObserved
  && report.agentLifecycleObserved
  && report.agentToolResultObserved
  && report.subagentWriteResultObserved
  && report.markerVerified;
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
