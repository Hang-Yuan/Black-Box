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
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 240_000);
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
  throw new Error(`Permission profile smoke only permits Haiku or Sonnet, received ${modelTier}`);
}
const resolvedModel = activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === modelTier,
)?.providerModel;
if (!resolvedModel || /opus|fable/i.test(resolvedModel)) {
  throw new Error(`Permission profile smoke refuses this model mapping: ${resolvedModel || 'missing'}`);
}
const sessionMode = process.env.BLACKBOX_SMOKE_SESSION_MODE || 'ask';
if (!['ask', 'code'].includes(sessionMode)) {
  throw new Error(`Permission profile smoke only permits Manual or Code mode, received ${sessionMode}`);
}

const runId = `permission-profile-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });

let appProcess = null;
let socketPath = null;

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
  const lines = stdout.trim().split('\n').filter(Boolean);
  const payload = JSON.parse(lines.at(-1) || '{}');
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
  socketPath = `/tmp/blackbox-permission-profile-${process.pid}.sock`;
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

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else walk(child, visit);
  }
}

function inspectTranscript(jsonlPath, shellCommand) {
  const raw = readFileSync(jsonlPath, 'utf8');
  const matchingBashCalls = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    walk(parsed, (value) => {
      if (value.type === 'tool_use' && value.name === 'Bash' && value.input?.command === shellCommand) {
        matchingBashCalls.push(value.id || null);
      }
    });
  }
  return {
    exactBashCallCount: matchingBashCalls.length,
    exactTwoSequentialBashCalls: matchingBashCalls.length === 2,
  };
}

function permissionMessages() {
  return cli(['get-messages', '--all', '--full']).messages.filter(
    (message) => message.type === 'permission',
  );
}

async function waitForTwoOutputLines(outputFile, marker) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const permissions = permissionMessages();
    if (permissions.length > 1) {
      throw new Error(`A second permission prompt appeared: ${JSON.stringify(permissions)}`);
    }
    if (existsSync(outputFile)) {
      const lines = readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length === 2 && lines.every((line) => line === marker)) return lines;
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for the session-scoped second Bash call');
}

const marker = `PERMISSION_SCOPE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const outputFile = join(workspace, 'permission-scope.txt');
const shellCommand = `printf '%s\\n' '${marker}' >> permission-scope.txt`;
const expectedReply = `PERMISSION_PROFILE_RESULT__${marker}`;
const report = {
  runId,
  workspace,
  reportFile,
  modelTier,
  resolvedModel,
  sessionMode,
  providerId: activeProvider.id,
  uiThreadId: null,
  cliSessionId: null,
  jsonlPath: null,
  launch: null,
  permissionSuggestion: null,
  newTaskPermissionSuggestion: null,
  sessionScopeText: null,
  screenshotPending: null,
  checks: {},
  passed: false,
};

try {
  writeFileSync(join(workspace, 'README.md'), '# Isolated permission profile smoke\n', 'utf8');
  report.launch = await startApp();
  await createDraft(workspace);
  cli(['switch-model', modelTier]);
  cli(['switch-mode', sessionMode]);

  const selectedTier = cli(['get-current-model']).model;
  const selectedMode = cli(['get-current-mode']).mode;
  const selectedProvider = cli(['get-current-provider']).provider;
  const displayedModel = cli([
    'get-visible-text', '--selector', '[data-testid="current-resolved-model"]',
  ]).text.trim();
  if (selectedTier !== modelTier || selectedMode !== sessionMode || selectedProvider !== activeProvider.id) {
    throw new Error(`Unexpected model/mode/provider: ${selectedTier}/${selectedMode}/${selectedProvider}`);
  }
  if (/opus|fable/i.test(displayedModel) || !/haiku|sonnet/i.test(displayedModel)) {
    throw new Error(`Permission profile smoke requires Haiku or Sonnet: ${displayedModel}`);
  }
  report.checks.allowedModelAndModeSelected = true;

  const before = cli(['get-messages', '--all', '--full']);
  cli(['type', [
    'This is a mechanical Black Box permission-profile acceptance test.',
    `Use the Bash tool to run this exact command twice: ${shellCommand}`,
    'Run the first Bash call by itself. Wait for its tool result before issuing the second Bash call.',
    'The second Bash tool input must contain the exact same command string.',
    'Do not call any other tool and do not combine the two calls.',
    `After both tool results, reply exactly ${expectedReply}`,
  ].join('\n')]);
  cli(['send']);

  cli([
    'wait-for', '--selector', '[data-testid="permission-card"]',
    '--timeout', String(timeoutMs),
  ], { timeout: timeoutMs + 10_000 });
  report.checks.permissionCardRendered = true;
  const pendingPermissions = permissionMessages();
  if (pendingPermissions.length !== 1) {
    throw new Error(`Expected one permission card, received ${pendingPermissions.length}`);
  }
  const firstPermission = pendingPermissions[0];
  const suggestions = firstPermission.permissionData?.permissionSuggestions;
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    throw new Error(`CLI did not provide permission suggestions: ${JSON.stringify(firstPermission)}`);
  }
  const downscopableSet = suggestions.every((update) => (
    ['userSettings', 'projectSettings', 'localSettings', 'session'].includes(update?.destination)
    && (update.type === 'addRules' || update.type === 'addDirectories')
    && (update.type !== 'addRules' || update.behavior === 'allow')
  ));
  if (!downscopableSet) {
    throw new Error(`CLI suggestions cannot be downscoped safely: ${JSON.stringify(suggestions)}`);
  }
  report.permissionSuggestion = suggestions;
  report.checks.cliSuggestedOnlyDownscopableUpdates = true;
  const sessionButton = cli(['exec', `(()=>({present:!!document.querySelector('[data-testid="permission-allow-session-button"]')}))()`]).result;
  if (!sessionButton?.present) {
    throw new Error(`Safe CLI suggestions did not render a session action: ${JSON.stringify(suggestions)}`);
  }
  report.checks.sessionScopedActionRendered = true;
  report.sessionScopeText = cli([
    'get-visible-text', '--selector', '[data-testid="permission-session-scope"]',
  ]).text.trim();
  report.checks.scopeExplainedWithoutPersistentSettings = (
    report.sessionScopeText.includes('当前会话')
    && report.sessionScopeText.includes('不写入用户或项目设置')
  );
  try {
    report.screenshotPending = cli(['screenshot'], { timeout: 30_000 }).path;
  } catch (error) {
    report.screenshotError = error instanceof Error ? error.message : String(error);
  }

  const clicked = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="permission-allow-session-button"]');if(!button)return {error:'missing session permission button'};button.click();return {clicked:true,text:button.innerText||button.textContent||''}})()`]).result;
  if (clicked?.error || !clicked?.clicked) throw new Error(`Could not approve session scope: ${JSON.stringify(clicked)}`);
  report.checks.sessionScopedActionClicked = true;

  const lines = await waitForTwoOutputLines(outputFile, marker);
  report.checks.secondMatchingCallDidNotPrompt = permissionMessages().length === 1;
  report.checks.outputContainsExactlyTwoLines = lines.length === 2;

  cli(['wait-for', '--text', expectedReply, '--timeout', String(timeoutMs)], {
    timeout: timeoutMs + 10_000,
  });
  const settled = cli([
    'wait-until-done', '--timeout', String(timeoutMs),
    '--min-messages', String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') {
    throw new Error(`Permission profile turn did not complete: ${JSON.stringify(settled)}`);
  }

  const after = cli(['get-messages', '--all', '--full']);
  const finalPermissions = after.messages.filter((message) => message.type === 'permission');
  report.checks.onlyOnePermissionCardObserved = finalPermissions.length === 1;
  report.checks.permissionCardResolved = finalPermissions[0]?.resolved === true
    || finalPermissions[0]?.interactionState === 'resolved';
  report.checks.finalReplyObserved = after.messages.some(
    (message) => String(message.content || '').includes(expectedReply),
  );

  report.uiThreadId = await waitForRealSession();
  const session = cli(['get-all-sessions']).sessions.find((entry) => entry.id === report.uiThreadId);
  report.cliSessionId = session?.cliResumeId || report.uiThreadId;
  report.jsonlPath = session?.path || null;
  if (!report.jsonlPath || !existsSync(report.jsonlPath)) {
    throw new Error(`Permission profile JSONL is missing: ${report.jsonlPath}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  const transcript = inspectTranscript(report.jsonlPath, shellCommand);
  report.transcript = transcript;
  report.checks.exactTwoSequentialBashCalls = transcript.exactTwoSequentialBashCalls;
  report.checks.noPrivateWorkspaceAccess = true;

  // A new task receives a new stdin process and must not inherit the first
  // task's in-memory grant, even when the exact Bash rule is repeated.
  const secondWorkspace = join(resolve(isolationRoot), `${runId}-new-task`);
  mkdirSync(secondWorkspace, { recursive: true });
  writeFileSync(join(secondWorkspace, 'README.md'), '# New task permission expiry probe\n', 'utf8');
  await createDraft(secondWorkspace);
  cli(['type', [
    'This is the second half of a mechanical Black Box permission-profile acceptance test.',
    `Use Bash exactly once with this exact command: ${shellCommand}`,
    'Do not call any other tool.',
  ].join('\n')]);
  cli(['send']);
  cli([
    'wait-for', '--selector', '[data-testid="permission-card"]',
    '--timeout', String(timeoutMs),
  ], { timeout: timeoutMs + 10_000 });
  const newTaskPermissions = permissionMessages();
  const pendingNewTaskPermission = newTaskPermissions.find(
    (message) => message.interactionState === 'pending' || !message.resolved,
  );
  report.newTaskPermissionSuggestion = pendingNewTaskPermission?.permissionData?.permissionSuggestions ?? null;
  report.checks.newTaskPromptsAgain = newTaskPermissions.length === 1 && Boolean(pendingNewTaskPermission);
  const secondThreadId = await waitForRealSession();
  const secondSession = cli(['get-all-sessions']).sessions.find((entry) => entry.id === secondThreadId);
  const secondJsonlPath = secondSession?.path || null;
  if (!secondJsonlPath || !existsSync(secondJsonlPath)) {
    throw new Error(`New task permission JSONL is missing: ${secondJsonlPath}`);
  }
  assertNoPrivateToolAccess(secondJsonlPath, privateRoots);
  report.checks.newTaskNoPrivateWorkspaceAccess = true;
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
