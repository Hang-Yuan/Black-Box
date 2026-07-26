#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExternalExecutionRoot,
  assertNoPrivateToolAccess,
  configuredPrivateRoots,
} from './isolation-guard.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoots = configuredPrivateRoots(projectRoot);
const cliPath = join(projectRoot, 'scripts', 'blackbox-cli.mjs');
const binary = resolve(
  process.env.BLACKBOX_SMOKE_BINARY
    || join(projectRoot, 'src-tauri', 'target', 'debug', 'blackbox'),
);
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const automationHome = process.env.BLACKBOX_AUTOMATION_HOME;
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || automationHome;
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 300_000);
const appStartTimeoutMs = Number(process.env.BLACKBOX_APP_START_TIMEOUT_MS || 300_000);
const providerFile = join(resolve(process.env.HOME || ''), '.blackbox', 'providers.json');

for (const [value, label] of [
  [isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT'],
  [automationHome, 'BLACKBOX_AUTOMATION_HOME'],
  [reportHome, 'BLACKBOX_SMOKE_REPORT_HOME'],
]) {
  if (!value) throw new Error(`${label} is required; run through scripts/run-isolated.sh`);
}
if (!existsSync(providerFile)) throw new Error(`Isolated provider config is missing: ${providerFile}`);
assertExternalExecutionRoot(isolationRoot, privateRoots);

const providerData = JSON.parse(readFileSync(providerFile, 'utf8'));
const activeProvider = providerData.providers?.find(
  (provider) => provider.id === providerData.activeProviderId,
);
if (!activeProvider) throw new Error('Isolated provider config has no active provider');

const modelTier = process.env.BLACKBOX_SMOKE_MODEL_TIER || 'haiku';
if (!['haiku', 'sonnet'].includes(modelTier)) {
  throw new Error(`Scheduled Activity smoke only permits Haiku or Sonnet, received ${modelTier}`);
}
const resolvedModel = activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === modelTier,
)?.providerModel;
if (!resolvedModel || /opus|fable/i.test(resolvedModel)) {
  throw new Error(`Scheduled Activity smoke refuses this model mapping: ${resolvedModel || 'missing'}`);
}

const runId = `scheduled-activity-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
const taskFile = join(runRoot, 'automation.json');
const taskId = `scheduled-activity-${Date.now()}`;
const marker = `SCHEDULED_ACTIVITY_OK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const resultFile = join(workspace, 'scheduled-activity-result.txt');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });
assertExternalExecutionRoot(workspace, privateRoots);
writeFileSync(join(workspace, 'README.md'), '# Isolated Scheduled Activity lifecycle smoke\n', 'utf8');

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const definition = {
  version: 1,
  id: taskId,
  kind: 'cron',
  name: 'Scheduled Activity lifecycle smoke',
  prompt: [
    'Use Bash exactly once and use no other tool.',
    `Run this exact command: sleep 12; printf '%s\\n' ${shellQuote(marker)} > ${shellQuote(resultFile)}`,
    `After the command finishes, return exactly: ${marker}`,
    'Do not inspect or access any other path.',
  ].join(' '),
  status: 'PAUSED',
  rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=59;BYSECOND=0',
  model: modelTier,
  reasoning_effort: 'low',
  agent_teams_enabled: false,
  execution_environment: 'local',
  target: { type: 'project', projectId: workspace },
  cwds: [workspace],
  target_thread_id: null,
  provider_id: activeProvider.id,
  provider_revision: Number(activeProvider.revision || 1),
  created_at: 0,
  updated_at: 0,
};
writeFileSync(taskFile, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');

let appProcess = null;
let automationRunProcess = null;
let socketPath = null;
let launchIndex = 0;

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

function parseJsonOutput(output, label) {
  const lines = String(output).trim().split('\n').filter(Boolean);
  try {
    return JSON.parse(lines.join('\n'));
  } catch {
    throw new Error(`${label} returned invalid JSON: ${String(output).trim()}`);
  }
}

function automationCli(...args) {
  return parseJsonOutput(
    runProcess(binary, ['--automation-tool', ...args]),
    `automation ${args.join(' ')}`,
  );
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

async function startApp(label) {
  launchIndex += 1;
  socketPath = `/tmp/blackbox-scheduled-activity-${process.pid}-${launchIndex}.sock`;
  const logFile = join(runRoot, `app-${launchIndex}-${label}.log`);
  const logFd = openSync(logFile, 'a');
  appProcess = spawn('pnpm', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
    cwd: projectRoot,
    env: { ...process.env, BLACKBOX_SOCKET: socketPath },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  await waitForHarness();
  report.launches.push({ pid: appProcess.pid, socketPath, logFile });
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
  if (!appProcess || appProcess.exitCode != null) return true;
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
  return true;
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

async function ensureActivityPanelOpen() {
  const present = cli(['exec', `Boolean(document.querySelector('[data-testid="activity-panel"]'))`]).result;
  if (!present) {
    cli(['exec', `document.querySelector('[data-testid="activity-panel-toggle"]')?.click()`]);
    cli(['wait-for', '--selector', '[data-testid="activity-panel"]', '--timeout', '10000']);
  }
}

function readActivityState() {
  return cli(['exec', `(()=>{
    const row=Array.from(document.querySelectorAll('[data-activity-automation-id]'))
      .find((node)=>node.getAttribute('data-activity-automation-id')===${JSON.stringify(taskId)});
    return {
      present:Boolean(row),
      running:row?.getAttribute('data-activity-automation-running')==='true',
      text:row?.textContent||'',
      panelText:document.querySelector('[data-testid="activity-panel"]')?.textContent||'',
    };
  })()`]).result;
}

async function waitForActivityState(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = readActivityState();
    if (predicate(last)) return { ...last, observedAt: new Date().toISOString() };
    await sleep(250);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

function startAutomationRun() {
  automationRunProcess = spawn(binary, ['--automation-tool', 'run', taskId], {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  automationRunProcess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  automationRunProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      try { automationRunProcess.kill('SIGTERM'); } catch {}
      rejectPromise(new Error(`Scheduled Activity run exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    automationRunProcess.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`Scheduled Activity run failed (${code ?? signal}): ${stderr.trim()}`));
        return;
      }
      try {
        resolvePromise(parseJsonOutput(stdout, 'scheduled activity run'));
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

function findNamedFile(root, name) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findNamedFile(path, name);
      if (nested) return nested;
    }
  }
  return null;
}

const report = {
  runId,
  workspace,
  reportFile,
  taskId,
  marker,
  resultFile,
  modelTier,
  resolvedModel,
  providerId: activeProvider.id,
  launches: [],
  stateBeforeRun: null,
  stateWhileRunning: null,
  stateAfterRun: null,
  stateAfterRelaunch: null,
  runIdValue: null,
  runStatus: null,
  sessionId: null,
  transcriptFile: null,
  toolUses: [],
  checks: {},
  passed: false,
};

try {
  await startApp('initial');
  const upserted = automationCli('upsert', taskFile);
  if (upserted.id !== taskId || upserted.status !== 'PAUSED' || upserted.running) {
    throw new Error(`Paused smoke task was not reconciled correctly: ${JSON.stringify(upserted)}`);
  }
  await createDraft(workspace);
  await ensureActivityPanelOpen();
  await sleep(3_000);
  report.stateBeforeRun = readActivityState();
  if (report.stateBeforeRun.present) {
    throw new Error(`Paused Scheduled task appeared as active: ${JSON.stringify(report.stateBeforeRun)}`);
  }
  report.checks.pausedTaskHiddenBeforeRun = true;

  const runPromise = startAutomationRun();
  report.stateWhileRunning = await Promise.race([
    waitForActivityState(
      (state) => state.present && state.running,
      'Activity panel did not observe the live Scheduled run',
    ),
    runPromise.then(
      () => { throw new Error('Scheduled run completed before Activity exposed its running state'); },
      (error) => { throw error; },
    ),
  ]);
  report.checks.runningStateObservedBeforeProcessExit = automationRunProcess?.exitCode == null;
  const runPayload = await runPromise;
  if (runPayload.Err) throw new Error(`Scheduled run failed: ${runPayload.Err}`);
  const run = runPayload.Ok;
  if (!run) throw new Error(`Scheduled run returned no result: ${JSON.stringify(runPayload)}`);
  report.runIdValue = run.runId;
  report.runStatus = run.status;
  report.sessionId = run.sessionId;
  report.toolUses = (run.trace || [])
    .filter((event) => event.eventType === 'tool_use')
    .map((event) => event.toolName)
    .filter(Boolean);
  if (run.status !== 'PENDING_REVIEW') {
    throw new Error(`Scheduled run did not reach review: ${run.error || run.status}`);
  }
  report.checks.pendingReviewRecorded = true;
  report.checks.bashToolRecorded = report.toolUses.includes('Bash');
  if (!report.checks.bashToolRecorded) throw new Error('Scheduled run trace did not record Bash');
  report.checks.resultMarkerVerified = existsSync(resultFile)
    && readFileSync(resultFile, 'utf8').trim() === marker;
  if (!report.checks.resultMarkerVerified) throw new Error('Scheduled run result marker is missing');

  const claudeRoot = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude');
  report.transcriptFile = findNamedFile(join(claudeRoot, 'projects'), `${report.sessionId}.jsonl`);
  if (!report.transcriptFile) throw new Error(`Scheduled transcript is missing for ${report.sessionId}`);
  assertNoPrivateToolAccess(report.transcriptFile, privateRoots);
  const transcriptEvents = readFileSync(report.transcriptFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  report.checks.haikuOrSonnetTranscriptVerified = transcriptEvents.some(
    (event) => event.type === 'assistant'
      && (event.message?.model || event.model) === resolvedModel
      && event.sessionId === report.sessionId
      && event.cwd === workspace,
  );
  if (!report.checks.haikuOrSonnetTranscriptVerified) {
    throw new Error(`Scheduled transcript did not verify ${resolvedModel}`);
  }
  report.checks.noPrivateWorkspaceAccess = true;

  report.stateAfterRun = await waitForActivityState(
    (state) => !state.present,
    'Completed paused task remained visible as running',
    15_000,
  );
  report.checks.runningStateClearedAfterCompletion = true;
  report.checks.initialNativeCloseClean = await closeAppGracefully();

  await startApp('reload');
  await createDraft(workspace);
  await ensureActivityPanelOpen();
  report.stateAfterRelaunch = await waitForActivityState(
    (state) => !state.present,
    'Completed Scheduled task reappeared as a ghost run after relaunch',
    10_000,
  );
  const persisted = automationCli('get', taskId);
  report.checks.noGhostRunAfterRelaunch = persisted.status === 'PAUSED' && !persisted.running;
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (automationRunProcess?.exitCode == null) {
    try { automationRunProcess.kill('SIGTERM'); } catch {}
  }
  try {
    await closeAppGracefully();
  } catch {
    await forceStopApp();
  }
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
