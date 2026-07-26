#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const runId = `fork-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
const lineageFile = join(resolve(process.env.HOME || ''), '.blackbox', 'forks.json');
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

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
  socketPath = `/tmp/blackbox-fork-lifecycle-${process.pid}-${launchIndex}.sock`;
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

function requestNativeClose() {
  try {
    cli(['exec', 'window.__blackbox_test.closeWindow()']);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Socket (?:connection ended|closed by BLACKBOX)|socket not found/i.test(message)) throw error;
  }
}

async function closeAppGracefully() {
  if (!appProcess || appProcess.exitCode != null) return;
  requestNativeClose();
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

async function waitForRealSession(notThisId = null) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = cli(['get-active-session']).session;
    if (current && !current.startsWith('draft_') && current !== notThisId) return current;
    await sleep(250);
  }
  throw new Error(`Draft was not promoted to a new durable session (source ${notThisId})`);
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

async function sendPrompt(prompt) {
  const before = allMessages();
  cli(['type', prompt]);
  cli(['send']);
  const settled = cli([
    'wait-until-done', '--timeout', String(timeoutMs),
    '--min-messages', String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') throw new Error(`Prompt did not complete: ${JSON.stringify(settled)}`);
  const after = allMessages();
  return { messages: after.messages.slice(before.total || 0), all: after };
}

function assistantText(messages) {
  return messages
    .filter((message) => message?.role === 'assistant' && message?.type === 'text')
    .map((message) => String(message.content || ''))
    .join('\n');
}

function assertNoTools(messages, label) {
  const names = messages
    .filter((message) => message?.type === 'tool_use')
    .map((message) => message.toolName);
  if (names.length) throw new Error(`${label} unexpectedly used tools: ${JSON.stringify(names)}`);
}

async function waitForForkRecord(childId, parentId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = cli(['get-current-fork']).fork;
    if (last?.childThreadId === childId && last?.parentThreadId === parentId) return last;
    await sleep(250);
  }
  throw new Error(`Fork lineage did not settle: ${JSON.stringify(last)}`);
}

async function waitForBanner(parentId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = cli(['exec', `(()=>{const el=document.querySelector('[data-testid="fork-banner"]');return el?{parent:el.getAttribute('data-parent-thread-id'),text:el.innerText}:null})()`]).result;
    if (state?.parent === parentId) return state;
    await sleep(250);
  }
  throw new Error(`Fork banner did not appear for ${parentId}`);
}

const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const baseMarker = `FORK_BASE_${marker}`;
const childMarker = `FORK_CHILD_${marker}`;

const report = {
  runId,
  workspace,
  reportFile,
  lineageFile,
  baseMarker,
  childMarker,
  modelTier: null,
  resolvedModel: null,
  providerId: null,
  parentThreadId: null,
  childThreadId: null,
  parentJsonl: null,
  childJsonl: null,
  parentHashBeforeFork: null,
  parentHashAfterFork: null,
  launches: [],
  checks: {},
  passed: false,
};

try {
  git('init');
  git('config', 'user.name', 'Black Box Fork Smoke');
  git('config', 'user.email', 'fork-smoke@blackbox.invalid');
  writeFileSync(join(workspace, 'README.md'), '# Fork lifecycle smoke\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'isolated baseline');

  report.launches.push(await startApp('initial'));
  await createDraft(workspace);
  cli(['switch-model', 'haiku']);
  report.modelTier = cli(['get-current-model']).model;
  report.providerId = cli(['get-current-provider']).provider;
  report.resolvedModel = cli(['get-visible-text', '--selector', '[data-testid="current-resolved-model"]']).text.trim();
  if (/opus|fable/i.test(report.resolvedModel) || !/haiku|sonnet/i.test(report.resolvedModel)) {
    throw new Error(`Fork smoke requires Haiku or Sonnet: ${report.resolvedModel}`);
  }

  const parentTurn = await sendPrompt(
    `For this conversation QA, keep the token ${baseMarker} in context. `
      + 'Do not use tools. Reply exactly BASE_CONTEXT_READY.',
  );
  assertNoTools(parentTurn.messages, 'Parent context turn');
  report.parentThreadId = await waitForRealSession();
  await sleep(500);
  const parentSession = cli(['get-all-sessions']).sessions.find((item) => item.id === report.parentThreadId);
  report.parentJsonl = parentSession?.path || null;
  if (!report.parentJsonl || !existsSync(report.parentJsonl)) throw new Error('Parent JSONL is missing');
  report.parentHashBeforeFork = sha256(report.parentJsonl);

  const forked = cli(['fork-session', '--session', report.parentThreadId, '--timeout', '30000'], { timeout: 40_000 });
  if (forked.source !== report.parentThreadId || !forked.draft?.startsWith('draft_')) {
    throw new Error(`Fork draft did not open: ${JSON.stringify(forked)}`);
  }
  if (forked.fork?.parentThreadId !== report.parentThreadId) {
    throw new Error(`Pending fork lineage is wrong: ${JSON.stringify(forked.fork)}`);
  }
  const inherited = allMessages();
  if (!inherited.messages.some((message) => String(message.content || '').includes(baseMarker))) {
    throw new Error('Fork draft did not clone visible parent history');
  }
  if (cli(['get-current-goal']).goal || cli(['get-current-plan']).plan) {
    throw new Error('Fork draft unexpectedly cloned Goal or Plan control state');
  }
  report.checks.historyClonedWithoutControls = true;

  const childTurn = await sendPrompt(
    `This is the independent fork. Do not use tools. Reply exactly: ${baseMarker} ${childMarker}`,
  );
  assertNoTools(childTurn.messages, 'Child fork turn');
  const childText = assistantText(childTurn.messages);
  if (!childText.includes(baseMarker) || !childText.includes(childMarker)) {
    throw new Error(`Child did not inherit parent context: ${childText}`);
  }
  report.childThreadId = await waitForRealSession(report.parentThreadId);
  if (report.childThreadId === report.parentThreadId) throw new Error('Fork reused the parent UUID');
  await waitForForkRecord(report.childThreadId, report.parentThreadId);
  await waitForBanner(report.parentThreadId);
  report.checks.childContextAndLineage = true;

  await sleep(500);
  const sessionsAfterFork = cli(['get-all-sessions']).sessions;
  const childSession = sessionsAfterFork.find((item) => item.id === report.childThreadId);
  report.childJsonl = childSession?.path || null;
  if (!report.childJsonl || !existsSync(report.childJsonl) || report.childJsonl === report.parentJsonl) {
    throw new Error('Fork child JSONL is missing or aliases the parent');
  }
  report.parentHashAfterFork = sha256(report.parentJsonl);
  if (report.parentHashAfterFork !== report.parentHashBeforeFork) {
    throw new Error('Parent JSONL changed while creating or using the fork');
  }
  if (readFileSync(report.parentJsonl, 'utf8').includes(childMarker)) {
    throw new Error('Child-only marker leaked into parent JSONL');
  }
  if (!existsSync(lineageFile)) throw new Error('Fork lineage file was not persisted');
  const lineage = JSON.parse(readFileSync(lineageFile, 'utf8'));
  if (lineage?.[report.childThreadId]?.parentThreadId !== report.parentThreadId) {
    throw new Error('Persisted fork lineage is incorrect');
  }
  report.checks.parentImmutableAndChildIndependent = true;

  const initialLog = readFileSync(report.launches[0].logFile, 'utf8');
  for (const expected of ['--fork-session', report.parentThreadId, report.childThreadId]) {
    if (!initialLog.includes(expected)) throw new Error(`App log did not contain ${expected}`);
  }
  report.checks.nativeForkFlagsObserved = true;

  cli(['restart', '--timeout', '30000'], { timeout: 40_000 });
  await waitForSelectedSession(report.childThreadId);
  await waitForEditor();
  await waitForForkRecord(report.childThreadId, report.parentThreadId);
  await waitForBanner(report.parentThreadId);
  report.checks.webviewReloadPersisted = true;

  requestNativeClose();
  const closeCode = await waitForAppExit();
  appProcess = null;
  socketPath = null;
  if (closeCode !== 0) throw new Error(`Native close exited with code ${closeCode}`);
  report.launches.push(await startApp('relaunch'));
  await waitForSelectedSession(report.childThreadId);
  await waitForEditor();
  await waitForForkRecord(report.childThreadId, report.parentThreadId);
  await waitForBanner(report.parentThreadId);
  report.checks.nativeRelaunchPersisted = true;

  cli(['exec', `document.querySelector('[data-testid="open-fork-parent"]')?.click()`]);
  await waitForSelectedSession(report.parentThreadId);
  const parentMessages = allMessages();
  if (parentMessages.messages.some((message) => String(message.content || '').includes(childMarker))) {
    throw new Error('Opening the parent displayed child-only context');
  }
  report.checks.parentNavigationIndependent = true;

  assertNoPrivateToolAccess(report.parentJsonl, privateRoots);
  assertNoPrivateToolAccess(report.childJsonl, privateRoots);
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
