#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME;
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 240_000);
const appStartTimeoutMs = Number(process.env.BLACKBOX_APP_START_TIMEOUT_MS || 300_000);
const providerFile = join(resolve(process.env.HOME || ''), '.blackbox', 'providers.json');

if (!isolationRoot || !reportHome) {
  throw new Error('Run steer smoke through scripts/run-isolated.sh');
}
if (!existsSync(providerFile)) {
  throw new Error(`Isolated provider config is missing: ${providerFile}`);
}
assertExternalExecutionRoot(isolationRoot, privateRoots);

const providerData = JSON.parse(readFileSync(providerFile, 'utf8'));
const activeProvider = providerData.providers?.find(
  (provider) => provider.id === providerData.activeProviderId,
);
if (!activeProvider) throw new Error('Isolated provider config has no active provider');
const modelTier = process.env.BLACKBOX_SMOKE_MODEL_TIER || 'haiku';
if (!['haiku', 'sonnet'].includes(modelTier)) {
  throw new Error(`Steer smoke only permits Haiku or Sonnet, received ${modelTier}`);
}
const resolvedModel = activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === modelTier,
)?.providerModel;
if (!resolvedModel || /opus|fable/i.test(resolvedModel)) {
  throw new Error(`Steer smoke refuses this model mapping: ${resolvedModel || 'missing'}`);
}

const runId = `steer-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });

let appProcess = null;
let socketPath = null;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || workspace,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeout || timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
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

async function waitForHarness() {
  // Allow a cold isolated Cargo build to finish before judging the page
  // harness unavailable. Model execution keeps its own shorter timeout.
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
  socketPath = `/tmp/blackbox-steer-${process.pid}.sock`;
  const logFile = join(runRoot, 'app.log');
  const logFd = openSync(logFile, 'a');
  appProcess = spawn('pnpm', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
    cwd: projectRoot,
    env: { ...process.env, BLACKBOX_SOCKET: socketPath },
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
  try { await waitForAppExit(10_000); } catch {
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

const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const oldReply = `ORIGINAL_REPLY_${marker}`;
const expectedReply = `STEER_APPLIED_${marker}`;
const steerText = `引导：保持当前工具继续运行，但废弃原来的最终回答；工具结束后只回复 ${expectedReply}`;

const report = {
  runId,
  workspace,
  reportFile,
  modelTier,
  resolvedModel,
  providerId: activeProvider.id,
  uiThreadId: null,
  cliSessionId: null,
  jsonlPath: null,
  visualEvidence: {
    authority: 'external-window-audit-required',
    reason: 'Tauri screenshot commands can resolve another open window named main; DOM and bridge state are authoritative in this smoke.',
  },
  launch: null,
  checks: {},
  passed: false,
};

try {
  writeFileSync(join(workspace, 'README.md'), '# Isolated live steer smoke\n', 'utf8');
  report.launch = await startApp();
  await createDraft(workspace);
  cli(['switch-model', modelTier]);
  cli(['type', '/bypass']);
  cli(['send']);

  const displayedModel = cli([
    'get-visible-text', '--selector', '[data-testid="current-resolved-model"]',
  ]).text.trim();
  if (/opus|fable/i.test(displayedModel) || !/haiku|sonnet/i.test(displayedModel)) {
    throw new Error(`Steer smoke requires Haiku or Sonnet: ${displayedModel}`);
  }
  report.checks.allowedModelSelected = true;

  cli(['type', [
    'This is a mechanical live-steer acceptance test.',
    "Use Bash exactly once to run: sleep 10; printf 'STEER_TOOL_FINISHED\\n'",
    'Do not answer before that command finishes.',
    `After it finishes, reply exactly ${oldReply}`,
  ].join('\n')]);
  cli(['send']);
  const toolPhase = cli(['wait-for-phase', 'tool', '--timeout', String(timeoutMs)], {
    timeout: timeoutMs + 10_000,
  });
  if (toolPhase.error) throw new Error(toolPhase.error);
  const beforeSteer = cli(['exec', 'window.__blackbox_test.getContinuationState()']).result;
  if (!beforeSteer?.stdinId || beforeSteer.sessionStatus !== 'running') {
    throw new Error(`No live stdin available for steer: ${JSON.stringify(beforeSteer)}`);
  }
  report.checks.toolStillRunningBeforeSteer = true;

  cli(['exec', 'window.__blackbox_test.clearBridgeCallLog()']);
  cli(['type', steerText]);
  const steerModeText = cli(['get-visible-text', '--selector', '[data-chat-input]']).text;
  report.checks.steerComposerVisible = steerModeText.includes('引导') || steerModeText.includes('Guide');
  cli(['send']);
  await sleep(400);

  const afterSteer = cli(['exec', 'window.__blackbox_test.getContinuationState()']).result;
  const bridgeCalls = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result || [];
  const messages = cli(['get-messages', '--all', '--full']).messages || [];
  const matchingSend = bridgeCalls.filter(
    (entry) => entry.kind === 'sendStdin'
      && entry.stdinId === beforeSteer.stdinId
      && entry.message === steerText,
  );
  report.checks.sameStdinImmediateSend = matchingSend.length === 1;
  report.checks.noSecondProcessSpawn = !bridgeCalls.some((entry) => entry.kind === 'startSession');
  report.checks.notDeferredToPendingQueue = !(afterSteer?.pending || []).some(
    (item) => item.text === steerText,
  );
  report.checks.steerAcknowledgedInUi = messages.some(
    (message) => message.isSteer === true
      && message.steerState === 'sent'
      && message.content === steerText,
  );
  cli(['wait-for', '--text', expectedReply, '--timeout', String(timeoutMs)], {
    timeout: timeoutMs + 10_000,
  });
  const settled = cli(['wait-until-done', '--timeout', String(timeoutMs)], {
    timeout: timeoutMs + 10_000,
  });
  if (settled.status !== 'completed') {
    throw new Error(`Steered turn did not complete: ${JSON.stringify(settled)}`);
  }
  const finalMessages = cli(['get-messages', '--all', '--full']).messages || [];
  report.checks.steerChangedFinalAnswer = finalMessages.some(
    (message) => message.role === 'assistant'
      && message.type === 'text'
      && String(message.content || '').includes(expectedReply),
  );
  // The model's pre-tool thinking can legitimately mention the original
  // instruction before the steer arrives. Acceptance concerns user-visible
  // assistant text after guidance, not hidden reasoning snapshots.
  report.checks.originalAnswerSuppressed = !finalMessages.some(
    (message) => message.role === 'assistant'
      && message.type === 'text'
      && String(message.content || '').includes(oldReply),
  );

  report.uiThreadId = await waitForRealSession();
  const session = cli(['get-all-sessions']).sessions.find(
    (entry) => entry.id === report.uiThreadId,
  );
  report.cliSessionId = session?.cliResumeId || report.uiThreadId;
  report.jsonlPath = session?.path || null;
  if (!report.jsonlPath || !existsSync(report.jsonlPath)) {
    throw new Error(`Steer JSONL is missing: ${report.jsonlPath}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  const transcript = readFileSync(report.jsonlPath, 'utf8');
  const transcriptEvents = transcript.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const steerEnqueueIndex = transcriptEvents.findIndex(
    (event) => event.type === 'queue-operation'
      && event.operation === 'enqueue'
      && event.content === steerText,
  );
  const toolResultIndex = transcriptEvents.findIndex((event) => {
    const content = event.message?.content;
    return event.type === 'user'
      && Array.isArray(content)
      && content.some(
        (block) => block.type === 'tool_result'
          && String(block.content || '').includes('STEER_TOOL_FINISHED'),
      );
  });
  report.checks.steerQueuedBeforeToolFinished = steerEnqueueIndex >= 0
    && toolResultIndex > steerEnqueueIndex;
  report.checks.steerPersistedInSameTranscript = transcript.includes(steerText)
    && transcript.includes(expectedReply);
  report.checks.noPrivateWorkspaceAccess = true;

  // A queued steer is persisted by Claude Code as an attachment rather than a
  // normal user record. Reload the WebView to prove session-loader restores it
  // as a delivered guidance bubble without starting another model turn.
  const bridgeCallsBeforeReload = bridgeCalls.length;
  cli(['restart', '--timeout', '120000'], { timeout: 130_000 });
  cli(['wait-for', '--text', expectedReply, '--timeout', '30000'], { timeout: 40_000 });
  const reloadedSessionId = cli(['get-active-session']).session;
  const reloadedMessages = cli(['get-messages', '--all', '--full']).messages || [];
  const bridgeCallsAfterReload = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result || [];
  report.checks.reloadPreservedSessionIdentity = reloadedSessionId === report.uiThreadId;
  report.checks.reloadRestoredSteerBubble = reloadedMessages.some(
    (message) => message.isSteer === true
      && message.steerState === 'sent'
      && message.content === steerText,
  );
  report.checks.reloadDidNotSendAnotherTurn = bridgeCallsAfterReload.length <= bridgeCallsBeforeReload
    || !bridgeCallsAfterReload.some(
      (entry) => entry.kind === 'sendStdin' && entry.message === steerText,
    );
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try { await closeAppGracefully(); } catch { await forceStopApp(); }
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
