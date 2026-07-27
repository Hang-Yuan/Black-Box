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
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 360_000);
const appStartTimeoutMs = Number(process.env.BLACKBOX_APP_START_TIMEOUT_MS || 300_000);
const isolatedHome = resolve(process.env.HOME || '');
const providerFile = join(isolatedHome, '.blackbox', 'providers.json');
const workflowLedgerFile = join(isolatedHome, '.blackbox', 'workflow-runs.json');

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
  throw new Error(`Workflow smoke only permits Haiku or Sonnet, received ${modelTier}`);
}
const resolvedModel = activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === modelTier,
)?.providerModel;
if (!resolvedModel || /opus|fable/i.test(resolvedModel)) {
  throw new Error(`Workflow smoke refuses this model mapping: ${resolvedModel || 'missing'}`);
}

const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shortMarker = marker.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase();
const workflowName = `workflow-lifecycle-${shortMarker}`;
const workflowArg = `WORKFLOW_ARG_${marker}`;
const markerLine = `WORKFLOW_MARKER_${marker}`;
const expectedReply = `WORKFLOW_LIFECYCLE_OK ${markerLine}`;
const phaseNames = ['Inspect marker', 'Confirm receipt'];
const runId = `workflow-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const workflowDirectory = join(workspace, '.claude', 'workflows');
const workflowFile = join(workflowDirectory, `${workflowName}.js`);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
mkdirSync(workflowDirectory, { recursive: true });
mkdirSync(runRoot, { recursive: true });
writeFileSync(join(workspace, 'marker.txt'), `${markerLine}\n`, 'utf8');

const workflowMeta = {
  name: workflowName,
  title: 'Black Box Workflow lifecycle smoke',
  description: 'Verify native Workflow launch, visible phase progress, and durable reload state',
  whenToUse: 'Isolated Black Box development verification only',
  phases: [
    { title: phaseNames[0], detail: 'Read the isolated marker after a short delay', model: modelTier },
    { title: phaseNames[1], detail: 'Return the deterministic workflow receipt', model: modelTier },
  ],
};
const phasePrompts = [
  [
    'Use Bash exactly once and use no other tool.',
    'Run this exact command from the current workflow workspace: sleep 4; cat marker.txt',
    'Return exactly the single line printed by that command.',
    'Do not inspect any other path.',
  ].join(' '),
  [
    `The previous phase output must equal ${markerLine}.`,
    `Return exactly: ${expectedReply}`,
    'Use no tools.',
  ].join(' '),
];
const manifest = JSON.stringify({ version: 1, prompts: phasePrompts });
const workflowSource = `export const meta = ${JSON.stringify(workflowMeta, null, 2)};

// blackbox-workflow-manifest: ${manifest}

const workflowInput = typeof args === "string" ? args : JSON.stringify(args ?? null);
let previousOutput = "";

phase(${JSON.stringify(phaseNames[0])});
previousOutput = await agent(
  [
    "Original workflow input:",
    workflowInput,
    "Current phase instructions:",
    ${JSON.stringify(phasePrompts[0])},
  ].filter(Boolean).join("\\n\\n"),
  { phase: ${JSON.stringify(phaseNames[0])}, label: "1 · ${phaseNames[0]}", model: ${JSON.stringify(modelTier)} },
);

phase(${JSON.stringify(phaseNames[1])});
previousOutput = await agent(
  [
    "Original workflow input:",
    workflowInput,
    "Previous phase output:",
    previousOutput,
    "Current phase instructions:",
    ${JSON.stringify(phasePrompts[1])},
  ].filter(Boolean).join("\\n\\n"),
  { phase: ${JSON.stringify(phaseNames[1])}, label: "2 · ${phaseNames[1]}", model: ${JSON.stringify(modelTier)} },
);

return previousOutput;
`;
writeFileSync(workflowFile, workflowSource, 'utf8');

let appProcess = null;
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
  socketPath = `/tmp/blackbox-workflow-lifecycle-${process.pid}-${launchIndex}.sock`;
  const logFile = join(runRoot, `app-${launchIndex}-${label}.log`);
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

async function waitForEditor() {
  const deadline = Date.now() + 30_000;
  let last = null;
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

async function waitForSessionRecord(threadId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = cli(['get-all-sessions']).sessions.find((item) => item.id === threadId) || null;
    if (last?.path) return last;
    await sleep(250);
  }
  throw new Error(`Session record did not expose its JSONL path: ${JSON.stringify(last)}`);
}

function getWorkflowRuns(tabId) {
  const call = tabId
    ? `window.__blackbox_test.getWorkflowRuns(${JSON.stringify(tabId)})`
    : 'window.__blackbox_test.getWorkflowRuns()';
  const result = cli(['exec', call]).result;
  return Array.isArray(result) ? result : [];
}

function readActivityWorkflowState() {
  return cli(['exec', `(()=>{
    const row=Array.from(document.querySelectorAll('[data-activity-workflow-name]'))
      .find((node)=>node.getAttribute('data-activity-workflow-name')===${JSON.stringify(workflowName)});
    if(!row)return {present:false};
    return {
      present:true,
      status:row.getAttribute('data-activity-workflow-status'),
      text:row.textContent||'',
      phases:Array.from(row.querySelectorAll('[data-activity-workflow-phase]')).map((node)=>({
        title:node.getAttribute('data-activity-workflow-phase'),
        state:node.getAttribute('data-activity-workflow-phase-state'),
        text:node.textContent||'',
      })),
    };
  })()`]).result;
}

async function waitForWorkflowOption() {
  const deadline = Date.now() + 30_000;
  let last = [];
  while (Date.now() < deadline) {
    const payload = cli(['exec', `(()=>{
      const select=document.querySelector('[data-testid="workflow-select"]');
      if(!select)return [];
      return Array.from(select.options).map((option)=>({value:option.value,disabled:option.disabled,text:option.textContent||''}));
    })()`]).result;
    last = Array.isArray(payload) ? payload : [];
    if (last.some((option) => option.value === workflowName && !option.disabled)) return last;
    await sleep(200);
  }
  throw new Error(`Workflow option did not become available: ${JSON.stringify(last)}`);
}

async function waitForActivityProgress() {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readActivityWorkflowState();
    const visiblePhases = last?.phases?.filter((phase) => phaseNames.includes(phase.title)) || [];
    if (last?.present
      && ['launching', 'running'].includes(last.status)
      && visiblePhases.length === phaseNames.length
      && visiblePhases.filter((phase) => phase.state === 'running').length === 1
      && visiblePhases.some((phase) => phase.state === 'pending')) {
      return { ...last, observedAt: new Date().toISOString() };
    }
    await sleep(150);
  }
  throw new Error(`Visible Workflow progress did not appear: ${JSON.stringify(last)}`);
}

async function waitForSecondPhaseProgress() {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readActivityWorkflowState();
    const first = last?.phases?.find((phase) => phase.title === phaseNames[0]);
    const second = last?.phases?.find((phase) => phase.title === phaseNames[1]);
    if (last?.present
      && last.status === 'running'
      && first?.state === 'completed'
      && second?.state === 'running') {
      return { ...last, observedAt: new Date().toISOString() };
    }
    await sleep(150);
  }
  throw new Error(`Visible Workflow phase transition did not appear: ${JSON.stringify(last)}`);
}

async function waitForWorkflowRun(predicate, tabId, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const runs = getWorkflowRuns(tabId);
    last = runs.find((run) => run.workflowName === workflowName) || null;
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`Workflow run did not reach expected state: ${JSON.stringify(last)}`);
}

async function waitForPersistedWorkflow(localId, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    if (existsSync(workflowLedgerFile)) {
      try {
        const ledger = JSON.parse(readFileSync(workflowLedgerFile, 'utf8'));
        last = Object.values(ledger).flat().find((run) => run?.localId === localId) || null;
        if (last && predicate(last)) return last;
      } catch {}
    }
    await sleep(100);
  }
  throw new Error(`Workflow ledger did not persist expected run: ${JSON.stringify(last)}`);
}

function inspectTranscript(jsonlPath) {
  const toolUses = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool_use' && typeof value.name === 'string') {
      const key = value.id || `${value.name}:${JSON.stringify(value.input || {})}`;
      toolUses.set(key, { id: value.id || null, name: value.name, input: value.input || {} });
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line)); } catch {}
  }
  const workflowToolUses = Array.from(toolUses.values()).filter(
    (tool) => ['Workflow', 'RunWorkflow'].includes(tool.name),
  );
  return { toolUses: Array.from(toolUses.values()), workflowToolUses };
}

const report = {
  runId,
  workspace,
  workflowFile,
  workflowLedgerFile,
  reportFile,
  marker,
  workflowName,
  workflowArg,
  expectedReply,
  phaseNames,
  modelTier,
  resolvedModel,
  providerId: activeProvider.id,
  uiThreadId: null,
  jsonlPath: null,
  launches: [],
  activityDuringRun: null,
  activityDuringSecondPhase: null,
  activityAfterRun: null,
  activityAfterRelaunch: null,
  completedRun: null,
  persistedRun: null,
  reloadedRun: null,
  workflowToolUses: [],
  checks: {},
  passed: false,
};

try {
  report.launches.push(await startApp('initial'));
  await createDraft(workspace);
  cli(['switch-model', modelTier]);
  cli(['type', '/bypass']);
  cli(['send']);

  const displayedModel = cli([
    'get-visible-text', '--selector', '[data-testid="current-resolved-model"]',
  ]).text.trim();
  if (/opus|fable/i.test(displayedModel) || !/haiku|sonnet/i.test(displayedModel)) {
    throw new Error(`Workflow smoke requires Haiku or Sonnet: ${displayedModel}`);
  }
  report.displayedModel = displayedModel;
  report.checks.allowedModelSelected = true;

  cli(['exec', `(()=>{const button=document.querySelector('[data-testid="activity-panel-toggle"]');if(!button)return {error:'missing activity toggle'};button.click();return {clicked:true}})()`]);
  cli(['wait-for', '--selector', '[data-testid="activity-panel"]', '--timeout', '10000']);
  report.checks.activityPanelOpened = true;

  cli(['exec', `document.querySelector('[data-testid="workflow-button"]')?.click()`]);
  cli(['wait-for', '--selector', '[data-testid="workflow-popover"]', '--timeout', '10000']);
  await waitForWorkflowOption();
  report.checks.workflowCatalogFoundFixture = true;

  const prepared = cli(['exec', `(()=>{
    const select=document.querySelector('[data-testid="workflow-select"]');
    const textarea=document.querySelector('[data-testid="workflow-args"]');
    const button=document.querySelector('[data-testid="workflow-run"]');
    if(!select||!textarea||!button)return {error:'workflow controls missing'};
    const selectSetter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')?.set;
    const textareaSetter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
    selectSetter?.call(select,${JSON.stringify(workflowName)});
    select.dispatchEvent(new Event('change',{bubbles:true}));
    textareaSetter?.call(textarea,${JSON.stringify(workflowArg)});
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
    return {selected:select.value,args:textarea.value,disabled:button.disabled};
  })()`]).result;
  if (prepared?.error || prepared?.selected !== workflowName || prepared?.args !== workflowArg) {
    throw new Error(`Workflow controls were not prepared: ${JSON.stringify(prepared)}`);
  }
  await sleep(100);
  const runButtonState = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="workflow-run"]');return {disabled:Boolean(button?.disabled)}})()`]).result;
  if (runButtonState?.disabled) throw new Error('Workflow run button remained disabled');

  const before = cli(['get-messages', '--all', '--full']);
  cli(['exec', `document.querySelector('[data-testid="workflow-run"]')?.click()`]);
  report.uiThreadId = await waitForRealSession();
  report.activityDuringRun = await waitForActivityProgress();
  report.checks.visibleRunningPhase = true;
  report.checks.singleActivePhaseAtLaunch = report.activityDuringRun.phases.filter(
    (phase) => phase.state === 'running',
  ).length === 1 && report.activityDuringRun.phases.some(
    (phase) => phase.state === 'pending',
  );
  report.activityDuringSecondPhase = await waitForSecondPhaseProgress();
  report.checks.livePhaseTransitionObserved = true;

  report.completedRun = await waitForWorkflowRun(
    (run) => run.status === 'completed'
      && phaseNames.every((name) => run.phases?.some((phase) => phase.title === name)),
    report.uiThreadId,
  );
  report.activityAfterRun = readActivityWorkflowState();
  report.checks.workflowCompleted = report.completedRun.status === 'completed';
  report.checks.allPhasesRecorded = phaseNames.every(
    (name) => report.completedRun.phases.some((phase) => phase.title === name),
  );
  report.checks.allPhasesSettled = report.completedRun.phases.every(
    (phase) => phase.state === 'completed',
  );
  report.checks.visibleCompletedState = Boolean(
    report.activityAfterRun?.present
      && report.activityAfterRun.status === 'completed'
      && phaseNames.every((name) => report.activityAfterRun.phases?.some(
        (phase) => phase.title === name && phase.state === 'completed',
      )),
  );

  const settled = cli([
    'wait-until-done', '--timeout', String(timeoutMs),
    '--min-messages', String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') {
    throw new Error(`Workflow launcher turn did not settle: ${JSON.stringify(settled)}`);
  }
  report.checks.launcherTurnSettled = true;

  const session = await waitForSessionRecord(report.uiThreadId);
  report.jsonlPath = session.path;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  report.checks.noPrivateWorkspaceAccess = true;
  const transcript = inspectTranscript(report.jsonlPath);
  report.workflowToolUses = transcript.workflowToolUses;
  report.checks.exactNativeWorkflowToolUse = transcript.workflowToolUses.length === 1
    && transcript.workflowToolUses[0].input?.name === workflowName
    && transcript.workflowToolUses[0].input?.args === workflowArg;

  report.persistedRun = await waitForPersistedWorkflow(
    report.completedRun.localId,
    (run) => run.status === 'completed'
      && phaseNames.every((name) => run.phases?.some((phase) => phase.title === name)),
  );
  report.checks.completedLedgerPersisted = true;

  requestNativeClose();
  const firstCloseCode = await waitForAppExit();
  appProcess = null;
  socketPath = null;
  if (firstCloseCode !== 0) throw new Error(`Initial native close exited with code ${firstCloseCode}`);
  report.checks.initialNativeCloseClean = true;

  report.launches.push(await startApp('relaunch'));
  await waitForSelectedSession(report.uiThreadId);
  await waitForEditor();
  report.reloadedRun = await waitForWorkflowRun(
    (run) => run.localId === report.completedRun.localId
      && run.status === 'completed'
      && phaseNames.every((name) => run.phases?.some((phase) => phase.title === name)),
    report.uiThreadId,
    30_000,
  );
  report.checks.reloadRestoredCompletedRun = true;

  if (!cli(['exec', `Boolean(document.querySelector('[data-testid="activity-panel"]'))`]).result) {
    cli(['exec', `document.querySelector('[data-testid="activity-panel-toggle"]')?.click()`]);
    cli(['wait-for', '--selector', '[data-testid="activity-panel"]', '--timeout', '10000']);
  }
  report.activityAfterRelaunch = readActivityWorkflowState();
  report.checks.reloadRestoredVisiblePhases = Boolean(
    report.activityAfterRelaunch?.present
      && report.activityAfterRelaunch.status === 'completed'
      && phaseNames.every((name) => report.activityAfterRelaunch.phases?.some(
        (phase) => phase.title === name && phase.state === 'completed',
      )),
  );
  const relaunchedSession = await waitForSessionRecord(report.uiThreadId);
  report.checks.sessionIdentityStable = relaunchedSession.path === report.jsonlPath;
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);

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
