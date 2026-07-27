#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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
const socketPath = process.env.BLACKBOX_SOCKET || '/tmp/blackbox-test.sock';
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 180_000);

for (const [value, label] of [
  [isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT'],
  [automationHome, 'BLACKBOX_AUTOMATION_HOME'],
]) {
  if (!value) throw new Error(`${label} is required; run through scripts/run-isolated.sh`);
}
if (!existsSync(socketPath)) {
  throw new Error(`Black Box dev socket is missing at ${socketPath}; start pnpm dev:isolated first`);
}

const runId = `resume-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });

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
  const stdout = runProcess(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    timeout: options.timeout || timeoutMs,
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const payload = JSON.parse(lines.at(-1) || '{}');
  if (!payload.ok) throw new Error(payload.error || `CLI command failed: ${args.join(' ')}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForEditor() {
  const deadline = Date.now() + 20_000;
  let last;
  while (Date.now() < deadline) {
    last = cli(['check-editor']);
    if (last.editorReady) return last;
    await sleep(200);
  }
  throw new Error(`Editor did not become ready: ${JSON.stringify(last)}`);
}

async function waitForHarness() {
  const deadline = Date.now() + 45_000;
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
  if (settled.status !== 'completed') {
    throw new Error(`Prompt did not complete: ${JSON.stringify(settled)}`);
  }
  const completedAt = Date.now();
  const after = allMessages();
  return {
    beforeTotal: before.total || 0,
    completedAt,
    messages: after.messages.slice(before.total || 0),
    all: after,
  };
}

const baseSentinel = `BASE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const discardSentinel = `DISCARD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const compactSentinel = `COMPACT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  timingsMs: {},
  checks: {},
  passed: false,
};

try {
  assertExternalExecutionRoot(isolationRoot, privateRoots);
  git('init');
  git('config', 'user.name', 'Black Box Resume Smoke');
  git('config', 'user.email', 'resume-smoke@blackbox.invalid');
  writeFileSync(join(workspace, 'README.md'), '# Isolated resume matrix\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'isolated baseline');

  await waitForHarness();
  await createDraft(workspace);
  cli(['switch-model', 'haiku']);
  await waitForEditor();

  report.modelTier = cli(['get-current-model']).model;
  report.providerId = cli(['get-current-provider']).provider;
  report.resolvedModel = cli([
    'get-visible-text',
    '--selector',
    '[data-testid="current-resolved-model"]',
  ]).text.trim();
  if (/opus|fable/i.test(report.resolvedModel)) {
    throw new Error(`Resume smoke refuses Opus/Fable: ${report.resolvedModel}`);
  }
  if (!/haiku|sonnet/i.test(report.resolvedModel)) {
    throw new Error(`Resume smoke requires Haiku or Sonnet: ${report.resolvedModel}`);
  }

  const baseFile = join(workspace, 'BASE.txt');
  const baseTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${baseFile} containing exactly ${baseSentinel}. `
      + `After the tool succeeds, remember ${baseSentinel} as the private BASE conversation sentinel. `
      + 'Reply exactly TOOL_BOUNDARY_BASE_READY.',
  );
  if (!hasTool(baseTurn.messages, 'Write')) throw new Error('BASE turn did not use the Write tool');
  if (readFileSync(join(workspace, 'BASE.txt'), 'utf8').trim() !== baseSentinel) {
    throw new Error('BASE tool output was not written correctly');
  }

  report.uiThreadId = await waitForRealSession();
  const sessionsAfterBase = cli(['get-all-sessions']).sessions;
  const sessionAfterBase = sessionsAfterBase.find((session) => session.id === report.uiThreadId);
  report.cliSessionId = sessionAfterBase?.cliResumeId || report.uiThreadId;
  report.jsonlPath = sessionAfterBase?.path || null;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);

  const handoffStartedAt = Date.now();
  const handoff = cli(['handoff-task', 'worktree', '--timeout', '90000'], { timeout: 100_000 });
  report.timingsMs.baseToolToHandoff = handoffStartedAt - baseTurn.completedAt;
  report.worktreeCwd = handoff.currentCwd;
  if (handoff.currentLocation !== 'worktree' || !report.worktreeCwd || report.worktreeCwd === workspace) {
    throw new Error(`Worktree handoff failed: ${JSON.stringify(handoff)}`);
  }

  const discardFile = join(report.worktreeCwd, 'DISCARD.txt');
  const discardTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${discardFile} containing exactly ${discardSentinel}. `
      + `After the tool succeeds, remember ${discardSentinel} as the private DISCARD conversation sentinel. `
      + 'Reply exactly TOOL_BOUNDARY_DISCARD_READY.',
  );
  if (!hasTool(discardTurn.messages, 'Write')) throw new Error('DISCARD turn did not use the Write tool');
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);

  const rewindStartedAt = Date.now();
  const rewind = cli([
    'rewind-conversation',
    'latest',
    '--action',
    'restore_conversation',
    '--timeout',
    '30000',
  ], { timeout: 40_000 });
  report.timingsMs.discardToolToRewind = rewindStartedAt - discardTurn.completedAt;
  report.checks.worktreeRewindAction = rewind.action === 'restore_conversation';

  const rewindProbe = await sendPrompt(
    'Do not read files and do not use tools. Return the private BASE conversation sentinel exactly. '
      + 'Then on a new line write DISCARD=NONE if no DISCARD sentinel exists in the current conversation.',
  );
  const rewindText = assistantText(rewindProbe.messages);
  assertIncludes(rewindText, baseSentinel, 'Worktree rewind probe');
  assertIncludes(rewindText, 'DISCARD=NONE', 'Worktree rewind probe');
  if (rewindText.includes(discardSentinel)) throw new Error('Rewound DISCARD sentinel leaked into the resumed answer');
  report.checks.worktreeRewindContext = true;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);

  const compactFile = join(report.worktreeCwd, 'COMPACT.txt');
  const compactBoundaryTurn = await sendPrompt(
    `Use the Write tool exactly once to create ${compactFile} containing exactly ${compactSentinel}. `
      + `After the tool succeeds, remember ${compactSentinel} as the private COMPACT conversation sentinel. `
      + 'Reply exactly TOOL_BOUNDARY_COMPACT_READY.',
  );
  if (!hasTool(compactBoundaryTurn.messages, 'Write')) {
    throw new Error('COMPACT boundary turn did not use the Write tool');
  }

  const compactStartedAt = Date.now();
  cli(['type', '/compact']);
  cli(['send']);
  const compactSettled = cli(
    ['wait-until-done', '--timeout', String(timeoutMs)],
    { timeout: timeoutMs + 10_000 },
  );
  report.timingsMs.compactToolToCommand = compactStartedAt - compactBoundaryTurn.completedAt;
  if (compactSettled.status !== 'completed') {
    throw new Error(`Worktree compact did not settle: ${JSON.stringify(compactSettled)}`);
  }
  report.checks.worktreeCompactSettled = true;

  const reloadStartedAt = Date.now();
  cli(['restart', '--timeout', '30000'], { timeout: 40_000 });
  report.timingsMs.compactToReload = Date.now() - reloadStartedAt;
  await waitForSelectedSession(report.uiThreadId);
  await waitForEditor();
  const locationAfterReload = cli(['get-task-location']);
  if (locationAfterReload.currentLocation !== 'worktree' || locationAfterReload.currentCwd !== report.worktreeCwd) {
    throw new Error(`Worktree location was not durable across reload: ${JSON.stringify(locationAfterReload)}`);
  }
  report.checks.worktreeReloadLocation = true;

  const compactProbe = await sendPrompt(
    'Do not read files and do not use tools. Return the private COMPACT conversation sentinel exactly.',
  );
  const compactText = assistantText(compactProbe.messages);
  assertIncludes(compactText, compactSentinel, 'Worktree compact+reload probe');
  report.checks.worktreeCompactResume = true;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  report.checks.noPrivateWorkspaceAccess = true;

  const finalSessions = cli(['get-all-sessions']).sessions;
  const finalSession = finalSessions.find((session) => session.id === report.uiThreadId);
  const finalCliSessionId = finalSession?.cliResumeId || report.uiThreadId;
  if (finalCliSessionId !== report.cliSessionId) {
    throw new Error(`CLI resume UUID changed: ${report.cliSessionId} -> ${finalCliSessionId}`);
  }
  if (finalSession?.path && report.jsonlPath && finalSession.path !== report.jsonlPath) {
    throw new Error(`JSONL path changed: ${report.jsonlPath} -> ${finalSession.path}`);
  }
  report.checks.identityStable = true;
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
