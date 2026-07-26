#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
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
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 120_000);

if (!isolationRoot || !reportHome) {
  throw new Error('Run extension navigation smoke through scripts/run-isolated.sh');
}
assertExternalExecutionRoot(isolationRoot, privateRoots);

const runId = `extension-navigation-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), runId);
const runRoot = join(resolve(reportHome), 'smoke-runs', runId);
const reportFile = join(runRoot, 'report.json');
const agentName = `extension-smoke-agent-${Date.now()}`;
const hookCommand = `printf extension-hook-${Date.now()}`;
mkdirSync(join(workspace, '.claude', 'agents'), { recursive: true });
mkdirSync(runRoot, { recursive: true });
writeFileSync(join(workspace, 'README.md'), '# Extension navigation smoke\n', 'utf8');
writeFileSync(
  join(workspace, '.claude', 'agents', `${agentName}.md`),
  `---\nname: ${agentName}\ndescription: Isolated extension center agent fixture\ntools: Read, Grep\nmodel: haiku\nisolation: worktree\n---\n\nInspect only the isolated smoke workspace.\n`,
  'utf8',
);
writeFileSync(
  join(workspace, '.claude', 'settings.json'),
  `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Read',
        hooks: [{ type: 'command', command: hookCommand }],
      }],
    },
  }, null, 2)}\n`,
  'utf8',
);

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
  const deadline = Date.now() + 90_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try { return cli(['status'], { timeout: 5_000 }); } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500);
    }
  }
  throw new Error(`Black Box page harness did not become ready: ${lastError}`);
}

async function startApp() {
  socketPath = `/tmp/blackbox-extension-navigation-${process.pid}.sock`;
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

function click(selector) {
  const result = cli(['exec', `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return {error:'missing ${selector}'};element.click();return {clicked:true}})()`]).result;
  if (result?.error) throw new Error(result.error);
}

function inspect(expression) {
  return cli(['exec', expression]).result;
}

const report = {
  runId,
  workspace,
  reportFile,
  agentName,
  hookCommand,
  launch: null,
  visualEvidence: {
    authority: 'external-window-audit-required',
    reason: 'The debug screenshot command can resolve another Tauri window named main when multiple desktop apps are open. DOM checks remain authoritative; native pixels must be inspected through the OS window.',
  },
  checks: {},
  passed: false,
};

try {
  report.launch = await startApp();
  cli(['new-session', '--cwd', workspace]);
  cli(['wait-for', '--selector', '[data-testid="model-selector"]', '--timeout', '30000']);

  const headerGeometry = inspect(`(()=>{
    const selectors=[
      '[data-testid="current-resolved-model"]',
      '[data-testid="agent-panel-toggle"]',
      '[data-testid="provider-quick-selector"]',
      '[data-testid="workflow-button"]',
      '[data-testid="loop-button"]',
      '[data-testid="goal-button"]',
      '[data-testid="activity-panel-toggle"]',
    ];
    const rects=selectors.map((selector)=>{
      const element=document.querySelector(selector);
      if(!element)return {selector,missing:true};
      const rect=element.getBoundingClientRect();
      return {selector,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};
    });
    const fits=(rect)=>!rect.missing&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight&&rect.width>0&&rect.height>0;
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
      rects,
      allFit:rects.every(fits),
      ordered:rects.every((rect,index)=>index===0||rect.missing||rects[index-1].missing||rect.left>=rects[index-1].left),
    };
  })()`);
  report.domGeometry = { header: headerGeometry };
  report.checks.headerControlsFitWithoutDocumentOverflow = headerGeometry.allFit
    && headerGeometry.ordered
    && headerGeometry.document.width === headerGeometry.viewport.width
    && headerGeometry.document.height === headerGeometry.viewport.height;

  click('[data-testid="model-selector"]');
  cli(['wait-for', '--selector', '[data-testid="model-menu"]', '--timeout', '10000']);
  click('[data-testid="provider-quick-selector"]');
  cli(['wait-for', '--selector', '[data-testid="provider-quick-menu"]', '--timeout', '10000']);
  const providerWon = inspect(`(()=>({model:!!document.querySelector('[data-testid="model-menu"]'),provider:!!document.querySelector('[data-testid="provider-quick-menu"]')}))()`);
  click('[data-testid="model-selector"]');
  cli(['wait-for', '--selector', '[data-testid="model-menu"]', '--timeout', '10000']);
  const modelWon = inspect(`(()=>({model:!!document.querySelector('[data-testid="model-menu"]'),provider:!!document.querySelector('[data-testid="provider-quick-menu"]'),expanded:document.querySelector('[data-testid="model-selector"]')?.getAttribute('aria-expanded')}))()`);
  report.checks.modelAndProviderMenusAreMutuallyExclusive = !providerWon.model
    && providerWon.provider
    && modelWon.model
    && !modelWon.provider
    && modelWon.expanded === 'true';
  inspect(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);

  const popoverContracts = [];
  for (const [buttonSelector, explainerSelector, popupSelector] of [
    ['[data-testid="workflow-manage"]', '[data-testid="workflow-explainer"]', '[data-testid="workflow-popover"]'],
    ['[data-testid="loop-manage"]', '[data-testid="loop-explainer"]', null],
    ['[data-testid="goal-manage"]', '[data-testid="goal-explainer"]', null],
  ]) {
    click(buttonSelector);
    cli(['wait-for', '--selector', explainerSelector, '--timeout', '10000']);
    const contract = inspect(`(()=>{
      const explainer=document.querySelector(${JSON.stringify(explainerSelector)});
      const popup=${popupSelector
        ? `document.querySelector(${JSON.stringify(popupSelector)})`
        : "explainer?.closest('div.absolute')"};
      const rect=popup?.getBoundingClientRect();
      return {
        explanation:(explainer?.textContent||'').trim(),
        rect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}:null,
        fits:Boolean(rect&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight),
      };
    })()`);
    popoverContracts.push(contract);
  }
  click('[data-testid="goal-manage"]');
  report.domGeometry.popovers = popoverContracts;
  report.checks.longChainPopoversExplainThemselvesAndFit = popoverContracts.length === 3
    && popoverContracts.every((contract) => contract.fits && contract.explanation.length >= 40);

  inspect(`(()=>{window.confirm=()=>true;return true})()`);
  click('[data-testid="agent-panel-toggle"]');
  cli(['wait-for', '--selector', '[data-testid="agent-teams-toggle"]', '--timeout', '10000']);
  const initialTeamState = inspect(`document.querySelector('[data-testid="agent-teams-toggle"]')?.getAttribute('aria-checked')`);
  const measureTeamSwitch = () => inspect(`(()=>{
    const track=document.querySelector('[data-testid="agent-teams-toggle"]');
    const knob=track?.querySelector('span');
    if(!track||!knob)return null;
    knob.style.transition='none';
    const outer=track.getBoundingClientRect();
    const inner=knob.getBoundingClientRect();
    return {
      checked:track.getAttribute('aria-checked'),
      track:{left:outer.left,right:outer.right,top:outer.top,bottom:outer.bottom},
      knob:{left:inner.left,right:inner.right,top:inner.top,bottom:inner.bottom},
      contained:inner.left>=outer.left&&inner.right<=outer.right&&inner.top>=outer.top&&inner.bottom<=outer.bottom,
    };
  })()`);
  let teamOff = measureTeamSwitch();
  let teamOn = teamOff;
  if (initialTeamState !== 'true') {
    click('[data-testid="agent-teams-toggle"]');
    await sleep(100);
    teamOn = measureTeamSwitch();
    click('[data-testid="agent-teams-toggle"]');
    await sleep(100);
    teamOff = measureTeamSwitch();
  } else {
    click('[data-testid="agent-teams-toggle"]');
    await sleep(100);
    teamOff = measureTeamSwitch();
    click('[data-testid="agent-teams-toggle"]');
    await sleep(100);
    teamOn = measureTeamSwitch();
  }
  report.domGeometry.agentTeamsSwitch = { off: teamOff, on: teamOn };
  report.checks.agentTeamsSwitchStaysInsideTrack = teamOff?.checked === 'false'
    && teamOn?.checked === 'true'
    && teamOff.contained
    && teamOn.contained
    && teamOn.knob.left > teamOff.knob.left;
  click('[data-testid="agent-panel-toggle"]');

  click('[data-testid="activity-panel-toggle"]');
  cli(['wait-for', '--selector', '[data-testid="activity-panel"]', '--timeout', '10000']);
  const activityGeometry = inspect(`(()=>{
    const panel=document.querySelector('[data-testid="activity-panel"]');
    let animated=panel?.parentElement;
    while(animated&&!String(animated.className).includes('transition-all'))animated=animated.parentElement;
    if(animated)animated.style.transition='none';
    const rect=panel?.getBoundingClientRect();
    return rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,viewportHeight:innerHeight,fits:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight}:null;
  })()`);
  report.domGeometry.activityPanel = activityGeometry;
  report.checks.activityPanelFitsTheWindow = Boolean(
    activityGeometry?.fits
      && activityGeometry.width >= 280
      && activityGeometry.bottom === activityGeometry.viewportHeight
      && activityGeometry.height >= activityGeometry.viewportHeight - 80,
  );
  click('[data-testid="activity-panel-toggle"]');

  cli(['wait-for', '--selector', '[data-testid="extensions-button"]', '--timeout', '30000']);
  click('[data-testid="extensions-button"]');
  cli(['wait-for', '--selector', '[data-testid="extension-center"]', '--timeout', '30000']);
  cli([
    'wait-for',
    '--selector',
    '[data-testid="extension-plugin-catalog"][data-plugin-loaded="true"]',
    '--timeout',
    '30000',
  ]);

  const extensionNav = inspect(`(()=>({tabs:[...document.querySelectorAll('[data-testid^="extension-tab-"]')].map((element)=>element.getAttribute('data-testid')),capabilityBadges:document.querySelectorAll('[data-testid="extension-center"] header span.rounded-full').length}))()`);
  report.checks.sixExtensionTabs = extensionNav.tabs?.length === 6
    && ['plugins', 'skills', 'workflows', 'mcp', 'agents', 'hooks']
      .every((name) => extensionNav.tabs.includes(`extension-tab-${name}`));
  report.checks.noDuplicateCapabilityRow = extensionNav.capabilityBadges === 0;
  const pluginState = inspect(`(()=>({loaded:document.querySelector('[data-testid="extension-plugin-catalog"]')?.getAttribute('data-plugin-loaded'),error:document.querySelector('[data-testid="plugin-catalog-error"]')?.textContent?.trim()||'',bodyHasCliError:document.body?.textContent?.includes('Claude CLI not found')||false}))()`);
  report.checks.pluginCatalogResolvesClaudeCli = pluginState.loaded === 'true'
    && !pluginState.error
    && !pluginState.bodyHasCliError;

  click('[data-testid="run-plugin-diagnostics"]');
  cli([
    'wait-for',
    '--selector',
    '[data-testid="plugin-security-diagnostics"][data-diagnostics-ready="true"]',
    '--timeout',
    '60000',
  ]);
  const diagnosticState = inspect(`(()=>{const panel=document.querySelector('[data-testid="plugin-security-diagnostics"]');return {ready:panel?.getAttribute('data-diagnostics-ready'),pluginCount:Number(panel?.getAttribute('data-plugin-count')||0),signatureDisclaimer:!!panel?.querySelector('[data-testid="plugin-signature-disclaimer"]'),digestVisible:(panel?.textContent||'').includes('SHA-256'),error:document.querySelector('[data-testid="plugin-catalog-error"]')?.textContent?.trim()||''}})()`);
  report.checks.pluginSecurityDiagnosticsAreTruthful = diagnosticState.ready === 'true'
    && diagnosticState.pluginCount >= 1
    && diagnosticState.signatureDisclaimer
    && diagnosticState.digestVisible
    && !diagnosticState.error;

  click('[data-testid="extension-tab-agents"]');
  cli(['wait-for', '--text', agentName, '--timeout', '30000']);
  const agentText = cli(['get-visible-text', '--selector', '[data-testid="extension-agents-catalog"]']).text;
  report.checks.agentCatalogLoadsNativeFiles = agentText.includes(agentName)
    && agentText.includes('haiku')
    && agentText.includes('Read');

  click('[data-testid="extension-tab-hooks"]');
  cli(['wait-for', '--text', hookCommand, '--timeout', '30000']);
  const hookText = cli(['get-visible-text', '--selector', '[data-testid="extension-hooks-catalog"]']).text;
  report.checks.hookCatalogLoadsNativeSettings = hookText.includes('PreToolUse')
    && hookText.includes('Read')
    && hookText.includes(hookCommand);

  click('[data-testid="scheduled-button"]');
  cli(['wait-for', '--selector', '[data-testid="automation-center"]', '--timeout', '30000']);
  const scheduledState = inspect(`(()=>({center:!!document.querySelector('[data-testid="automation-center"]'),close:!!document.querySelector('[data-testid="automation-center-close"]'),settings:!!document.querySelector('[data-testid="settings-panel"]')}))()`);
  report.checks.scheduledIsIndependentMainView = scheduledState.center
    && scheduledState.close
    && !scheduledState.settings;
  click('[data-testid="automation-center-close"]');

  click('[data-testid="settings-button"]');
  cli(['wait-for', '--selector', '[data-testid="settings-panel"]', '--timeout', '30000']);
  const settingsTabs = inspect(`(()=>[...document.querySelectorAll('[data-testid^="settings-tab-"]')].map((element)=>element.getAttribute('data-testid')))()`);
  report.checks.settingsOnlyOwnsAppConfiguration = JSON.stringify(settingsTabs)
    === JSON.stringify([
      'settings-tab-general',
      'settings-tab-provider',
      'settings-tab-cli',
      'settings-tab-desktopPet',
    ]);
  report.checks.noReactFatalBoundary = !inspect(`(()=>document.body.innerText.includes('Maximum update depth exceeded')||document.body.innerText.includes('Something went wrong'))()`);

  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await closeApp();
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
