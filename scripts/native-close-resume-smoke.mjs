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
const automationHome = process.env.BLACKBOX_AUTOMATION_HOME;
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || automationHome;
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 180_000);

for (const [value, label] of [
  [isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT'],
  [automationHome, 'BLACKBOX_AUTOMATION_HOME'],
  [reportHome, 'BLACKBOX_SMOKE_REPORT_HOME'],
]) {
  if (!value) throw new Error(`${label} is required; run through scripts/run-isolated.sh`);
}
assertExternalExecutionRoot(isolationRoot, privateRoots);

const runId = `native-close-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });

let appProcess = null;
let socketPath = null;
let launchIndex = 0;

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

function git(...args) {
  return runProcess('git', args).trim();
}

function cli(args, options = {}) {
  if (!socketPath) throw new Error('Black Box app socket is not active');
  const stdout = runProcess(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    timeout: options.timeout || timeoutMs,
    env: { BLACKBOX_SOCKET: socketPath },
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const payload = JSON.parse(lines.at(-1) || '{}');
  if (!payload.ok) throw new Error(payload.error || `CLI command failed: ${args.join(' ')}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHarness() {
  const deadline = Date.now() + 90_000;
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
  if (appProcess && appProcess.exitCode == null) throw new Error('Black Box dev app is already running');
  launchIndex += 1;
  socketPath = `/tmp/blackbox-native-close-${process.pid}-${launchIndex}.sock`;
  const logFile = join(runRoot, `app-${launchIndex}-${label}.log`);
  const logFd = openSync(logFile, 'a');
  appProcess = spawn('pnpm', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
    cwd: projectRoot,
    env: { ...process.env, BLACKBOX_SOCKET: socketPath },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  await waitForHarness();
  return { socketPath, logFile, pid: appProcess.pid };
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
  cli(['exec', 'window.__blackbox_test.closeWindow()']);
  await waitForAppExit();
  appProcess = null;
  socketPath = null;
}

async function forceStopApp() {
  if (!appProcess || appProcess.exitCode != null) return;
  try {
    appProcess.kill('SIGTERM');
  } catch {
    // Already gone.
  }
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
  let last;
  while (Date.now() < deadline) {
    cli(['new-session', '--cwd', cwd]);
    await sleep(300);
    last = cli(['check-editor']);
    if (last.editorReady && last.session) return last;
    await sleep(500);
  }
  throw new Error(`Could not create a stable draft session: ${JSON.stringify(last)}`);
}

async function waitForEditor() {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    last = cli(['check-editor']);
    if (last.editorReady && last.session) return last;
    await sleep(250);
  }
  throw new Error(`Editor did not become ready: ${JSON.stringify(last)}`);
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

async function waitForSelectedSession(expected) {
  const deadline = Date.now() + 30_000;
  let current = null;
  while (Date.now() < deadline) {
    current = cli(['get-active-session']).session;
    if (current === expected) return current;
    await sleep(250);
  }
  throw new Error(`Expected selected session ${expected}, received ${current}`);
}

function allMessages() {
  return cli(['get-messages', '--all', '--full']);
}

function assistantText(messages) {
  return messages
    .filter((message) => message?.role === 'assistant' && message?.type === 'text')
    .map((message) => String(message.content || ''))
    .join('\n');
}

function hasTool(messages, name) {
  return messages.some((message) => message?.type === 'tool_use' && message?.toolName === name);
}

function assertNoTools(messages, label) {
  const tool = messages.find((message) => message?.type === 'tool_use');
  if (tool) throw new Error(`${label} unexpectedly used ${tool.toolName || 'a tool'}`);
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label} did not contain ${needle}`);
}

async function sendPrompt(prompt) {
  const before = allMessages();
  cli(['type', prompt]);
  cli(['send']);
  const settled = cli([
    'wait-until-done',
    '--timeout',
    String(timeoutMs),
    '--min-messages',
    String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') throw new Error(`Prompt did not complete: ${JSON.stringify(settled)}`);
  const after = allMessages();
  return {
    completedAt: Date.now(),
    messages: after.messages.slice(before.total || 0),
    all: after,
  };
}

async function reloadWebview(expectedSession) {
  cli(['restart', '--timeout', '30000'], { timeout: 40_000 });
  await waitForSelectedSession(expectedSession);
  await waitForEditor();
}

async function nativeCloseAndRelaunch(expectedSession, label) {
  cli(['exec', 'window.__blackbox_test.closeWindow()']);
  const exitCode = await waitForAppExit();
  appProcess = null;
  socketPath = null;
  if (exitCode !== 0) throw new Error(`Native close exited with code ${exitCode}`);
  const launch = await startApp(label);
  await waitForSelectedSession(expectedSession);
  await waitForEditor();
  return launch;
}

async function nativeQuitAndRelaunch(expectedSession, label) {
  const quittingLaunch = report.launches.at(-1);
  if (!quittingLaunch?.logFile) throw new Error('Current app launch log is unavailable');
  cli(['exec', 'window.__blackbox_test.quitApp()']);
  const exitCode = await waitForAppExit();
  appProcess = null;
  socketPath = null;
  if (exitCode !== 0) throw new Error(`Native quit exited with code ${exitCode}`);
  const quitLog = readFileSync(quittingLaunch.logFile, 'utf8');
  if (!quitLog.includes('[BLACKBOX] quit settled CLI sessions; exiting application')) {
    throw new Error('Native quit did not traverse RunEvent::ExitRequested settlement');
  }
  const launch = await startApp(label);
  await waitForSelectedSession(expectedSession);
  await waitForEditor();
  return launch;
}

function continuationState(tabId) {
  return cli([
    'exec',
    `window.__blackbox_test.getContinuationState(${JSON.stringify(tabId)})`,
  ]).result;
}

async function waitForContinuationState(tabId, predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = continuationState(tabId);
    if (predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

const marker = (label) => `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const localCloseSentinel = marker('LOCAL_CLOSE');
const localReloadSentinel = marker('LOCAL_RELOAD');
const localDiscardSentinel = marker('LOCAL_DISCARD');
const localCompactSentinel = marker('LOCAL_COMPACT');
const worktreeCloseSentinel = marker('WORKTREE_CLOSE');
const cmdQCloseSentinel = marker('CMD_Q_CLOSE');
const backgroundTurnSentinel = marker('BACKGROUND_TURN');
const backgroundFollowupSentinel = marker('BACKGROUND_FOLLOWUP');
const hydrationRaceSentinel = marker('HYDRATION_RACE');

const report = {
  runId,
  workspace,
  reportFile,
  modelTier: null,
  resolvedModel: null,
  providerId: null,
  uiThreadId: null,
  cliSessionId: null,
  jsonlPath: null,
  worktreeCwd: null,
  launches: [],
  timingsMs: {},
  checks: {},
  raceEvidence: {},
  passed: false,
};

try {
  git('init');
  git('config', 'user.name', 'Black Box Native Close Smoke');
  git('config', 'user.email', 'native-close-smoke@blackbox.invalid');
  writeFileSync(join(workspace, 'README.md'), '# Native close resume matrix\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'isolated baseline');

  report.launches.push(await startApp('initial'));
  await createDraft(workspace);
  cli(['switch-model', 'haiku']);
  report.modelTier = cli(['get-current-model']).model;
  report.providerId = cli(['get-current-provider']).provider;
  report.resolvedModel = cli(['get-visible-text', '--selector', '[data-testid="current-resolved-model"]']).text.trim();
  if (/opus|fable/i.test(report.resolvedModel) || !/haiku|sonnet/i.test(report.resolvedModel)) {
    throw new Error(`Native close smoke requires Haiku or Sonnet: ${report.resolvedModel}`);
  }

  const localCloseFile = join(workspace, 'LOCAL_CLOSE.txt');
  const localCloseTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${localCloseFile} containing exactly ${localCloseSentinel}. `
      + `Remember ${localCloseSentinel} as the private LOCAL_CLOSE sentinel. Reply exactly LOCAL_CLOSE_READY.`,
  );
  if (!hasTool(localCloseTurn.messages, 'Write')) throw new Error('Local close turn did not use Write');
  report.uiThreadId = await waitForRealSession();
  const firstSession = cli(['get-all-sessions']).sessions.find((session) => session.id === report.uiThreadId);
  if (!firstSession) throw new Error(`Promoted session is missing from the sidebar: ${report.uiThreadId}`);
  if (!firstSession.cliResumeId) throw new Error('Promoted session is missing cliResumeId');
  if (!firstSession.path) throw new Error('Promoted session is missing its JSONL path');
  report.cliSessionId = firstSession.cliResumeId;
  report.jsonlPath = firstSession.path;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);

  const localCloseStartedAt = Date.now();
  report.launches.push(await nativeCloseAndRelaunch(report.uiThreadId, 'after-local-close'));
  report.timingsMs.localToolToNativeClose = localCloseStartedAt - localCloseTurn.completedAt;
  const localCloseProbe = await sendPrompt('Do not read files and do not use tools. Return the private LOCAL_CLOSE sentinel exactly.');
  assertNoTools(localCloseProbe.messages, 'Local native-close probe');
  assertIncludes(assistantText(localCloseProbe.messages), localCloseSentinel, 'Local native-close probe');
  report.checks.localNativeCloseResume = true;

  const localReloadFile = join(workspace, 'LOCAL_RELOAD.txt');
  const localReloadTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${localReloadFile} containing exactly ${localReloadSentinel}. `
      + `Remember ${localReloadSentinel} as the private LOCAL_RELOAD sentinel. Reply exactly LOCAL_RELOAD_READY.`,
  );
  if (!hasTool(localReloadTurn.messages, 'Write')) throw new Error('Local reload turn did not use Write');
  const localReloadStartedAt = Date.now();
  await reloadWebview(report.uiThreadId);
  report.timingsMs.localToolToReload = localReloadStartedAt - localReloadTurn.completedAt;
  const localReloadProbe = await sendPrompt('Do not read files and do not use tools. Return the private LOCAL_RELOAD sentinel exactly.');
  assertNoTools(localReloadProbe.messages, 'Local reload probe');
  assertIncludes(assistantText(localReloadProbe.messages), localReloadSentinel, 'Local reload probe');
  report.checks.localReloadResume = true;

  const localDiscardFile = join(workspace, 'LOCAL_DISCARD.txt');
  const localDiscardTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${localDiscardFile} containing exactly ${localDiscardSentinel}. `
      + `Remember ${localDiscardSentinel} as the private LOCAL_DISCARD sentinel. Reply exactly LOCAL_DISCARD_READY.`,
  );
  if (!hasTool(localDiscardTurn.messages, 'Write')) throw new Error('Local discard turn did not use Write');
  const localRewindStartedAt = Date.now();
  cli(['rewind-conversation', 'latest', '--action', 'restore_all', '--timeout', '30000'], { timeout: 40_000 });
  report.timingsMs.localToolToRewind = localRewindStartedAt - localDiscardTurn.completedAt;
  if (existsSync(localDiscardFile)) {
    throw new Error('restore_all left the discarded file in the workspace');
  }
  report.checks.localRewindFiles = true;
  const localRewindProbe = await sendPrompt(
    'Do not read files and do not use tools. Return the private LOCAL_RELOAD sentinel exactly. '
      + 'Then on a new line write LOCAL_DISCARD=NONE if no LOCAL_DISCARD sentinel exists in this conversation.',
  );
  assertNoTools(localRewindProbe.messages, 'Local rewind probe');
  const localRewindText = assistantText(localRewindProbe.messages);
  assertIncludes(localRewindText, localReloadSentinel, 'Local rewind probe');
  assertIncludes(localRewindText, 'LOCAL_DISCARD=NONE', 'Local rewind probe');
  if (localRewindText.includes(localDiscardSentinel)) throw new Error('Local rewind retained the discarded sentinel');
  report.checks.localRewindResume = true;

  const localCompactFile = join(workspace, 'LOCAL_COMPACT.txt');
  const localCompactTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${localCompactFile} containing exactly ${localCompactSentinel}. `
      + `Remember ${localCompactSentinel} as the private LOCAL_COMPACT sentinel. Reply exactly LOCAL_COMPACT_READY.`,
  );
  if (!hasTool(localCompactTurn.messages, 'Write')) throw new Error('Local compact turn did not use Write');
  const compactBefore = allMessages().total || 0;
  const localCompactStartedAt = Date.now();
  cli(['type', '/compact']);
  cli(['send']);
  const compactSettled = cli([
    'wait-until-done', '--timeout', String(timeoutMs), '--min-messages', String(compactBefore + 1),
  ], { timeout: timeoutMs + 10_000 });
  if (compactSettled.status !== 'completed') throw new Error(`Local compact did not settle: ${JSON.stringify(compactSettled)}`);
  report.timingsMs.localToolToCompact = localCompactStartedAt - localCompactTurn.completedAt;
  await reloadWebview(report.uiThreadId);
  const localCompactProbe = await sendPrompt('Do not read files and do not use tools. Return the private LOCAL_COMPACT sentinel exactly.');
  assertNoTools(localCompactProbe.messages, 'Local compact probe');
  assertIncludes(assistantText(localCompactProbe.messages), localCompactSentinel, 'Local compact probe');
  report.checks.localCompactResume = true;

  const sidebarRefresh = cli([
    'exec',
    '(() => { const button = Array.from(document.querySelectorAll("button")).find((item) => item.title === "刷新"); if (!button) return false; button.click(); return true; })()',
  ]);
  if (!sidebarRefresh.result) throw new Error('Sidebar refresh button was not available');
  await sleep(1_000);
  await waitForSelectedSession(report.uiThreadId);
  const sessionAfterSidebarRefresh = cli(['get-all-sessions']).sessions.find(
    (session) => session.id === report.uiThreadId,
  );
  if (!sessionAfterSidebarRefresh) throw new Error('Sidebar refresh removed the durable session record');
  if (!sessionAfterSidebarRefresh.cliResumeId) throw new Error('Sidebar refresh lost cliResumeId');
  if (!sessionAfterSidebarRefresh.path) throw new Error('Sidebar refresh lost the JSONL path');
  const refreshedCliSessionId = sessionAfterSidebarRefresh.cliResumeId;
  if (refreshedCliSessionId !== report.cliSessionId) {
    throw new Error(`Sidebar refresh changed CLI UUID: ${report.cliSessionId} -> ${refreshedCliSessionId}`);
  }
  if (sessionAfterSidebarRefresh.path !== report.jsonlPath) {
    throw new Error(`Sidebar refresh changed JSONL path: ${report.jsonlPath} -> ${sessionAfterSidebarRefresh.path}`);
  }
  const sidebarRefreshProbe = await sendPrompt(
    'Do not read files and do not use tools. Return the private LOCAL_COMPACT sentinel exactly. '
      + 'Then on a new line return SIDEBAR_REFRESH_OK.',
  );
  assertNoTools(sidebarRefreshProbe.messages, 'Sidebar refresh probe');
  const sidebarRefreshText = assistantText(sidebarRefreshProbe.messages);
  assertIncludes(sidebarRefreshText, localCompactSentinel, 'Sidebar refresh probe');
  assertIncludes(sidebarRefreshText, 'SIDEBAR_REFRESH_OK', 'Sidebar refresh probe');
  report.checks.sidebarRefreshResume = true;

  const handoff = cli(['handoff-task', 'worktree', '--timeout', '90000'], { timeout: 100_000 });
  if (handoff.currentLocation !== 'worktree') throw new Error(`Worktree handoff failed: ${JSON.stringify(handoff)}`);
  report.worktreeCwd = handoff.currentCwd;
  const worktreeCloseFile = join(report.worktreeCwd, 'WORKTREE_CLOSE.txt');
  const worktreeCloseTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${worktreeCloseFile} containing exactly ${worktreeCloseSentinel}. `
      + `Remember ${worktreeCloseSentinel} as the private WORKTREE_CLOSE sentinel. Reply exactly WORKTREE_CLOSE_READY.`,
  );
  if (!hasTool(worktreeCloseTurn.messages, 'Write')) throw new Error('Worktree close turn did not use Write');
  const worktreeCloseStartedAt = Date.now();
  report.launches.push(await nativeCloseAndRelaunch(report.uiThreadId, 'after-worktree-close'));
  report.timingsMs.worktreeToolToNativeClose = worktreeCloseStartedAt - worktreeCloseTurn.completedAt;
  const locationAfterClose = cli(['get-task-location']);
  if (locationAfterClose.currentLocation !== 'worktree' || locationAfterClose.currentCwd !== report.worktreeCwd) {
    throw new Error(`Worktree location changed across native close: ${JSON.stringify(locationAfterClose)}`);
  }
  const worktreeCloseProbe = await sendPrompt(
    'Do not read files and do not use tools. Return the private WORKTREE_CLOSE sentinel exactly. '
      + 'Then on a new line return the private LOCAL_COMPACT sentinel exactly.',
  );
  assertNoTools(worktreeCloseProbe.messages, 'Worktree native-close probe');
  const worktreeCloseText = assistantText(worktreeCloseProbe.messages);
  assertIncludes(worktreeCloseText, worktreeCloseSentinel, 'Worktree native-close probe');
  assertIncludes(worktreeCloseText, localCompactSentinel, 'Worktree compact/native-close probe');
  report.checks.worktreeNativeCloseResume = true;
  report.checks.compactSurvivesNativeRelaunch = true;

  const cmdQCloseFile = join(report.worktreeCwd, 'CMD_Q_CLOSE.txt');
  const cmdQCloseTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${cmdQCloseFile} containing exactly ${cmdQCloseSentinel}. `
      + `Remember ${cmdQCloseSentinel} as the private CMD_Q_CLOSE sentinel. Reply exactly CMD_Q_CLOSE_READY.`,
  );
  if (!hasTool(cmdQCloseTurn.messages, 'Write')) throw new Error('Cmd-Q close turn did not use Write');
  report.launches.push(await nativeQuitAndRelaunch(report.uiThreadId, 'after-cmd-q-close'));
  const cmdQCloseProbe = await sendPrompt(
    'Do not read files and do not use tools. Return the private CMD_Q_CLOSE sentinel exactly. '
      + 'Then on a new line return the private LOCAL_COMPACT sentinel exactly.',
  );
  assertNoTools(cmdQCloseProbe.messages, 'Cmd-Q native-quit probe');
  const cmdQCloseText = assistantText(cmdQCloseProbe.messages);
  assertIncludes(cmdQCloseText, cmdQCloseSentinel, 'Cmd-Q native-quit probe');
  assertIncludes(cmdQCloseText, localCompactSentinel, 'Cmd-Q compact/native-quit probe');
  report.checks.cmdQResume = true;

  // Deterministic busy/manual + background auto-compact priority gate. Lower
  // the threshold only in the dev webview, hold a real Haiku turn in Bash,
  // and queue manual /compact while that turn owns stdin. Plain text sent
  // during the original turn is now Steer by contract, so wait until compact
  // owns stdin before queueing the ordinary follow-up. The compact result must
  // then dispatch that queued follow-up after compact, including in background.
  cli(['exec', 'window.__blackbox_test.setAutoCompactThreshold(1)']);
  cli(['exec', 'window.__blackbox_test.clearBridgeCallLog()']);
  cli(['type',
    `Use the Bash tool exactly once to run sleep 3. Remember ${backgroundTurnSentinel}. `
      + 'After the command finishes, reply exactly BACKGROUND_TURN_READY.',
  ]);
  cli(['send']);
  const toolPhase = cli(['wait-for-phase', 'tool', '--timeout', '30000'], { timeout: 40_000 });
  if (toolPhase.phase !== 'tool') throw new Error(`Background gate never reached tool phase: ${JSON.stringify(toolPhase)}`);
  const busyState = continuationState(report.uiThreadId);
  if (!busyState.stdinId) throw new Error('Background gate lost the live stdin before queueing');
  const backgroundStdinId = busyState.stdinId;

  cli(['type', '/compact']);
  cli(['send']);
  const manualCompactQueuedState = await waitForContinuationState(
    report.uiThreadId,
    (state) => state.pending.some((item) => item.kind === 'command' && item.text === '/compact'),
    'Busy manual compact queue',
    10_000,
  );
  const beforeCompactDispatch = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result;
  if (beforeCompactDispatch.some((entry) => entry.kind === 'sendStdin' && entry.message === '/compact')) {
    throw new Error('Busy manual /compact bypassed the queue');
  }
  report.checks.busyManualCompactQueued = true;

  const compactOwnedState = await waitForContinuationState(
    report.uiThreadId,
    (state) => Boolean(state.pendingCommandMsgId)
      && !state.pending.some((item) => item.kind === 'command' && item.text === '/compact')
      && state.sessionStatus === 'running',
    'Queued compact did not take stdin ownership',
    60_000,
  );
  const afterCompactDispatch = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result;
  if (!afterCompactDispatch.some((entry) => entry.kind === 'sendStdin' && entry.message === '/compact')) {
    throw new Error('Queued compact took ownership without reaching the CLI bridge');
  }

  const followupText = `After the current turn and compact finish, do not use tools. Reply exactly ${backgroundFollowupSentinel}.`;
  cli(['type', followupText]);
  cli(['send']);
  const queuedState = await waitForContinuationState(
    report.uiThreadId,
    (state) => state.pending.some(
      (item) => item.kind === 'user' && item.text.includes(backgroundFollowupSentinel),
    ),
    'Compact-owned follow-up queue',
    10_000,
  );
  const beforeBackgroundDispatch = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result;
  if (beforeBackgroundDispatch.some(
    (entry) => entry.kind === 'sendStdin'
      && typeof entry.message === 'string'
      && entry.message.includes(backgroundFollowupSentinel),
  )) {
    throw new Error('Compact-owned follow-up bypassed the queue');
  }

  const backgroundDraft = await createDraft(workspace);
  if (backgroundDraft.session === report.uiThreadId) throw new Error('Could not switch away for background compact gate');
  const backgroundSettledState = await waitForContinuationState(
    report.uiThreadId,
    (state) => state.pending.length === 0
      && !state.pendingCommandMsgId
      && state.sessionStatus === 'completed',
    'Background auto-compact and follow-up settlement',
  );
  const backgroundMessages = cli([
    'get-messages', '--tab', report.uiThreadId, '--all', '--full',
  ]).messages;
  const backgroundText = assistantText(backgroundMessages);
  assertIncludes(backgroundText, backgroundFollowupSentinel, 'Background queued follow-up');
  const dispatchLog = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result
    .filter((entry) => entry.kind === 'sendStdin' && entry.stdinId === backgroundStdinId);
  const compactDispatchIndex = dispatchLog.findIndex((entry) => entry.message === '/compact');
  const followupDispatchIndex = dispatchLog.findIndex(
    (entry) => typeof entry.message === 'string' && entry.message.includes(backgroundFollowupSentinel),
  );
  if (compactDispatchIndex < 0 || followupDispatchIndex < 0 || compactDispatchIndex >= followupDispatchIndex) {
    throw new Error(`Background dispatch order was not compact-first: ${JSON.stringify(dispatchLog)}`);
  }
  report.raceEvidence.backgroundQueue = {
    manualCompactQueuedKinds: manualCompactQueuedState.pending.map((item) => item.kind),
    compactOwner: compactOwnedState.pendingCommandMsgId,
    queuedKinds: queuedState.pending.map((item) => item.kind),
    finalPending: backgroundSettledState.pending.length,
    dispatchOrder: dispatchLog.map((entry) => entry.message),
  };
  report.checks.backgroundAutoCompactPriority = true;
  cli(['exec', 'window.__blackbox_test.setAutoCompactThreshold(null)']);
  cli(['switch-session', report.uiThreadId]);
  await waitForSelectedSession(report.uiThreadId);
  await waitForEditor();

  // Deterministic disk-hydration gate. Reload to settle the live CLI, switch
  // to a draft, evict the durable tab cache, then delay the real loadSession
  // bridge. A submit during that window must preserve the draft and may not
  // call startSession or sendStdin.
  await reloadWebview(report.uiThreadId);
  await createDraft(workspace);
  const dropped = cli([
    'exec',
    `window.__blackbox_test.dropSessionCache(${JSON.stringify(report.uiThreadId)})`,
  ]).result;
  if (dropped.stillCached) throw new Error('Hydration gate could not evict the durable tab cache');
  cli(['exec', 'window.__blackbox_test.setSessionLoadDelay(1500)']);
  cli(['exec', 'window.__blackbox_test.clearBridgeCallLog()']);
  cli([
    'exec',
    `(() => { window.dispatchEvent(new CustomEvent('blackbox:open-session', { detail: { sessionId: ${JSON.stringify(report.uiThreadId)} } })); return { started: true }; })()`,
  ]);
  await waitForContinuationState(
    report.uiThreadId,
    (state) => state.hydratingFromDisk === true,
    'Disk hydration start',
    5_000,
  );
  cli([
    'exec',
    `window.__blackbox_test.setDraft(${JSON.stringify(report.uiThreadId)}, ${JSON.stringify(hydrationRaceSentinel)})`,
  ]);
  cli(['exec', 'window.__blackbox_test.send()']);
  const hydrationBlockedState = continuationState(report.uiThreadId);
  const hydrationBlockedLog = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result;
  if (!hydrationBlockedState.hydratingFromDisk || hydrationBlockedState.stdinId) {
    throw new Error(`Hydration submit was not held exclusively: ${JSON.stringify(hydrationBlockedState)}`);
  }
  if (hydrationBlockedLog.some((entry) => entry.kind === 'startSession' || entry.kind === 'sendStdin')) {
    throw new Error(`Hydration submit reached the CLI bridge: ${JSON.stringify(hydrationBlockedLog)}`);
  }
  const hydratedState = await waitForContinuationState(
    report.uiThreadId,
    (state) => !state.hydratingFromDisk && state.sessionStatus === 'completed',
    'Disk hydration completion',
    10_000,
  );
  if (hydratedState.inputDraft !== hydrationRaceSentinel || hydratedState.stdinId) {
    throw new Error(`Hydration did not preserve the blocked draft: ${JSON.stringify(hydratedState)}`);
  }
  const hydrationFinalLog = cli(['exec', 'window.__blackbox_test.getBridgeCallLog()']).result;
  if (hydrationFinalLog.some((entry) => entry.kind === 'startSession' || entry.kind === 'sendStdin')) {
    throw new Error(`Hydration completion spawned unexpectedly: ${JSON.stringify(hydrationFinalLog)}`);
  }
  cli(['exec', 'window.__blackbox_test.setSessionLoadDelay(0)']);
  cli([
    'exec',
    `window.__blackbox_test.setDraft(${JSON.stringify(report.uiThreadId)}, '')`,
  ]);
  report.raceEvidence.hydration = {
    blockedGeneration: hydrationBlockedState.hydrationGeneration,
    bridgeKinds: hydrationFinalLog.map((entry) => entry.kind),
    preservedDraft: true,
  };
  report.checks.hydrationSendBlocked = true;

  const finalSession = cli(['get-all-sessions']).sessions.find((session) => session.id === report.uiThreadId);
  if (!finalSession) throw new Error('Final durable session record is missing');
  if (!finalSession.cliResumeId) throw new Error('Final durable session lost cliResumeId');
  if (!finalSession.path) throw new Error('Final durable session lost the JSONL path');
  const finalCliSessionId = finalSession.cliResumeId;
  if (finalCliSessionId !== report.cliSessionId) throw new Error(`CLI UUID changed: ${report.cliSessionId} -> ${finalCliSessionId}`);
  if (finalSession.path !== report.jsonlPath) {
    throw new Error(`JSONL path changed: ${report.jsonlPath} -> ${finalSession.path}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  report.checks.identityStable = true;
  report.checks.noPrivateWorkspaceAccess = true;
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    await closeAppGracefully();
  } catch {
    await forceStopApp();
  }
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
