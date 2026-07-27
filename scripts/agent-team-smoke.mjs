#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const claudeBinary = process.env.BLACKBOX_SMOKE_CLAUDE_BIN;
const providerFile = process.env.BLACKBOX_SMOKE_PROVIDER_FILE;
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const automationHome = process.env.BLACKBOX_AUTOMATION_HOME;
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function requirePath(value, label) {
  if (!value || !existsSync(value)) throw new Error(`${label} is required and must exist`);
  return resolve(value);
}

const cli = requirePath(claudeBinary, 'BLACKBOX_SMOKE_CLAUDE_BIN');
const providersPath = requirePath(providerFile, 'BLACKBOX_SMOKE_PROVIDER_FILE');
const workspaceRoot = requirePath(isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT');
const runtimeRoot = dirname(workspaceRoot);
if (!automationHome || !claudeConfigDir) {
  throw new Error('BLACKBOX_AUTOMATION_HOME and CLAUDE_CONFIG_DIR are required');
}
if (!resolve(automationHome).startsWith(runtimeRoot)
    || !resolve(claudeConfigDir).startsWith(runtimeRoot)) {
  throw new Error('Agent team smoke requires every runtime path inside .dev-runtime');
}

const providers = JSON.parse(readFileSync(providersPath, 'utf8'));
const provider = providers.providers?.find((item) => item.id === providers.activeProviderId);
if (!provider?.apiKey) throw new Error('Isolated active provider with API key is required');
const model = process.env.BLACKBOX_SMOKE_MODEL
  || provider.modelMappings?.find((item) => item.tier === 'haiku')?.providerModel
  || provider.modelMappings?.find((item) => item.tier === 'sonnet')?.providerModel
  || 'claude-haiku-4-5-20251001';
if (/opus|fable/i.test(model)) {
  throw new Error(`Agent team smoke refuses Opus/Fable; choose Haiku or Sonnet (received ${model})`);
}

const childEnv = { ...process.env };
childEnv.ANTHROPIC_BASE_URL = provider.baseUrl;
childEnv.ANTHROPIC_API_KEY = provider.apiKey;
childEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
// Pin every teammate to the same provider-resolved logical tier as the lead.
// Without this, Claude Code's Default teammate model may silently pick another family.
childEnv.CLAUDE_CODE_SUBAGENT_MODEL = model;
delete childEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
for (const [key, value] of Object.entries(provider.extraEnv || {})) {
  if (value === '') delete childEnv[key];
  else childEnv[key] = String(value);
}
if (provider.proxyUrl) {
  for (const key of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) {
    childEnv[key] = provider.proxyUrl;
  }
}
for (const key of [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
]) delete childEnv[key];

const runId = `agent-team-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sessionId = randomUUID();
const workspace = join(workspaceRoot, runId);
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || automationHome;
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const traceFile = join(runRoot, 'stream.jsonl');
const reportFile = join(runRoot, 'report.json');
const markerA = `TEAM_ALPHA_${Date.now()}`;
const markerB = `TEAM_BETA_${Date.now() + 1}`;
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });
writeFileSync(join(workspace, 'alpha.txt'), `${markerA}\n`, 'utf8');
writeFileSync(join(workspace, 'beta.txt'), `${markerB}\n`, 'utf8');

const prompt = [
  'Act as an agent-team lead. This is a mechanical read-only acceptance test.',
  'Spawn exactly two agent-team teammates in parallel with the Agent tool name parameter:',
  '- name reader-alpha: read alpha.txt and send its exact marker to reader-beta with SendMessage.',
  '- name reader-beta: read beta.txt and send its exact marker to reader-alpha with SendMessage.',
  'Create one shared TaskCreate item for each teammate and keep task status accurate.',
  'These must be agent-team teammates, not ordinary subagents. Do not use TeamCreate or TeamDelete.',
  'Wait until both teammates finish and their peer messages have been delivered.',
  `Then answer exactly: TEAM_SMOKE_COMPLETE ${markerA} ${markerB}`,
  'Do not edit or write any file. Do not inspect paths outside this isolated directory.',
].join('\n');

const toolSet = 'Read,Agent,SendMessage,TaskCreate,TaskGet,TaskList,TaskUpdate';
const result = spawnSync(cli, [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--model', model,
  '--session-id', sessionId,
  '--permission-mode', 'dontAsk',
  '--teammate-mode', 'in-process',
  '--tools', toolSet,
  '--allowedTools', toolSet,
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--no-chrome',
  '--max-turns', '60',
], {
  cwd: workspace,
  env: childEnv,
  encoding: 'utf8',
  timeout: Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 360_000),
  maxBuffer: 40 * 1024 * 1024,
});

writeFileSync(traceFile, result.stdout || '', 'utf8');
const events = [];
const toolUses = [];
const resultTexts = [];
for (const line of (result.stdout || '').split('\n')) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  events.push(event);
  const blocks = event?.message?.content;
  if (event.type === 'assistant' && Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue;
      toolUses.push({
        name: block.name,
        id: block.id || null,
        input: block.input || {},
        parentToolUseId: event.parent_tool_use_id || null,
        agentId: event.agent_id || event.agentId || null,
      });
    }
  }
  if (event.type === 'result' && typeof event.result === 'string') resultTexts.push(event.result);
}

const spawnedNames = toolUses
  .filter((event) => event.name === 'Agent' && typeof event.input?.name === 'string')
  .map((event) => event.input.name);
const teamName = `session-${sessionId.slice(0, 8)}`;
const teamsRoot = join(resolve(claudeConfigDir), 'teams');
const teamConfigExistsAfterExit = existsSync(join(teamsRoot, teamName));
const remainingTeamConfigs = existsSync(teamsRoot)
  ? readdirSync(teamsRoot).filter((name) => existsSync(join(teamsRoot, name, 'config.json')))
  : [];
const finalText = resultTexts.join('\n');
const report = {
  runId,
  sessionId,
  teamName,
  model,
  workspace,
  traceFile,
  cliStatus: result.status,
  signal: result.signal,
  stderr: (result.stderr || '').trim().slice(0, 3000),
  toolUses: toolUses.map((event) => ({
    name: event.name,
    teammateName: event.name === 'Agent' ? event.input?.name || null : null,
    parentToolUseId: event.parentToolUseId,
    agentId: event.agentId,
  })),
  spawnedNames,
  taskCreateCount: toolUses.filter((event) => event.name === 'TaskCreate').length,
  taskUpdateCount: toolUses.filter((event) => event.name === 'TaskUpdate').length,
  sendMessageCount: toolUses.filter((event) => event.name === 'SendMessage').length,
  legacyTeamToolObserved: toolUses.some((event) => ['TeamCreate', 'TeamDelete'].includes(event.name)),
  markerAObserved: finalText.includes(markerA),
  markerBObserved: finalText.includes(markerB),
  teamConfigExistsAfterExit,
  remainingTeamConfigs,
};
report.passed = result.status === 0
  && ['reader-alpha', 'reader-beta'].every((name) => spawnedNames.includes(name))
  && report.taskCreateCount >= 2
  && report.taskUpdateCount >= 2
  && report.sendMessageCount >= 2
  && !report.legacyTeamToolObserved
  && report.markerAObserved
  && report.markerBObserved
  && !report.teamConfigExistsAfterExit;
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
