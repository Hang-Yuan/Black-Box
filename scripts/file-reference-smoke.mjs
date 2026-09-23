#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExternalExecutionRoot, configuredPrivateRoots } from './isolation-guard.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isolation = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || process.env.BLACKBOX_AUTOMATION_HOME;
assert(isolation && reportHome, 'Run through scripts/run-isolated.sh');

const runId = `file-reference-${Date.now()}`;
const workspace = join(resolve(isolation), runId);
const messageCwd = join(workspace, 'Dev/enterprise-brain-v1/streams/09-meta-agent');
const target = join(messageCwd, 'skill-layout.md');
const staleTarget = join(messageCwd, 'skill-layout-stale.md');
const projectRoot = join(workspace, 'Dev/enterprise-brain-v1');
const nestedRunCwd = join(projectRoot, 'runs/20260920-c-repair');
const projectBareTarget = join(projectRoot, 'streams/02-org/write-guard-contract.json');
const existingRunDirectory = join(projectRoot, 'runs/20260920-e2e');
const missingResult = join(projectRoot, 'runs/20260920-gates/RESULT.md');
const reportDir = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(reportDir, 'report.json');
assertExternalExecutionRoot(workspace, configuredPrivateRoots(repo));
mkdirSync(messageCwd, { recursive: true });
mkdirSync(reportDir, { recursive: true });
writeFileSync(target, '# Skill layout\n\nHistorical file-reference acceptance fixture.\n', 'utf8');
writeFileSync(staleTarget, '# Stale cwd recovery\n\nContextual directory citation recovered this file.\n', 'utf8');
mkdirSync(dirname(projectBareTarget), { recursive: true });
mkdirSync(existingRunDirectory, { recursive: true });
mkdirSync(dirname(missingResult), { recursive: true });
writeFileSync(projectBareTarget, '{"production_acceptance":false}\n', 'utf8');

const socket = `/tmp/blackbox-file-reference-${process.pid}.sock`;
const env = { ...process.env, BLACKBOX_SOCKET: socket };
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 180_000);
let app = null;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: { ...env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeout || timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '').trim());
  return result.stdout || '';
}

function cli(args, options = {}) {
  const output = run(process.execPath, [join(repo, 'scripts/blackbox-cli.mjs'), ...args], options);
  const payload = JSON.parse(output.trim().split('\n').filter(Boolean).at(-1) || '{}');
  if (!payload.ok) throw new Error(payload.error || `CLI failed: ${args.join(' ')}`);
  return payload;
}

const js = (code) => cli(['exec', code]).result;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(check, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw lastError || new Error('Timed out');
}

async function start() {
  const logPath = join(reportDir, 'app.log');
  const log = openSync(logPath, 'a');
  app = spawn('pnpm', ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
    cwd: repo,
    env,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  await until(() => app.exitCode === null ? cli(['status'], { timeout: 5_000 }) : null);
  return logPath;
}

async function stop() {
  if (!app || app.exitCode != null) return;
  try { js('window.__blackbox_test.quitApp()'); } catch {}
  await Promise.race([
    new Promise((done) => app.once('exit', done)),
    sleep(10_000).then(() => { try { app.kill('SIGTERM'); } catch {} }),
  ]);
}

const report = {
  version: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version,
  workspace,
  messageCwd,
  target,
  checks: {},
  measurements: {},
  passed: false,
};

try {
  report.log = await start();
  cli(['new-session', '--cwd', workspace]);
  const sessionId = js('window.__blackbox_test.scenarioStores.sessions.getState().selectedSessionId');
  js(`(() => {
    const {chat, settings, files} = window.__blackbox_test.scenarioStores;
    settings.getState().setWorkingDirectory(${JSON.stringify(workspace)});
    files.getState().clearSelection();
    chat.getState().addMessage(${JSON.stringify(sessionId)}, {
      id: 'historical-file-reference', role: 'assistant', type: 'text',
      content: ${JSON.stringify('入口是 `README.md`，文件清单见 `skill-layout.md`。')},
      timestamp: Date.now(), cwd: ${JSON.stringify(messageCwd)}, isFinalResponse: true,
    });
    return true;
  })()`);

  const chip = await until(() => js(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.includes('skill-layout.md'));
    return button ? { title: button.title, text: button.textContent.trim() } : null;
  })()`));
  report.measurements.chip = chip;
  assert.equal(chip.title, target, 'The rendered citation must bind the message cwd');

  js(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.includes('skill-layout.md'));
    button.click();
    return true;
  })()`);
  const firstOpen = await until(() => js(`(() => {
    const {settings, files} = window.__blackbox_test.scenarioStores;
    const state = files.getState();
    return state.selectedFile === ${JSON.stringify(target)} && !state.isLoadingContent
      ? { selectedFile: state.selectedFile, fileContent: state.fileContent,
          panelOpen: settings.getState().secondaryPanelOpen,
          panelTab: settings.getState().secondaryPanelTab }
      : null;
  })()`));
  report.measurements.firstOpen = firstOpen;
  assert.equal(firstOpen.panelTab, 'files');
  assert.match(firstOpen.fileContent || '', /Historical file-reference acceptance fixture/);
  const firstPreview = await until(() => js(`(() => {
    const preview = document.querySelector('[data-testid="file-preview"]');
    const rect = preview?.getBoundingClientRect();
    return preview ? { text: preview.textContent.trim().slice(0, 100), width: rect.width, height: rect.height } : null;
  })()`));
  report.measurements.firstPreview = firstPreview;
  assert(firstPreview.width > 0, 'The native file preview must be visibly mounted');
  report.checks.historicalBareNameOpensExactMessageCwdFile = true;

  // The recurrent production case: the preview is remembered while the user
  // closes the right panel, then clicks the same citation again.
  js(`window.__blackbox_test.scenarioStores.files.getState().closePreview()`);
  await until(() => js(`(() => {
    const {settings, files} = window.__blackbox_test.scenarioStores;
    return files.getState().selectedFile === null && settings.getState().secondaryPanelOpen;
  })()`));
  js(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.includes('skill-layout.md'));
    button.click();
    return true;
  })()`);
  const reopened = await until(() => js(`(() => {
    const {settings, files} = window.__blackbox_test.scenarioStores;
    const state = files.getState();
    return state.selectedFile === ${JSON.stringify(target)} && !state.isLoadingContent
      ? { selectedFile: state.selectedFile, panelOpen: settings.getState().secondaryPanelOpen, contentReady: true }
      : null;
  })()`));
  report.measurements.reopened = reopened;
  report.checks.closedPanelReopensSameSelectedFile = reopened.contentReady;
  assert.equal(reopened.contentReady, true);

  // Reproduce the production failure: a cached message carries only the broad
  // workspace cwd, while the same response names its real output directory.
  // Force the legacy whole-workspace fallback to truncate so the DOM click can
  // succeed only through the prepared directory citation.
  js(`window.__blackbox_test.scenarioStores.files.getState().closePreview()`);
  await until(() => js(`window.__blackbox_test.scenarioStores.files.getState().selectedFile === null`));
  js(`import('/src/lib/tauri-bridge.ts').then(({bridge}) => {
    window.__fileReferenceSearchOriginal = bridge.searchFileTree;
    bridge.searchFileTree = async () => ({ matches: [], truncated: true, skipped_directories: 0 });
    window.__fileReferenceSearchPatched = true;
  })`);
  await until(() => js('window.__fileReferenceSearchPatched === true'));
  js(`(() => {
    const {chat} = window.__blackbox_test.scenarioStores;
    chat.getState().addMessage(${JSON.stringify(sessionId)}, {
      id: 'stale-cwd-file-reference', role: 'assistant', type: 'text',
      content: ${JSON.stringify('落盘位置 `Dev/enterprise-brain-v1/streams/09-meta-agent/`，文件清单见 `skill-layout-stale.md`。')},
      timestamp: Date.now(), cwd: ${JSON.stringify(workspace)}, isFinalResponse: true,
    });
    return true;
  })()`);
  await until(() => js(`[...document.querySelectorAll('button')].some((entry) => entry.textContent?.includes('skill-layout-stale.md'))`));
  js(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.includes('skill-layout-stale.md'));
    button.click();
    return true;
  })()`);
  const staleRecovered = await until(() => js(`(() => {
    const state = window.__blackbox_test.scenarioStores.files.getState();
    return state.selectedFile === ${JSON.stringify(staleTarget)} && !state.isLoadingContent
      ? { selectedFile: state.selectedFile, fileContent: state.fileContent }
      : null;
  })()`));
  assert.match(staleRecovered.fileContent || '', /Contextual directory citation recovered this file/);
  report.measurements.staleRecovered = staleRecovered;
  report.checks.staleCachedCwdUsesPreparedDirectoryCitation = true;
  js(`import('/src/lib/tauri-bridge.ts').then(({bridge}) => {
    bridge.searchFileTree = window.__fileReferenceSearchOriginal;
  })`);

  // Production regression from a real Claude turn: the message cwd is a
  // nested run directory, while a bare filename lives elsewhere in the same
  // project and project-root-relative run paths are emitted in the same text.
  // The broad workspace search is forced to truncate; a successful click
  // therefore proves that the resolver walked up to the nearest project root.
  js(`window.__blackbox_test.scenarioStores.files.getState().closePreview()`);
  await until(() => js(`window.__blackbox_test.scenarioStores.files.getState().selectedFile === null`));
  js(`import('/src/lib/tauri-bridge.ts').then(({bridge}) => {
    const original = bridge.searchFileTree;
    window.__fileReferenceProjectSearchRoots = [];
    bridge.searchFileTree = async (...args) => {
      window.__fileReferenceProjectSearchRoots.push(args[0]);
      if (args[0] === ${JSON.stringify(workspace)}) {
        return { matches: [], truncated: true, skipped_directories: 1 };
      }
      return original(...args);
    };
    window.__fileReferenceProjectSearchOriginal = original;
    window.__fileReferenceProjectSearchPatched = true;
  })`);
  await until(() => js('window.__fileReferenceProjectSearchPatched === true'));
  js(`(() => {
    const {chat} = window.__blackbox_test.scenarioStores;
    chat.getState().addMessage(${JSON.stringify(sessionId)}, {
      id: 'nested-run-project-references', role: 'assistant', type: 'text',
      content: ${JSON.stringify('契约见 `write-guard-contract.json`；运行目录 `runs/20260920-e2e/`；待生成结果 `runs/20260920-gates/RESULT.md`。')},
      timestamp: Date.now(), cwd: ${JSON.stringify(nestedRunCwd)}, isFinalResponse: true,
    });
    return true;
  })()`);
  await until(() => js(`[...document.querySelectorAll('button')].some((entry) => entry.textContent?.includes('write-guard-contract.json'))`));
  js(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.includes('write-guard-contract.json'));
    button.click();
    return true;
  })()`);
  const projectRecovered = await until(() => js(`(() => {
    const state = window.__blackbox_test.scenarioStores.files.getState();
    return state.selectedFile === ${JSON.stringify(projectBareTarget)} && !state.isLoadingContent
      ? { selectedFile: state.selectedFile, fileContent: state.fileContent,
          roots: window.__fileReferenceProjectSearchRoots }
      : null;
  })()`));
  assert.match(projectRecovered.fileContent || '', /production_acceptance/);
  assert(projectRecovered.roots.includes(projectRoot), 'Resolver must search the nearest project root');
  report.measurements.projectRecovered = projectRecovered;
  report.checks.nestedRunCwdRecoversBareProjectFile = true;

  js(`window.__blackbox_test.scenarioStores.files.getState().closePreview()`);
  await until(() => js(`window.__blackbox_test.scenarioStores.files.getState().selectedFile === null`));
  js(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.includes('runs/20260920-e2e/'));
    button.click();
    return true;
  })()`);
  const directoryRevealed = await until(() => js(`(() => {
    const state = window.__blackbox_test.scenarioStores.files.getState();
    return state.revealTarget === ${JSON.stringify(existingRunDirectory)}
      ? { revealTarget: state.revealTarget, selectedFile: state.selectedFile }
      : null;
  })()`));
  report.measurements.directoryRevealed = directoryRevealed;
  report.checks.projectRelativeDirectoryRevealsFromNestedCwd = true;

  js(`(() => {
    document.querySelectorAll('[data-toast]').forEach((entry) => entry.remove());
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.includes('runs/20260920-gates/RESULT.md'));
    button.click();
    return true;
  })()`);
  const missingStayedMissing = await until(() => js(`(() => {
    const text = document.body.textContent || '';
    const state = window.__blackbox_test.scenarioStores.files.getState();
    return text.includes('RESULT.md') && text.includes('找不到文件')
      ? { selectedFile: state.selectedFile, revealTarget: state.revealTarget }
      : null;
  })()`));
  assert.notEqual(missingStayedMissing.selectedFile, missingResult);
  report.measurements.missingStayedMissing = missingStayedMissing;
  report.checks.missingProjectFileDoesNotOpenUnrelatedBasename = true;
  js(`import('/src/lib/tauri-bridge.ts').then(({bridge}) => {
    bridge.searchFileTree = window.__fileReferenceProjectSearchOriginal;
  })`);

  report.passed = Object.values(report.checks).every(Boolean);
} finally {
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await stop();
}

if (!report.passed) process.exitCode = 1;
console.log(JSON.stringify({ reportFile, passed: report.passed, checks: report.checks }));
