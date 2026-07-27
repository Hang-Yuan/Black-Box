#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  assertExternalExecutionRoot,
  assertNoPrivateToolAccess,
  configuredPrivateRoots,
} from './isolation-guard.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoots = configuredPrivateRoots(projectRoot);
const cliPath = join(projectRoot, 'scripts', 'blackbox-cli.mjs');
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const automationHome = process.env.BLACKBOX_AUTOMATION_HOME;
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || automationHome;
const providerFile = process.env.BLACKBOX_SMOKE_PROVIDER_FILE;
const credentialFile = process.env.BLACKBOX_DEV_CREDENTIAL_STORE_FILE;
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 420_000);
const appStartTimeoutMs = Number(process.env.BLACKBOX_APP_START_TIMEOUT_MS || 300_000);

for (const [value, label] of [
  [isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT'],
  [automationHome, 'BLACKBOX_AUTOMATION_HOME'],
  [reportHome, 'BLACKBOX_SMOKE_REPORT_HOME'],
  [providerFile, 'BLACKBOX_SMOKE_PROVIDER_FILE'],
  [credentialFile, 'BLACKBOX_DEV_CREDENTIAL_STORE_FILE'],
]) {
  if (!value) throw new Error(`${label} is required; run through scripts/run-isolated.sh`);
}
if (!existsSync(providerFile)) throw new Error(`Isolated provider config is missing: ${providerFile}`);
assertExternalExecutionRoot(isolationRoot, privateRoots);

const originalProviderText = readFileSync(providerFile, 'utf8');
const providerData = JSON.parse(originalProviderText);
const credentialData = existsSync(credentialFile)
  ? JSON.parse(readFileSync(credentialFile, 'utf8'))
  : { secrets: {} };

function hasCredential(provider) {
  if (typeof provider.apiKey === 'string' && provider.apiKey.trim()) return true;
  return Boolean(
    provider.credentialRef
      && typeof credentialData.secrets?.[provider.credentialRef] === 'string'
      && credentialData.secrets[provider.credentialRef].trim(),
  );
}

const requestedProviderId = process.env.BLACKBOX_SMOKE_PROVIDER_ID?.trim();
const activeProvider = requestedProviderId
  ? providerData.providers?.find((provider) => provider.id === requestedProviderId)
  : providerData.providers?.find(hasCredential);
if (!activeProvider) throw new Error('No credentialed isolated provider is available for routing smoke');
if (!hasCredential(activeProvider)) {
  throw new Error(`Selected isolated provider has no credential: ${activeProvider.id}`);
}

const mainTier = process.env.BLACKBOX_SMOKE_MAIN_MODEL_TIER || 'sonnet';
const auxiliaryTier = process.env.BLACKBOX_SMOKE_AUX_MODEL_TIER || 'haiku';
for (const [tier, label] of [[mainTier, 'main'], [auxiliaryTier, 'auxiliary']]) {
  if (!['haiku', 'sonnet'].includes(tier)) {
    throw new Error(`Provider routing smoke only permits Haiku or Sonnet for ${label}, received ${tier}`);
  }
}
const resolveTier = (tier) => activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === tier,
)?.providerModel?.trim();
const mainModel = resolveTier(mainTier);
const auxiliaryModel = resolveTier(auxiliaryTier);
for (const [model, label] of [[mainModel, 'main'], [auxiliaryModel, 'auxiliary']]) {
  if (!model || /opus|fable/i.test(model)) {
    throw new Error(`Provider routing smoke refuses the ${label} model mapping: ${model || 'missing'}`);
  }
}
if (mainModel === auxiliaryModel) {
  throw new Error('Provider routing smoke requires distinct main and auxiliary model mappings');
}

const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const agentMarker = `ROUTING_AGENT_${marker}`;
const grepMarker = `ROUTING_GREP_${marker}`;
const expectedReply = `PROVIDER_ROUTING_COMPLETE ${agentMarker} EXAMPLE_DOMAIN_OK RED_IMAGE_OK`;
const runId = `provider-routing-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
const auditFile = join(workspace, 'auxiliary-routing-audit.jsonl');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function writeSolidRedPng(path, width = 64, height = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowSize = 1 + (width * 3);
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * rowSize;
    pixels[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = offset + 1 + (x * 3);
      pixels[pixel] = 255;
      pixels[pixel + 1] = 0;
      pixels[pixel + 2] = 0;
    }
  }
  writeFileSync(path, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

const grepProbePath = join(workspace, 'grep-probe.txt');
const imageProbePath = join(workspace, 'red-probe.png');
writeFileSync(grepProbePath, `${grepMarker}\n`, 'utf8');
writeSolidRedPng(imageProbePath);

// Provider selection is test-scoped. The exact original file, including its
// previous active provider and inline-to-keychain migration state, is restored
// after the isolated app exits.
writeFileSync(
  providerFile,
  `${JSON.stringify({ ...providerData, activeProviderId: activeProvider.id }, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

let appProcess = null;
let socketPath = null;
let sessionDetached = false;

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || workspace,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeout || timeoutMs,
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout || '';
}

function cli(args, options = {}) {
  if (!socketPath) throw new Error('Black Box app socket is not active');
  const stdout = runProcess(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    timeout: options.timeout || timeoutMs,
    env: { BLACKBOX_SOCKET: socketPath },
  });
  const payload = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
  if (!payload.ok) throw new Error(payload.error || `CLI command failed: ${args.join(' ')}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHarness() {
  const deadline = Date.now() + appStartTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return cli(['status'], { timeout: 5_000 });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500);
    }
  }
  throw new Error(`Black Box page harness did not become ready: ${lastError}`);
}

async function startApp() {
  socketPath = `/tmp/blackbox-provider-routing-${process.pid}.sock`;
  const logFile = join(runRoot, 'app.log');
  const logFd = openSync(logFile, 'a');
  appProcess = spawn('pnpm', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      BLACKBOX_SOCKET: socketPath,
      BLACKBOX_DEV_AUXILIARY_MODEL_AUDIT_FILE: auditFile,
    },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  await waitForHarness();
  return { pid: appProcess.pid, socketPath, logFile };
}

async function waitForAppExit(timeout = 30_000) {
  const child = appProcess;
  if (!child || child.exitCode != null) return child?.exitCode ?? 0;
  return await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      rejectPromise(new Error(`Black Box dev app did not exit within ${timeout}ms`));
    }, timeout);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolvePromise(code ?? (signal ? -1 : 0));
    };
    child.once('exit', onExit);
  });
}

async function closeAppGracefully() {
  if (!appProcess || appProcess.exitCode != null) return;
  try {
    cli(['exec', 'window.__blackbox_test.closeWindow()']);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Socket (?:connection ended|closed by BLACKBOX)|socket not found/i.test(message)) throw error;
  }
  const exitCode = await waitForAppExit();
  if (exitCode !== 0) throw new Error(`Black Box dev app exited with code ${exitCode}`);
  appProcess = null;
  socketPath = null;
}

async function forceStopApp() {
  if (!appProcess || appProcess.exitCode != null) return;
  try { appProcess.kill('SIGTERM'); } catch {}
  try {
    await waitForAppExit(10_000);
  } catch {
    try { appProcess.kill('SIGKILL'); } catch {}
  }
  appProcess = null;
  socketPath = null;
}

async function createDraft(cwd) {
  const deadline = Date.now() + 30_000;
  let last = null;
  while (Date.now() < deadline) {
    cli(['new-session', '--cwd', cwd]);
    await sleep(300);
    last = cli(['check-editor']);
    if (last.editorReady && last.session) return last;
    await sleep(500);
  }
  throw new Error(`Could not create a stable draft session: ${JSON.stringify(last)}`);
}

async function waitForRealSession() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = cli(['get-active-session']).session;
    if (current && !current.startsWith('draft_')) return current;
    await sleep(250);
  }
  throw new Error('Draft session was not promoted to a durable session');
}

async function waitForLeadAssistantText(needle, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let latest = '';
  while (Date.now() < deadline) {
    const messages = cli(['get-messages', '--all', '--full']).messages.filter(
      (message) => message.role === 'assistant'
        && message.type === 'text'
        && (message.subAgentDepth == null || message.subAgentDepth === 0),
    );
    latest = String(messages.at(-1)?.content || '').trim();
    if (latest.includes(needle)) return latest;
    await sleep(150);
  }
  throw new Error(`Lead assistant text did not contain ${needle}: ${latest}`);
}

function walk(value, visitor) {
  visitor(value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visitor);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) walk(entry, visitor);
  }
}

function inspectTranscript(jsonlPath) {
  const toolNames = [];
  const initializedModels = [];
  const runtimeTools = [];
  const toolNamesById = new Map();
  let agentToolResultObserved = false;
  const events = [];
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    events.push(event);
    if (event?.type === 'system' && event?.subtype === 'init' && typeof event.model === 'string') {
      initializedModels.push(event.model);
      if (Array.isArray(event.tools)) {
        runtimeTools.push(...event.tools.filter((tool) => typeof tool === 'string'));
      }
    }
    walk(event, (value) => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'tool_use' && typeof value.name === 'string') {
        toolNames.push(value.name);
        if (typeof value.id === 'string') toolNamesById.set(value.id, value.name);
      }
    });
  }
  for (const event of events) {
    walk(event, (value) => {
      if (!value || typeof value !== 'object' || value.type !== 'tool_result') return;
      if (toolNamesById.get(value.tool_use_id) === 'Agent' && value.is_error !== true) {
        agentToolResultObserved = true;
      }
    });
  }
  return {
    toolNames,
    initializedModels,
    agentToolObserved: toolNames.includes('Agent'),
    agentToolResultObserved,
    webToolObserved: toolNames.includes('WebFetch'),
    grepToolObserved: toolNames.includes('Grep'),
    imageReadObserved: toolNames.includes('Read'),
    forcedWebMcpAbsent: !toolNames.includes('mcp__blackbox_web__research'),
    runtimeTools,
  };
}

function readAuditRecords() {
  if (!existsSync(auditFile)) return [];
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runtimeToolsFromLog(log) {
  const matches = [...log.matchAll(
    /Claude runtime tool inventory \(\d+\): ([^\r\n]*)/g,
  )];
  const latest = matches.at(-1)?.[1] || '';
  return latest.split(',').map((tool) => tool.trim()).filter(Boolean);
}

const report = {
  runId,
  reportFile,
  providerId: activeProvider.id,
  providerFormat: activeProvider.apiFormat,
  mainTier,
  mainModel,
  auxiliaryTier,
  auxiliaryModel,
  uiThreadId: null,
  launch: null,
  toolNames: [],
  runtimeTools: [],
  initializedModels: [],
  observations: {},
  checks: {},
  passed: false,
};

try {
  report.launch = await startApp();
  await createDraft(workspace);
  cli(['switch-provider', activeProvider.id]);
  cli(['switch-model', mainTier]);
  cli(['switch-auxiliary-model', auxiliaryTier]);
  cli(['switch-mode', 'bypass']);

  report.checks.providerSelected = cli(['get-current-provider']).provider === activeProvider.id;
  report.checks.mainTierSelected = cli(['get-current-model']).model === mainTier;
  report.checks.auxiliaryTierSelected = cli(['get-current-auxiliary-model']).model === auxiliaryTier;
  const displayedModel = cli([
    'get-visible-text', '--selector', '[data-testid="current-resolved-model"]',
  ]).text.trim();
  report.checks.mainModelDisplayed = displayedModel.toLowerCase().includes(mainTier);
  report.checks.disallowedModelsAbsent = !/opus|fable/i.test(`${mainModel} ${auxiliaryModel} ${displayedModel}`);

  cli(['exec', 'window.confirm=()=>true']);
  cli(['exec', `(()=>{const button=document.querySelector('[data-testid="agent-panel-toggle"]');if(!button)return {error:'missing agent toggle'};button.click();return {clicked:true}})()`]);
  cli(['wait-for', '--selector', '[data-testid="agent-teams-toggle"]', '--timeout', '10000']);
  const teamState = cli(['exec', `(()=>{const toggle=document.querySelector('[data-testid="agent-teams-toggle"]');if(!toggle)return {error:'missing team toggle'};if(toggle.getAttribute('aria-checked')==='true')toggle.click();return {enabled:toggle.getAttribute('aria-checked')==='true'}})()`]).result;
  if (teamState?.error) throw new Error(teamState.error);
  await sleep(300);
  const agentTeamsEnabled = cli([
    'exec', `document.querySelector('[data-testid="agent-teams-toggle"]')?.getAttribute('aria-checked')`,
  ]).result;
  report.checks.agentTeamsDisabled = agentTeamsEnabled === 'false' || agentTeamsEnabled === false;
  cli(['exec', `document.querySelector('[data-testid="agent-panel-toggle"]')?.click()`]);

  const before = cli(['get-messages', '--all', '--full']);
  cli(['type', [
    'This is a mechanical Black Box provider-routing acceptance test.',
    'Perform exactly these three native tool calls and no others in the lead context:',
    `1. Call Agent exactly once as an ordinary general-purpose subagent. Do not provide a model field. Ask it to return exactly ${agentMarker} without calling any tool.`,
    '2. Call WebFetch exactly once for https://example.com and ask it to extract the page title. Use the result to emit EXAMPLE_DOMAIN_OK.',
    `3. Call Read exactly once for ${imageProbePath}; inspect the returned image and emit RED_IMAGE_OK only if it is visibly red.`,
    `After all three results arrive, reply exactly: ${expectedReply}`,
    'Do not edit files. Do not inspect any path outside this isolated working directory.',
  ].join('\n')]);
  cli(['send']);

  const settled = cli([
    'wait-until-done', '--timeout', String(timeoutMs),
    '--min-messages', String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') {
    throw new Error(`Provider routing turn did not complete: ${JSON.stringify(settled)}`);
  }
  // The process can report an idle transition a few milliseconds before the
  // final assistant text is committed to the React store.
  const finalReply = await waitForLeadAssistantText('RED_IMAGE_OK');
  report.checks.leadTurnSettled = true;

  report.checks.agentResultReachedLead = finalReply.includes(agentMarker);
  report.checks.webResultReachedLead = finalReply.includes('EXAMPLE_DOMAIN_OK');
  report.checks.imageResultReachedLead = finalReply.includes('RED_IMAGE_OK');
  report.observations.expectedFinalReplyObserved = finalReply === expectedReply;

  const appLogAfterLead = readFileSync(report.launch.logFile, 'utf8');
  report.runtimeTools = runtimeToolsFromLog(appLogAfterLead);
  const grepAdvertised = report.runtimeTools.includes('Grep');
  report.observations.grepAdvertisedByRuntime = grepAdvertised;
  if (grepAdvertised) {
    const beforeGrep = cli(['get-messages', '--all', '--full']);
    cli(['type', [
      'This is a separate native Grep dispatch test.',
      `Call the Grep tool exactly once for the literal ${grepMarker} in ${grepProbePath}.`,
      'Bash, Read, Glob, and every other tool are forbidden for this turn.',
      `After Grep returns, reply exactly: ${grepMarker}`,
    ].join('\n')]);
    cli(['send']);
    const grepSettled = cli([
      'wait-until-done', '--timeout', String(timeoutMs),
      '--min-messages', String((beforeGrep.total || 0) + 2),
    ], { timeout: timeoutMs + 10_000 });
    if (grepSettled.status !== 'completed') {
      throw new Error(`Native Grep turn did not complete: ${JSON.stringify(grepSettled)}`);
    }
    const grepAssistantMessages = cli(['get-messages', '--all', '--full']).messages.filter(
      (message) => message.role === 'assistant'
        && message.type === 'text'
        && (message.subAgentDepth == null || message.subAgentDepth === 0),
    );
    const grepReply = String(grepAssistantMessages.at(-1)?.content || '').trim();
    report.checks.grepResultReachedLead = grepReply === grepMarker;
    report.observations.grepReply = grepReply;
  } else {
    report.checks.grepAbsentFromRuntimeInventory = true;
    report.observations.grepReply = 'GREP_UNAVAILABLE (system:init)';
  }

  report.uiThreadId = await waitForRealSession();
  const session = cli(['get-all-sessions']).sessions.find(
    (entry) => entry.id === report.uiThreadId,
  );
  const jsonlPath = session?.path || null;
  if (!jsonlPath || !existsSync(jsonlPath)) {
    throw new Error(`Provider routing JSONL is missing: ${jsonlPath}`);
  }
  assertNoPrivateToolAccess(jsonlPath, privateRoots);
  report.checks.noPrivateWorkspaceAccess = true;

  const transcript = inspectTranscript(jsonlPath);
  report.toolNames = transcript.toolNames;
  report.initializedModels = transcript.initializedModels;
  const appLog = readFileSync(report.launch.logFile, 'utf8');
  const mainModelArgument = `"--model", "${mainModel}"`;
  report.checks.mainModelSpawnArgumentObserved = appLog.includes(mainModelArgument);
  report.checks.agentToolObserved = transcript.agentToolObserved;
  report.observations.agentToolResultBlockObserved = transcript.agentToolResultObserved;
  report.checks.webToolObserved = transcript.webToolObserved;
  report.checks.grepInventoryConsistent = grepAdvertised
    ? transcript.grepToolObserved
    : !transcript.grepToolObserved;
  report.checks.imageReadObserved = transcript.imageReadObserved;
  report.checks.forcedWebMcpAbsent = transcript.forcedWebMcpAbsent;

  const auditRecords = readAuditRecords();
  report.checks.agentAuxiliaryModelObserved = auditRecords.some(
    (record) => record.toolName === 'Agent'
      && record.enforcedModel === auxiliaryTier
      && record.routing === 'blackbox-auxiliary-model-hook',
  );
  report.checks.auditPromptContentAbsent = auditRecords.every(
    (record) => !Object.prototype.hasOwnProperty.call(record, 'prompt'),
  );

  const deletion = cli(['delete-session'], { timeout: 30_000 });
  sessionDetached = deletion.detachedFromBlackBox === true;
  report.checks.immediateDetachReported = sessionDetached
    && deletion.privateTranscriptPreserved === true;
  await sleep(500);
  report.checks.privateSessionFilePreserved = existsSync(jsonlPath);
  report.checks.sessionIndexDeleted = !cli(['get-all-sessions']).sessions.some(
    (entry) => entry.id === report.uiThreadId,
  );
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (!sessionDetached && appProcess && socketPath) {
    try {
      const deletion = cli(['delete-session'], { timeout: 30_000 });
      sessionDetached = deletion.detachedFromBlackBox === true;
    } catch {}
  }
  try {
    await closeAppGracefully();
  } catch {
    await forceStopApp();
  }
  writeFileSync(providerFile, originalProviderText, { encoding: 'utf8', mode: 0o600 });
  rmSync(workspace, { recursive: true, force: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
