#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExternalExecutionRoot,
  configuredPrivateRoots,
} from './isolation-guard.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoots = configuredPrivateRoots(projectRoot);
const cliPath = join(projectRoot, 'scripts', 'blackbox-cli.mjs');
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const reportHome = process.env.BLACKBOX_SMOKE_REPORT_HOME || process.env.BLACKBOX_AUTOMATION_HOME;
const isolatedHome = process.env.HOME;
const credentialStoreFile = process.env.BLACKBOX_DEV_CREDENTIAL_STORE_FILE;
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 90_000);
const appStartTimeoutMs = Number(process.env.BLACKBOX_APP_START_TIMEOUT_MS || 180_000);

if (!isolationRoot || !reportHome || !isolatedHome || !credentialStoreFile) {
  throw new Error('Run provider persistence smoke through scripts/run-isolated.sh');
}
assertExternalExecutionRoot(isolationRoot, privateRoots);

const runId = `provider-persistence-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
const providersFile = join(resolve(isolatedHome), '.blackbox', 'providers.json');
const providerId = 'provider-persistence-relay';
const historicalPresetId = 'provider-persistence-qwen-historical';
const customizedPresetId = 'provider-persistence-minimax-customized';
const credentialRef = `provider-api-key:${providerId}`;
const marker = `NEW_PROVIDER_ROUTE_${Date.now()}`;
const oldKey = `bbx-smoke-old-${Date.now()}-key`;
const newKey = `bbx-smoke-new-${Date.now()}-key`;
const oldModel = 'smoke-old-haiku-model';
const newModel = 'smoke-new-haiku-model';
const originalProviders = existsSync(providersFile) ? readFileSync(providersFile) : null;
const originalCredentials = existsSync(credentialStoreFile) ? readFileSync(credentialStoreFile) : null;

mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });
writeFileSync(join(workspace, 'README.md'), '# Isolated provider persistence smoke\n', 'utf8');

let appProcess = null;
let socketPath = null;
let oldUpstream = null;
let newUpstream = null;

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

function inspect(expression) {
  return cli(['exec', expression]).result;
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

async function waitForProviderLoad() {
  const deadline = Date.now() + 30_000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = inspect('window.__blackbox_test.getProviderState()');
    if (lastState?.loaded && lastState?.providers?.some((provider) => provider.id === providerId)) {
      return lastState;
    }
    await sleep(250);
  }
  throw new Error(`Provider store did not load fixture: ${JSON.stringify(lastState)}`);
}

async function waitForTurn(minMessages) {
  const startedAt = Date.now();
  await sleep(300);
  while (Date.now() - startedAt < timeoutMs) {
    const status = cli(['status'], { timeout: 5_000 });
    if (status.pendingPermission) {
      throw new Error(`Provider turn requested an unexpected permission: ${JSON.stringify(status)}`);
    }
    if (!status.active && status.messageCount >= minMessages) {
      return { status: 'completed', elapsed: Date.now() - startedAt, ...status };
    }
    // Keep this wait in the smoke process itself. A long synchronous CLI wait
    // would starve the fake upstream server that shares this Node event loop.
    await sleep(250);
  }
  const status = cli(['status'], { timeout: 5_000 });
  throw new Error(`Provider turn timed out: ${JSON.stringify(status)}`);
}

async function startApp() {
  socketPath = `/tmp/blackbox-provider-persistence-${process.pid}.sock`;
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

async function closeApp() {
  if (!appProcess || appProcess.exitCode != null) return;
  try { cli(['exec', 'window.__blackbox_test.closeWindow()']); } catch {}
  try {
    await waitForAppExit();
  } catch {
    try { appProcess.kill('SIGTERM'); } catch {}
    await waitForAppExit(10_000).catch(() => {});
  }
  appProcess = null;
  socketPath = null;
}

async function startUpstream(label, responseMarker) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(bodyText); } catch {}
      requests.push({
        path: request.url || '',
        authorization: request.headers.authorization || '',
        model: body?.model || null,
        stream: body?.stream === true,
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.end([
        `data: ${JSON.stringify({
          id: `chatcmpl-${label}`,
          model: body?.model || newModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: responseMarker }, finish_reason: null }],
        })}`,
        `data: ${JSON.stringify({
          id: `chatcmpl-${label}`,
          model: body?.model || newModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}`,
        `data: ${JSON.stringify({
          id: `chatcmpl-${label}`,
          model: body?.model || newModel,
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        })}`,
        'data: [DONE]',
        '',
      ].join('\n\n'));
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`Cannot resolve ${label} upstream address`);
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function closeUpstream(upstream) {
  if (!upstream?.server) return;
  await new Promise((resolvePromise) => upstream.server.close(() => resolvePromise()));
}

function writeRuntimeFixtures(oldBaseUrl) {
  const now = Date.now();
  const providers = {
    version: 2,
    activeProviderId: providerId,
    providers: [
      {
        id: providerId,
        name: 'Provider persistence smoke relay',
        baseUrl: oldBaseUrl,
        apiFormat: 'openai',
        credentialRef,
        credentialHint: `•••• ${oldKey.slice(-4)}`,
        credentialState: 'keychain',
        revision: 1,
        modelMappings: [
          { tier: 'fable', providerModel: 'smoke-old-fable-model' },
          { tier: 'opus', providerModel: 'smoke-old-opus-model' },
          { tier: 'sonnet', providerModel: 'smoke-old-sonnet-model' },
          { tier: 'haiku', providerModel: oldModel },
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: historicalPresetId,
        name: 'Historical Qwen preset',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiFormat: 'anthropic',
        preset: 'qwen',
        revision: 1,
        modelMappings: [
          { tier: 'opus', providerModel: 'qwen3-max' },
          { tier: 'sonnet', providerModel: 'qwen3.5-plus' },
          { tier: 'haiku', providerModel: 'qwen3.5-flash' },
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: customizedPresetId,
        name: 'Customized MiniMax preset',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        apiFormat: 'anthropic',
        authScheme: 'bearer',
        preset: 'minimax',
        revision: 1,
        modelMappings: [
          { tier: 'fable', providerModel: 'MiniMax-M2.7' },
          { tier: 'opus', providerModel: 'user-custom-minimax-route' },
          { tier: 'sonnet', providerModel: 'MiniMax-M2.5' },
          { tier: 'haiku', providerModel: 'MiniMax-M2.1' },
        ],
        extraEnv: {
          API_TIMEOUT_MS: '3000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  writeFileSync(providersFile, `${JSON.stringify(providers, null, 2)}\n`, 'utf8');
  writeFileSync(credentialStoreFile, `${JSON.stringify({
    version: 1,
    secrets: { [credentialRef]: oldKey },
  }, null, 2)}\n`, 'utf8');
  chmodSync(credentialStoreFile, 0o600);
}

function restoreRuntimeFixtures() {
  if (originalProviders) writeFileSync(providersFile, originalProviders);
  else writeFileSync(providersFile, '{\n  "version": 2,\n  "activeProviderId": null,\n  "providers": []\n}\n', 'utf8');
  if (originalCredentials) writeFileSync(credentialStoreFile, originalCredentials);
  else writeFileSync(credentialStoreFile, '{\n  "version": 1,\n  "secrets": {}\n}\n', 'utf8');
  chmodSync(credentialStoreFile, 0o600);
}

function assistantText(messages) {
  return messages
    .filter((message) => message?.role === 'assistant' || message?.type === 'assistant')
    .map((message) => String(message.content || ''))
    .join('\n');
}

const report = {
  runId,
  workspace,
  reportFile,
  providerId,
  selectedTier: 'haiku',
  oldModel,
  newModel,
  launch: null,
  updateProbe: null,
  persisted: null,
  requests: null,
  checks: {},
  passed: false,
};

try {
  oldUpstream = await startUpstream('old', 'OLD_PROVIDER_ROUTE');
  newUpstream = await startUpstream('new', marker);
  writeRuntimeFixtures(oldUpstream.baseUrl);

  report.launch = await startApp();
  const loaded = await waitForProviderLoad();
  report.checks.fixtureLoadedWithOldRoute = loaded.activeProviderId === providerId
    && loaded.providers.find((provider) => provider.id === providerId)?.baseUrl === oldUpstream.baseUrl;
  const migratedHistoricalPreset = loaded.providers.find((provider) => provider.id === historicalPresetId);
  const preservedCustomizedPreset = loaded.providers.find((provider) => provider.id === customizedPresetId);
  report.checks.historicalPresetMigratedOnLoad = migratedHistoricalPreset?.baseUrl
      === 'https://coding.dashscope.aliyuncs.com/apps/anthropic'
    && migratedHistoricalPreset?.authScheme === 'bearer'
    && migratedHistoricalPreset?.modelMappings?.find((mapping) => mapping.tier === 'fable')?.providerModel
      === 'qwen3.7-plus'
    && migratedHistoricalPreset?.modelMappings?.find((mapping) => mapping.tier === 'haiku')?.providerModel
      === 'qwen3.5-plus';
  report.checks.customizedPresetPreservedOnLoad = preservedCustomizedPreset?.baseUrl
      === 'https://api.minimaxi.com/anthropic'
    && preservedCustomizedPreset?.authScheme === 'bearer'
    && preservedCustomizedPreset?.modelMappings?.find((mapping) => mapping.tier === 'opus')?.providerModel
      === 'user-custom-minimax-route'
    && preservedCustomizedPreset?.extraEnv?.API_TIMEOUT_MS === '3000000';

  cli(['new-session', '--cwd', workspace]);
  cli(['switch-model', 'haiku']);
  const patch = {
    baseUrl: newUpstream.baseUrl,
    apiFormat: 'openai',
    apiKey: newKey,
    modelMappings: [
      { tier: 'fable', providerModel: 'smoke-new-fable-model' },
      { tier: 'opus', providerModel: 'smoke-new-opus-model' },
      { tier: 'sonnet', providerModel: 'smoke-new-sonnet-model' },
      { tier: 'haiku', providerModel: newModel },
    ],
  };
  report.updateProbe = inspect(
    `window.__blackbox_test.updateProvider(${JSON.stringify(providerId)}, ${JSON.stringify(patch)})`,
  );
  report.checks.devProbeAcceptedDirtyCredential = report.updateProbe?.providerId === providerId
    && report.updateProbe?.dirtyCredentialSupplied === true;

  const before = cli(['get-messages', '--all', '--full']);
  cli(['type', 'Reply with the provider route marker supplied by the upstream.']);
  cli(['send']);
  await waitForTurn((before.total || 0) + 2);
  const after = cli(['get-messages', '--all', '--full']);
  report.checks.newRouteVisibleInAssistantReply = assistantText(after.messages || []).includes(marker);

  const persistedFile = JSON.parse(readFileSync(providersFile, 'utf8'));
  const credentialFile = JSON.parse(readFileSync(credentialStoreFile, 'utf8'));
  const persistedProvider = persistedFile.providers.find((provider) => provider.id === providerId);
  const persistedHistoricalPreset = persistedFile.providers.find(
    (provider) => provider.id === historicalPresetId,
  );
  const persistedCustomizedPreset = persistedFile.providers.find(
    (provider) => provider.id === customizedPresetId,
  );
  report.persisted = {
    version: persistedFile.version,
    activeProviderId: persistedFile.activeProviderId,
    baseUrl: persistedProvider?.baseUrl || null,
    revision: persistedProvider?.revision || 0,
    credentialRef: persistedProvider?.credentialRef || null,
    credentialHint: persistedProvider?.credentialHint || null,
    apiKeyFieldPresent: Object.prototype.hasOwnProperty.call(persistedProvider || {}, 'apiKey'),
    haikuModel: persistedProvider?.modelMappings?.find((mapping) => mapping.tier === 'haiku')?.providerModel || null,
  };
  report.persistedPresetMigration = {
    historicalBaseUrl: persistedHistoricalPreset?.baseUrl || null,
    historicalAuthScheme: persistedHistoricalPreset?.authScheme || null,
    historicalModels: persistedHistoricalPreset?.modelMappings || [],
    customizedAuthScheme: persistedCustomizedPreset?.authScheme || null,
    customizedModels: persistedCustomizedPreset?.modelMappings || [],
    customizedExtraEnv: persistedCustomizedPreset?.extraEnv || {},
  };
  report.requests = {
    oldCount: oldUpstream.requests.length,
    newCount: newUpstream.requests.length,
    newPaths: newUpstream.requests.map((request) => request.path),
    newModels: newUpstream.requests.map((request) => request.model),
    allNewRequestsAuthorized: newUpstream.requests.length > 0
      && newUpstream.requests.every((request) => request.authorization === `Bearer ${newKey}`),
  };

  report.checks.oldRouteNeverCalled = oldUpstream.requests.length === 0;
  report.checks.newRouteCalled = newUpstream.requests.length > 0;
  report.checks.newKeyReachedGatewayOnly = report.requests.allNewRequestsAuthorized;
  report.checks.newHaikuMappingReachedUpstream = newUpstream.requests.every(
    (request) => request.model === newModel,
  );
  report.checks.persistedMetadataIsCurrent = persistedProvider?.baseUrl === newUpstream.baseUrl
    && persistedProvider?.revision > 1
    && persistedFile.activeProviderId === providerId
    && persistedProvider?.modelMappings?.some(
      (mapping) => mapping.tier === 'haiku' && mapping.providerModel === newModel,
    );
  report.checks.providersJsonContainsNoPlaintextKey = !Object.prototype.hasOwnProperty.call(
    persistedProvider || {},
    'apiKey',
  );
  report.checks.isolatedCredentialStoreHasNewKey = credentialFile.secrets?.[credentialRef] === newKey;
  report.checks.historicalPresetMigrationPersisted = persistedHistoricalPreset?.baseUrl
      === 'https://coding.dashscope.aliyuncs.com/apps/anthropic'
    && persistedHistoricalPreset?.authScheme === 'bearer'
    && persistedHistoricalPreset?.modelMappings?.find((mapping) => mapping.tier === 'haiku')?.providerModel
      === 'qwen3.5-plus';
  report.checks.customizedPresetPreservationPersisted = persistedCustomizedPreset?.authScheme === 'bearer'
    && persistedCustomizedPreset?.modelMappings?.find((mapping) => mapping.tier === 'opus')?.providerModel
      === 'user-custom-minimax-route'
    && persistedCustomizedPreset?.extraEnv?.API_TIMEOUT_MS === '3000000';
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await closeApp();
  await Promise.allSettled([closeUpstream(oldUpstream), closeUpstream(newUpstream)]);
  restoreRuntimeFixtures();
  report.fixturesRestored = true;
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
