#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const claudeBinary = process.env.BLACKBOX_SMOKE_CLAUDE_BIN;
const providerFile = process.env.BLACKBOX_SMOKE_PROVIDER_FILE;
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;

for (const [value, label] of [
  [claudeBinary, 'BLACKBOX_SMOKE_CLAUDE_BIN'],
  [providerFile, 'BLACKBOX_SMOKE_PROVIDER_FILE'],
  [isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT'],
]) {
  if (!value || !existsSync(value)) throw new Error(`${label} is required and must exist`);
}

const providers = JSON.parse(readFileSync(providerFile, 'utf8'));
const provider = providers.providers.find((item) => item.id === providers.activeProviderId);
if (!provider) throw new Error('Active provider is missing');
if (!provider.apiKey) throw new Error('Active provider has no API key');

const runId = `tool-use-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || process.env.BLACKBOX_AUTOMATION_HOME;
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const skillDir = join(workspace, '.claude', 'skills', 'tool-use-smoke');
const resultFile = join(workspace, 'tool-use-result.txt');
const traceFile = join(runRoot, 'stream.jsonl');
const reportFile = join(runRoot, 'report.json');
const marker = `TOOL_USE_OK_${Date.now()}`;

mkdirSync(skillDir, { recursive: true });
mkdirSync(runRoot, { recursive: true });
writeFileSync(
  join(skillDir, 'SKILL.md'),
  `---\nname: tool-use-smoke\ndescription: Mechanical Skill and Write tool acceptance test.\n---\n\n# Tool-use smoke\n\nUse the Write tool to create ${resultFile} with exactly this content:\n\n${marker}\n\nThen answer TOOL_USE_SMOKE_COMPLETE.\n`,
  'utf8',
);

const childEnv = { ...process.env };
childEnv.ANTHROPIC_BASE_URL = provider.baseUrl;
childEnv.ANTHROPIC_API_KEY = provider.apiKey;
childEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
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
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
]) {
  delete childEnv[key];
}

const model = process.env.BLACKBOX_SMOKE_MODEL
  || provider.modelMappings?.find((item) => item.tier === 'haiku')?.providerModel
  || 'claude-haiku-4-5-20251001';
if (/opus/i.test(model)) {
  throw new Error(`Smoke tests refuse Opus models; choose Haiku or Sonnet instead (received ${model})`);
}
const result = spawnSync(
  resolve(claudeBinary),
  [
    '-p',
    'Invoke the tool-use-smoke skill with the Skill tool and follow it exactly. Do not inspect or modify anything outside this isolated project.',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--permission-mode',
    'bypassPermissions',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    'Read,Write,Skill',
    '--no-session-persistence',
    '--max-turns',
    '20',
  ],
  {
    cwd: workspace,
    env: childEnv,
    encoding: 'utf8',
    timeout: Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 180_000),
    maxBuffer: 20 * 1024 * 1024,
  },
);

writeFileSync(traceFile, result.stdout || '', 'utf8');
if (result.status !== 0) {
  throw new Error(`Claude tool-use smoke failed: ${(result.stderr || '').trim()}`);
}

const toolNames = new Set();
function collectToolUses(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'tool_use' && typeof value.name === 'string') toolNames.add(value.name);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(collectToolUses);
    else collectToolUses(child);
  }
}
for (const line of (result.stdout || '').split('\n')) {
  if (!line.trim()) continue;
  try {
    collectToolUses(JSON.parse(line));
  } catch {
    // The report below fails if the required structured events are absent.
  }
}

const report = {
  runId,
  model,
  workspace,
  traceFile,
  resultFile,
  toolUses: [...toolNames].sort(),
  skillObserved: toolNames.has('Skill'),
  writeObserved: toolNames.has('Write'),
  markerVerified: existsSync(resultFile) && readFileSync(resultFile, 'utf8').trim() === marker,
};
report.passed = report.skillObserved && report.writeObserved && report.markerVerified;
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
