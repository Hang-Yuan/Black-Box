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
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 300_000);
const tickTimeoutMs = Number(process.env.BLACKBOX_LOOP_TICK_TIMEOUT_MS || 240_000);
const appStartTimeoutMs = Number(process.env.BLACKBOX_APP_START_TIMEOUT_MS || 300_000);
const providerFile = join(resolve(process.env.HOME || ''), '.blackbox', 'providers.json');

for (const [value, label] of [
  [isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT'],
  [automationHome, 'BLACKBOX_AUTOMATION_HOME'],
  [reportHome, 'BLACKBOX_SMOKE_REPORT_HOME'],
]) {
  if (!value) throw new Error(`${label} is required; run through scripts/run-isolated.sh`);
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
  throw new Error(`Loop smoke only permits Haiku or Sonnet, received ${modelTier}`);
}
const resolvedModel = activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === modelTier,
)?.providerModel;
if (!resolvedModel || /opus|fable/i.test(resolvedModel)) {
  throw new Error(`Loop smoke refuses this model mapping: ${resolvedModel || 'missing'}`);
}

const runId = `loop-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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

async function startApp(label) {
  launchIndex += 1;
  socketPath = `/tmp/blackbox-loop-lifecycle-${process.pid}-${launchIndex}.sock`;
  const logFile = join(runRoot, `app-${launchIndex}-${label}.log`);
  const logFd = openSync(logFile, 'a');
  appProcess = spawn('pnpm', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
    cwd: projectRoot,
    env: { ...process.env, BLACKBOX_SOCKET: socketPath },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  await waitForHarness();
  const launch = { pid: appProcess.pid, socketPath, logFile };
  report.launches.push(launch);
  return launch;
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
    if (!/Socket (?:connection ended|closed by BLACKBOX)|socket not found/i.test(message)) {
      throw error;
    }
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

async function ensureActivityPanelOpen() {
  const present = cli(['exec', `Boolean(document.querySelector('[data-testid="activity-panel"]'))`]).result;
  if (!present) {
    cli(['exec', `document.querySelector('[data-testid="activity-panel-toggle"]')?.click()`]);
    cli(['wait-for', '--selector', '[data-testid="activity-panel"]', '--timeout', '10000']);
  }
}

function readLoopState() {
  return cli(['exec', `(()=>{
    const button=document.querySelector('[data-testid="loop-button"]');
    const row=document.querySelector('[data-activity-loop-id]');
    return {
      buttonPresent:Boolean(button),
      count:Number(button?.getAttribute('data-loop-job-count')||0),
      live:button?.getAttribute('data-loop-live')==='true',
      activityPresent:Boolean(row),
      activityId:row?.getAttribute('data-activity-loop-id')||null,
      activityState:row?.getAttribute('data-activity-loop-state')||null,
      activityText:row?.textContent||'',
    };
  })()`]).result;
}

async function waitForLoopState(predicate, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = readLoopState();
    if (predicate(last)) return { ...last, observedAt: new Date().toISOString() };
    await sleep(200);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

function allMessages() {
  return cli(['get-messages', '--all', '--full']);
}

async function waitForCompletedTool(toolName, minimumMatches = 1, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let matches = [];
  while (Date.now() < deadline) {
    matches = allMessages().messages.filter(
      (message) => message.type === 'tool_use'
        && message.toolName === toolName
        && message.toolCompleted === true,
    );
    if (matches.length >= minimumMatches) return matches;
    await sleep(250);
  }
  throw new Error(`${toolName} did not complete: ${JSON.stringify(matches)}`);
}

async function waitForAssistantTextCount(text, minimumCount, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let messages = [];
  while (Date.now() < deadline) {
    messages = allMessages().messages;
    const matches = messages.filter(
      (message) => message.role === 'assistant' && String(message.content || '').includes(text),
    );
    if (matches.length >= minimumCount) return messages;
    await sleep(500);
  }
  throw new Error(`Assistant text did not appear ${minimumCount} times: ${text}`);
}

async function waitUntilDone(minMessages, timeout = timeoutMs) {
  const settled = cli([
    'wait-until-done', '--timeout', String(timeout), '--min-messages', String(minMessages),
  ], { timeout: timeout + 10_000 });
  if (settled.status !== 'completed') {
    throw new Error(`Turn did not complete: ${JSON.stringify(settled)}`);
  }
  return settled;
}

async function openLoopPopover() {
  const open = cli(['exec', `Boolean(document.querySelector('[data-testid="loop-start"]'))`]).result;
  if (!open) {
    cli(['exec', `document.querySelector('[data-testid="loop-button"]')?.click()`]);
    cli(['wait-for', '--selector', '[data-testid="loop-start"]', '--timeout', '10000']);
  }
}

function toolText(message) {
  return String(message.toolResultContent || message.toolResult || message.content || '');
}

const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const expectedTick = `LOOP_TICK_OK_${marker}`;
const loopPrompt = `For each scheduled iteration, return the single line ${expectedTick}.`;

const report = {
  runId,
  workspace,
  reportFile,
  marker,
  expectedTick,
  modelTier,
  resolvedModel,
  providerId: activeProvider.id,
  displayedModel: null,
  uiThreadId: null,
  jsonlPath: null,
  jobId: null,
  launches: [],
  stateBeforeClose: null,
  stateAfterRelaunch: null,
  stateAfterResume: null,
  stateAfterCancel: null,
  stateAfterFinalRelaunch: null,
  toolUses: [],
  checks: {},
  passed: false,
};

try {
  writeFileSync(join(workspace, 'README.md'), '# Isolated native Loop lifecycle smoke\n', 'utf8');
  await startApp('initial');
  await createDraft(workspace);
  cli(['switch-model', modelTier]);

  const selectedTier = cli(['get-current-model']).model;
  const selectedProvider = cli(['get-current-provider']).provider;
  report.displayedModel = cli([
    'get-visible-text', '--selector', '[data-testid="current-resolved-model"]',
  ]).text.trim();
  if (selectedTier !== modelTier || selectedProvider !== activeProvider.id) {
    throw new Error(`Unexpected model/provider selection: ${selectedTier}/${selectedProvider}`);
  }
  if (/opus|fable/i.test(report.displayedModel) || !/haiku|sonnet/i.test(report.displayedModel)) {
    throw new Error(`Loop smoke requires Haiku or Sonnet: ${report.displayedModel}`);
  }
  report.checks.allowedModelSelected = true;

  await ensureActivityPanelOpen();
  report.checks.activityPanelOpened = true;
  await openLoopPopover();
  const prepared = cli(['exec', `(()=>{
    const interval=document.querySelector('[data-testid="loop-interval"]');
    const prompt=document.querySelector('[data-testid="loop-prompt"]');
    const button=document.querySelector('[data-testid="loop-start"]');
    if(!interval||!prompt||!button)return {error:'loop controls missing'};
    const inputSetter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    const textareaSetter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
    inputSetter?.call(interval,'1m');
    interval.dispatchEvent(new Event('input',{bubbles:true}));
    textareaSetter?.call(prompt,${JSON.stringify(loopPrompt)});
    prompt.dispatchEvent(new Event('input',{bubbles:true}));
    return {interval:interval.value,prompt:prompt.value,disabled:button.disabled};
  })()`]).result;
  if (prepared?.error || prepared.interval !== '1m' || prepared.prompt !== loopPrompt) {
    throw new Error(`Loop controls were not prepared: ${JSON.stringify(prepared)}`);
  }
  await sleep(100);
  const beforeCreate = allMessages().total || 0;
  const startResult = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="loop-start"]');if(!button)return {error:'missing start'};if(button.disabled)return {error:'start disabled'};button.click();return {clicked:true}})()`]).result;
  if (startResult?.error) throw new Error(startResult.error);

  const createTools = await waitForCompletedTool('CronCreate');
  await waitUntilDone(beforeCreate + 2);
  await waitForAssistantTextCount(expectedTick, 1);
  report.uiThreadId = await waitForRealSession();
  const createTool = createTools.at(-1);
  const createText = toolText(createTool);
  report.jobId = createText.match(/Scheduled(?: recurring)? job\s+([A-Za-z0-9_-]+)/i)?.[1] || null;
  if (!report.jobId) throw new Error(`CronCreate receipt did not expose a job ID: ${createText}`);
  report.checks.nativeCreateReceipt = createTool.toolInput?.recurring === true;
  report.checks.immediateIterationObserved = true;

  report.stateBeforeClose = await waitForLoopState(
    (state) => state.count === 1
      && state.live
      && state.activityId === report.jobId
      && state.activityState === 'active',
    'Loop did not become visibly active before close',
  );
  report.checks.liveBeforeClose = true;
  report.checks.initialNativeCloseClean = await closeAppGracefully();

  await startApp('resume');
  await waitForSelectedSession(report.uiThreadId);
  await ensureActivityPanelOpen();
  report.stateAfterRelaunch = await waitForLoopState(
    (state) => state.count === 1
      && !state.live
      && state.activityId === report.jobId
      && state.activityState === 'resume-pending',
    'Loop receipt did not restore as resume-pending',
  );
  report.checks.resumePendingVisible = true;

  await openLoopPopover();
  const beforeVerify = allMessages().total || 0;
  const verifyResult = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="loop-verify"]');if(!button)return {error:'missing verify'};if(button.disabled)return {error:'verify disabled'};button.click();return {clicked:true}})()`]).result;
  if (verifyResult?.error) throw new Error(verifyResult.error);
  const listTools = await waitForCompletedTool('CronList');
  await waitUntilDone(beforeVerify + 2);
  const listText = toolText(listTools.at(-1));
  report.checks.restoredViaCronList = listText.includes(report.jobId);
  report.stateAfterResume = await waitForLoopState(
    (state) => state.count === 1
      && state.live
      && state.activityId === report.jobId
      && state.activityState === 'active',
    'Restored Loop did not become visibly active',
  );
  report.checks.liveAfterResume = true;

  const tickMessages = await waitForAssistantTextCount(expectedTick, 2, tickTimeoutMs);
  report.checks.scheduledTickObserved = tickMessages.filter(
    (message) => message.role === 'assistant' && String(message.content || '').includes(expectedTick),
  ).length >= 2;

  await openLoopPopover();
  const beforeDelete = allMessages().total || 0;
  const cancelResult = cli(['exec', `(()=>{
    const button=Array.from(document.querySelectorAll('[data-loop-cancel-id]'))
      .find((node)=>node.getAttribute('data-loop-cancel-id')===${JSON.stringify(report.jobId)});
    if(!button)return {error:'missing cancel'};
    if(button.disabled)return {error:'cancel disabled'};
    button.click();
    return {clicked:true};
  })()`]).result;
  if (cancelResult?.error) throw new Error(cancelResult.error);
  const deleteTools = await waitForCompletedTool('CronDelete');
  await waitUntilDone(beforeDelete + 2);
  const deleteTool = deleteTools.at(-1);
  report.checks.nativeDeleteReceipt = deleteTool.toolInput?.id === report.jobId
    && /(cancelled|deleted|not found)/i.test(toolText(deleteTool));
  report.stateAfterCancel = await waitForLoopState(
    (state) => state.count === 0 && !state.activityPresent,
    'Cancelled Loop remained visible',
  );
  report.checks.activityClearedAfterCancel = true;

  const session = cli(['get-all-sessions']).sessions.find((entry) => entry.id === report.uiThreadId);
  report.jsonlPath = session?.path || null;
  if (!report.jsonlPath || !existsSync(report.jsonlPath)) {
    throw new Error(`Loop JSONL is missing: ${report.jsonlPath}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  report.checks.noPrivateWorkspaceAccess = true;
  report.toolUses = allMessages().messages
    .filter((message) => message.type === 'tool_use' && /^Cron(?:Create|List|Delete)$/.test(message.toolName || ''))
    .map((message) => ({
      name: message.toolName,
      input: message.toolInput,
      completed: message.toolCompleted,
      result: toolText(message),
    }));

  report.checks.secondNativeCloseClean = await closeAppGracefully();
  await startApp('final-reload');
  await waitForSelectedSession(report.uiThreadId);
  await ensureActivityPanelOpen();
  report.stateAfterFinalRelaunch = await waitForLoopState(
    (state) => state.count === 0 && !state.live && !state.activityPresent,
    'Cancelled Loop reappeared after relaunch',
  );
  report.checks.cancelPersistedAfterRelaunch = true;
  report.checks.sessionIdentityStable = cli(['get-active-session']).session === report.uiThreadId;
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
