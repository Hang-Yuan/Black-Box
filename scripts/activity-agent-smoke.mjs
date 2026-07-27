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
  throw new Error(`Activity smoke only permits Haiku or Sonnet, received ${modelTier}`);
}
const resolvedModel = activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === modelTier,
)?.providerModel;
if (!resolvedModel || /opus|fable/i.test(resolvedModel)) {
  throw new Error(`Activity smoke refuses this model mapping: ${resolvedModel || 'missing'}`);
}

const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shortMarker = marker.replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase();
const agentName = `activity-reader-${shortMarker}`;
const taskSubject = `ACTIVITY_TASK_${marker}`;
const fileMarker = `ACTIVITY_FILE_${marker}`;
const expectedReply = `ACTIVITY_SMOKE_COMPLETE ${fileMarker}`;
const runId = `activity-agent-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });
writeFileSync(join(workspace, 'marker.txt'), `${fileMarker}\n`, 'utf8');

let appProcess = null;
let socketPath = null;

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
  socketPath = `/tmp/blackbox-activity-agent-${process.pid}.sock`;
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

async function waitForActivityRows() {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    try {
      lastText = cli(['get-visible-text', '--selector', '[data-testid="activity-panel"]']).text;
      if (lastText.includes(taskSubject) && lastText.includes(agentName)) {
        return { text: lastText, observedAt: new Date().toISOString() };
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`Activity rows did not appear. Last panel text: ${lastText.slice(0, 2000)}`);
}

function readActivityRowState() {
  return cli(['exec', `(()=>{
    const agent=Array.from(document.querySelectorAll('[data-activity-agent-name]'))
      .find((node)=>node.getAttribute('data-activity-agent-name')===${JSON.stringify(agentName)});
    const task=Array.from(document.querySelectorAll('[data-activity-task-subject]'))
      .find((node)=>node.getAttribute('data-activity-task-subject')===${JSON.stringify(taskSubject)});
    return {
      agentNames:Array.from(document.querySelectorAll('[data-activity-agent-name]'))
        .map((node)=>node.getAttribute('data-activity-agent-name'))
        .filter(Boolean),
      agentPresent:Boolean(agent),
      agentPhase:agent?.getAttribute('data-activity-agent-phase')||null,
      agentText:agent?.textContent||'',
      taskPresent:Boolean(task),
      taskStatus:task?.getAttribute('data-activity-task-status')||null,
      taskText:task?.textContent||'',
    };
  })()`]).result;
}

function inspectTranscript(jsonlPath) {
  const toolUses = [];
  const raw = readFileSync(jsonlPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const blocks = event?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use') toolUses.push({ name: block.name, input: block.input || {} });
    }
  }
  return {
    toolUses,
    agentToolObserved: toolUses.some(
      (tool) => tool.name === 'Agent' && tool.input?.name === agentName,
    ),
    taskCreateObserved: toolUses.some(
      (tool) => tool.name === 'TaskCreate' && tool.input?.subject === taskSubject,
    ),
    taskUpdateObserved: toolUses.some((tool) => tool.name === 'TaskUpdate'),
  };
}

const report = {
  runId,
  workspace,
  reportFile,
  modelTier,
  resolvedModel,
  providerId: activeProvider.id,
  agentName,
  taskSubject,
  uiThreadId: null,
  jsonlPath: null,
  launch: null,
  activityDuringRun: null,
  activityAfterRun: null,
  activityRowsAfterLeadTurn: null,
  assistantReply: null,
  finalReplyObserved: false,
  checks: {},
  passed: false,
};

try {
  report.launch = await startApp();
  await createDraft(workspace);
  cli(['switch-model', modelTier]);
  cli(['type', '/bypass']);
  cli(['send']);

  const displayedModel = cli([
    'get-visible-text', '--selector', '[data-testid="current-resolved-model"]',
  ]).text.trim();
  if (/opus|fable/i.test(displayedModel) || !/haiku|sonnet/i.test(displayedModel)) {
    throw new Error(`Activity smoke requires Haiku or Sonnet: ${displayedModel}`);
  }
  report.checks.allowedModelSelected = true;

  cli(['exec', 'window.confirm=()=>true']);
  cli(['exec', `(()=>{const button=document.querySelector('[data-testid="agent-panel-toggle"]');if(!button)return {error:'missing agent toggle'};button.click();return {clicked:true}})()`]);
  cli(['wait-for', '--selector', '[data-testid="agent-teams-toggle"]', '--timeout', '10000']);
  const teamState = cli(['exec', `(()=>{const toggle=document.querySelector('[data-testid="agent-teams-toggle"]');if(!toggle)return {error:'missing team toggle'};if(toggle.getAttribute('aria-checked')!=='true')toggle.click();return {enabled:toggle.getAttribute('aria-checked')==='true'}})()`]).result;
  if (teamState?.error) throw new Error(teamState.error);
  await sleep(300);
  const enabled = cli(['exec', `document.querySelector('[data-testid="agent-teams-toggle"]')?.getAttribute('aria-checked')`]).result;
  if (enabled !== 'true' && enabled !== true) {
    throw new Error(`Agent Teams did not enable: ${JSON.stringify(enabled)}`);
  }
  report.checks.agentTeamsEnabled = true;
  cli(['exec', `document.querySelector('[data-testid="agent-panel-toggle"]')?.click()`]);

  cli(['exec', `(()=>{const button=document.querySelector('[data-testid="activity-panel-toggle"]');if(!button)return {error:'missing activity toggle'};button.click();return {clicked:true}})()`]);
  cli(['wait-for', '--selector', '[data-testid="activity-panel"]', '--timeout', '10000']);
  report.checks.activityPanelOpened = true;

  const before = cli(['get-messages', '--all', '--full']);
  cli(['type', [
    'This is a mechanical Black Box Activity-panel acceptance test.',
    `Create exactly one TaskCreate item with subject ${taskSubject} and activeForm Running ${taskSubject}.`,
    'Immediately update that task to in_progress.',
    `Spawn exactly one persistent agent-team teammate with the Agent tool and exact name ${agentName}.`,
    'The teammate must use Bash once to sleep 6 seconds, then read marker.txt and return its exact line.',
    'Wait for the teammate, then update the task to completed.',
    `Reply exactly: ${expectedReply}`,
    'Do not edit or write any file. Do not inspect paths outside this isolated directory.',
  ].join('\n')]);
  cli(['send']);

  report.activityDuringRun = await waitForActivityRows();
  report.checks.taskRowRendered = report.activityDuringRun.text.includes(taskSubject);
  report.checks.agentRowRendered = report.activityDuringRun.text.includes(agentName);

  const settled = cli([
    'wait-until-done', '--timeout', String(timeoutMs),
    '--min-messages', String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') {
    throw new Error(`Activity smoke turn did not complete: ${JSON.stringify(settled)}`);
  }
  report.checks.leadTurnSettled = true;

  // Named Agent Team teammates may keep working after the lead model ends its
  // foreground turn. Leave the native process alive long enough to verify the
  // background rows remain queryable instead of disappearing with the turn.
  await sleep(9_000);
  report.activityRowsAfterLeadTurn = readActivityRowState();
  report.checks.backgroundRowsPersistedAfterLeadTurn = Boolean(
    report.activityRowsAfterLeadTurn?.agentPresent
      && report.activityRowsAfterLeadTurn?.taskPresent,
  );
  report.checks.backgroundAgentStateVisible = Boolean(
    report.activityRowsAfterLeadTurn?.agentPhase,
  );
  report.checks.foreignAgentRowsAbsent = report.activityRowsAfterLeadTurn?.agentNames
    ?.filter((name) => name.startsWith('activity-reader-'))
    .every((name) => name === agentName) === true;
  report.checks.backgroundTaskStateVisible = ['in_progress', 'completed'].includes(
    report.activityRowsAfterLeadTurn?.taskStatus,
  );

  const assistantMessages = cli(['get-messages', '--all', '--full']).messages.filter(
    (message) => message.role === 'assistant' && message.type === 'text',
  );
  report.assistantReply = assistantMessages.at(-1)?.content || null;
  report.finalReplyObserved = assistantMessages.some(
    (message) => String(message.content || '').trim() === expectedReply,
  );

  report.activityAfterRun = cli([
    'get-visible-text', '--selector', '[data-testid="activity-panel"]',
  ]).text;
  report.checks.rowsRemainInActivityAuthority = Boolean(
    report.activityRowsAfterLeadTurn?.agentPresent
      && report.activityRowsAfterLeadTurn?.taskPresent,
  );

  report.uiThreadId = await waitForRealSession();
  const session = cli(['get-all-sessions']).sessions.find(
    (entry) => entry.id === report.uiThreadId,
  );
  report.jsonlPath = session?.path || null;
  if (!report.jsonlPath || !existsSync(report.jsonlPath)) {
    throw new Error(`Activity smoke JSONL is missing: ${report.jsonlPath}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  report.checks.noPrivateWorkspaceAccess = true;
  const transcript = inspectTranscript(report.jsonlPath);
  report.toolUses = transcript.toolUses.map((tool) => ({ name: tool.name, input: tool.input }));
  report.checks.agentToolObserved = transcript.agentToolObserved;
  report.checks.taskCreateObserved = transcript.taskCreateObserved;
  report.checks.taskUpdateObserved = transcript.taskUpdateObserved;
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
