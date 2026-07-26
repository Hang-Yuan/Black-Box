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
if (!existsSync(providerFile)) {
  throw new Error(`Isolated provider config is missing: ${providerFile}`);
}
assertExternalExecutionRoot(isolationRoot, privateRoots);

const providerData = JSON.parse(readFileSync(providerFile, 'utf8'));
const activeProvider = providerData.providers?.find(
  (provider) => provider.id === providerData.activeProviderId,
);
if (!activeProvider) throw new Error('Isolated provider config has no active provider');
if (activeProvider.credentialState === 'missing') {
  throw new Error(
    'AskUserQuestion smoke requires a credential in the isolated provider profile; configure one without using the production conversation store.',
  );
}

const modelTier = process.env.BLACKBOX_SMOKE_MODEL_TIER || 'haiku';
if (!['haiku', 'sonnet'].includes(modelTier)) {
  throw new Error(`AskUserQuestion smoke only permits Haiku or Sonnet, received ${modelTier}`);
}
const resolvedModel = activeProvider.modelMappings?.find(
  (mapping) => mapping.tier === modelTier,
)?.providerModel;
if (!resolvedModel || /opus|fable/i.test(resolvedModel)) {
  throw new Error(`AskUserQuestion smoke refuses this model mapping: ${resolvedModel || 'missing'}`);
}

const runId = `ask-user-question-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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

async function captureScreenshot(label) {
  const errors = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return { path: cli(['screenshot'], { timeout: 30_000 }).path, error: null };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (attempt < 2) await sleep(500);
    }
  }
  return { path: null, error: `${label}: ${errors.at(-1)}` };
}

async function waitForHarness() {
  // A cold isolated Cargo build can take longer than 90 seconds on macOS.
  // Keep the product timeout independent from the model-turn timeout so a
  // first-run compile is not misreported as a missing WebView harness.
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
  socketPath = `/tmp/blackbox-ask-user-question-${process.pid}.sock`;
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
    if (!/Socket (?:connection ended|closed by BLACKBOX)|socket not found/i.test(message)) {
      throw error;
    }
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

function inspectTranscript(jsonlPath, expectedAnswers) {
  const answerObjects = [];
  const toolResultTexts = [];
  const raw = readFileSync(jsonlPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    walk(parsed, (value) => {
      if (value.answers && typeof value.answers === 'object' && !Array.isArray(value.answers)) {
        answerObjects.push(value.answers);
      }
      if (value.type === 'tool_result') {
        const content = typeof value.content === 'string'
          ? value.content
          : JSON.stringify(value.content ?? '');
        toolResultTexts.push(content);
      }
    });
  }

  const expectedEntries = Object.entries(expectedAnswers);
  const matchingAnswers = answerObjects.filter((answers) => (
    expectedEntries.every(([question, answer]) => answers[question] === answer)
  ));
  return {
    exactQuestionKeysObserved: matchingAnswers.length > 0,
    exactAnswerObjectObserved: matchingAnswers.some(
      (answers) => Object.keys(answers).length === expectedEntries.length,
    ),
    numericQuestionKeysAbsent: answerObjects.every(
      (answers) => !Object.keys(answers).some((key) => /^\d+$/.test(key)),
    ),
    toolResultAnswersObserved: toolResultTexts.some((text) => (
      expectedEntries.every(([question, answer]) => (
        text.includes(question) && text.includes(answer)
      ))
    )),
    unansweredSentinelAbsent: !raw.includes('The user did not answer the questions.'),
  };
}

const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const singleQuestion = `Choose the isolated single-select result ${marker}`;
const singleOptionA = `ALPHA_${marker}`;
const chosenSingle = `BETA_${marker}`;
const multiQuestion = `Choose both isolated multi-select results ${marker}`;
const multiOptionA = `MINT_${marker}`;
const multiOptionB = `AMBER_${marker}`;
const multiOptionC = `LILAC_${marker}`;
const chosenMulti = `${multiOptionA}, ${multiOptionC}`;
const customQuestion = `Enter the isolated custom result ${marker}`;
const customOptionA = `DEFAULT_${marker}`;
const customOptionB = `SKIP_${marker}`;
const customAnswer = `CUSTOM_${marker}`;
const expectedAnswers = {
  [singleQuestion]: chosenSingle,
  [multiQuestion]: chosenMulti,
  [customQuestion]: customAnswer,
};
const expectedReply = [
  'ASK_USER_QUESTION_RESULT',
  chosenSingle,
  multiOptionA,
  multiOptionC,
  customAnswer,
].join('__');

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
  screenshotPending: null,
  screenshotResolved: null,
  screenshotErrors: [],
  launch: null,
  checks: {},
  passed: false,
};

try {
  writeFileSync(join(workspace, 'README.md'), '# Isolated AskUserQuestion smoke\n', 'utf8');
  report.launch = await startApp();
  await createDraft(workspace);
  cli(['switch-model', modelTier]);

  const selectedTier = cli(['get-current-model']).model;
  const selectedProvider = cli(['get-current-provider']).provider;
  const displayedModel = cli([
    'get-visible-text', '--selector', '[data-testid="current-resolved-model"]',
  ]).text.trim();
  if (selectedTier !== modelTier || selectedProvider !== activeProvider.id) {
    throw new Error(`Unexpected model/provider selection: ${selectedTier}/${selectedProvider}`);
  }
  // The selected slot is Haiku/Sonnet, while the header intentionally shows
  // the active provider's concrete model (for example Luna or Terra). Compare
  // against that resolved mapping instead of requiring Claude family words.
  const normalizeModelLabel = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (
    /opus|fable/i.test(displayedModel)
    || normalizeModelLabel(displayedModel) !== normalizeModelLabel(resolvedModel)
  ) {
    throw new Error(
      `AskUserQuestion smoke expected the ${modelTier} slot to resolve as ${resolvedModel}, received ${displayedModel}`,
    );
  }
  report.checks.allowedModelSelected = true;

  const before = cli(['get-messages', '--all', '--full']);
  cli(['type', [
    'This is a mechanical Black Box AskUserQuestion acceptance test.',
    'Call AskUserQuestion exactly once now and do not call any other tool.',
    'That single call must contain exactly three questions in this exact order:',
    `1. Exact question: ${singleQuestion}`,
    '   Header: Single. Set multiSelect to false.',
    `   Use exactly these two option labels: ${singleOptionA} and ${chosenSingle}`,
    `2. Exact question: ${multiQuestion}`,
    '   Header: Multi. Set multiSelect to true.',
    `   Use exactly these three option labels: ${multiOptionA}, ${multiOptionB}, and ${multiOptionC}`,
    `3. Exact question: ${customQuestion}`,
    '   Header: Custom. Set multiSelect to false.',
    `   Use exactly these two option labels: ${customOptionA} and ${customOptionB}`,
    `After the user answers, reply exactly ${expectedReply}`,
  ].join('\n')]);
  cli(['send']);

  cli([
    'wait-for', '--selector', '[data-testid="ask-question-option-0-1"]',
    '--timeout', String(timeoutMs),
  ], { timeout: timeoutMs + 10_000 });
  const pendingScreenshot = await captureScreenshot('pending question card');
  report.screenshotPending = pendingScreenshot.path;
  if (pendingScreenshot.error) report.screenshotErrors.push(pendingScreenshot.error);
  report.checks.questionCardRendered = true;

  const selected = cli(['exec', `(()=>{const option=document.querySelector('[data-testid="ask-question-option-0-1"]');if(!option)return {error:'missing option'};option.click();return {clicked:true,text:option.innerText||option.textContent||''}})()`]).result;
  if (selected?.error || !String(selected?.text || '').includes(chosenSingle)) {
    throw new Error(`Could not select expected option: ${JSON.stringify(selected)}`);
  }
  cli([
    'wait-for', '--selector', '[data-testid="ask-question-confirm"]:not(:disabled)',
    '--timeout', '10000',
  ]);
  const submitted = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="ask-question-confirm"]');if(!button)return {error:'missing confirm'};if(button.disabled)return {error:'confirm disabled'};button.click();return {clicked:true}})()`]).result;
  if (submitted?.error) throw new Error(submitted.error);

  cli([
    'wait-for', '--selector', '[data-testid="ask-question-option-1-0"]',
    '--timeout', '10000',
  ]);
  const selectedMulti = cli(['exec', `(()=>{const first=document.querySelector('[data-testid="ask-question-option-1-0"]');const second=document.querySelector('[data-testid="ask-question-option-1-2"]');if(!first||!second)return {error:'missing multi-select option'};first.click();second.click();return {clicked:true,first:first.innerText||first.textContent||'',second:second.innerText||second.textContent||''}})()`]).result;
  if (
    selectedMulti?.error
    || !String(selectedMulti?.first || '').includes(multiOptionA)
    || !String(selectedMulti?.second || '').includes(multiOptionC)
  ) {
    throw new Error(`Could not select expected multi-select options: ${JSON.stringify(selectedMulti)}`);
  }
  cli([
    'wait-for', '--selector', '[data-testid="ask-question-confirm"]:not(:disabled)',
    '--timeout', '10000',
  ]);
  const submittedMulti = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="ask-question-confirm"]');if(!button)return {error:'missing confirm'};if(button.disabled)return {error:'confirm disabled'};button.click();return {clicked:true}})()`]).result;
  if (submittedMulti?.error) throw new Error(submittedMulti.error);
  report.checks.multiSelectSubmittedThroughCard = true;

  cli([
    'wait-for', '--selector', '[data-testid="ask-question-other-2"]',
    '--timeout', '10000',
  ]);
  const selectedOther = cli(['exec', `(()=>{const option=document.querySelector('[data-testid="ask-question-other-2"]');if(!option)return {error:'missing Other option'};option.click();return {clicked:true}})()`]).result;
  if (selectedOther?.error) throw new Error(selectedOther.error);
  cli([
    'wait-for', '--selector', '[data-testid="ask-question-other-input-2"]',
    '--timeout', '10000',
  ]);
  const enteredCustom = cli(['exec', `(()=>{const input=document.querySelector('[data-testid="ask-question-other-input-2"]');if(!input)return {error:'missing Other input'};const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(!setter)return {error:'missing input setter'};setter.call(input,${JSON.stringify(customAnswer)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return {value:input.value}})()`]).result;
  if (enteredCustom?.error || enteredCustom?.value !== customAnswer) {
    throw new Error(`Could not enter custom answer: ${JSON.stringify(enteredCustom)}`);
  }
  cli([
    'wait-for', '--selector', '[data-testid="ask-question-confirm"]:not(:disabled)',
    '--timeout', '10000',
  ]);
  const submittedCustom = cli(['exec', `(()=>{const button=document.querySelector('[data-testid="ask-question-confirm"]');if(!button)return {error:'missing confirm'};if(button.disabled)return {error:'confirm disabled'};button.click();return {clicked:true}})()`]).result;
  if (submittedCustom?.error) throw new Error(submittedCustom.error);
  report.checks.customAnswerSubmittedThroughCard = true;
  report.checks.threeQuestionFlowCompleted = true;

  cli(['wait-for', '--text', expectedReply, '--timeout', String(timeoutMs)], {
    timeout: timeoutMs + 10_000,
  });
  const settled = cli([
    'wait-until-done', '--timeout', String(timeoutMs),
    '--min-messages', String((before.total || 0) + 2),
  ], { timeout: timeoutMs + 10_000 });
  if (settled.status !== 'completed') {
    throw new Error(`AskUserQuestion turn did not complete: ${JSON.stringify(settled)}`);
  }

  const after = cli(['get-messages', '--all', '--full']);
  const questionMessage = after.messages.find(
    (message) => message.type === 'question' && message.toolName === 'AskUserQuestion',
  );
  const finalReplyObserved = after.messages.some(
    (message) => String(message.content || '').includes(expectedReply),
  );
  report.checks.questionCardResolved = questionMessage?.resolved === true;
  report.checks.threeQuestionsObserved = questionMessage?.questions?.length === 3;
  report.checks.finalReplyObserved = finalReplyObserved;
  const resolvedScreenshot = await captureScreenshot('resolved question card');
  report.screenshotResolved = resolvedScreenshot.path;
  if (resolvedScreenshot.error) report.screenshotErrors.push(resolvedScreenshot.error);

  report.uiThreadId = await waitForRealSession();
  const session = cli(['get-all-sessions']).sessions.find(
    (entry) => entry.id === report.uiThreadId,
  );
  report.cliSessionId = session?.cliResumeId || report.uiThreadId;
  report.jsonlPath = session?.path || null;
  if (!report.jsonlPath || !existsSync(report.jsonlPath)) {
    throw new Error(`AskUserQuestion JSONL is missing: ${report.jsonlPath}`);
  }
  assertNoPrivateToolAccess(report.jsonlPath, privateRoots);
  Object.assign(report.checks, inspectTranscript(report.jsonlPath, expectedAnswers));
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
