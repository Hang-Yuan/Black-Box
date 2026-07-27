#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const binary = resolve(process.env.BLACKBOX_SMOKE_BINARY || join(repoRoot, 'src-tauri/target/debug/blackbox'));
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const automationBase = process.env.BLACKBOX_AUTOMATION_HOME;
if (!existsSync(binary)) throw new Error('Build the Black Box debug binary first');
if (!isolationRoot || !automationBase) throw new Error('Run through scripts/run-isolated.sh');

const testId = `lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolve(isolationRoot), testId);
const runRoot = join(resolve(automationBase), 'lifecycle-runs', testId);
const isolatedHome = join(runRoot, 'home');
const automationHome = join(runRoot, 'automation-home');
const pidFile = join(runRoot, 'fake-claude.pid');
const taskFile = join(runRoot, 'automation.json');
const appLog = join(runRoot, 'blackbox-app.log');
const database = join(automationHome, 'automations.sqlite');
const fakeClaude = join(scriptDir, 'fixtures', 'fake-claude-hang.mjs');
const taskId = `lifecycle-smoke-${Date.now()}`;

mkdirSync(workspace, { recursive: true });
mkdirSync(runRoot, { recursive: true });
process.env.HOME = isolatedHome;
process.env.CLAUDE_CONFIG_DIR = join(isolatedHome, '.claude');
process.env.XDG_CONFIG_HOME = join(isolatedHome, '.config');
process.env.XDG_CACHE_HOME = join(isolatedHome, '.cache');
process.env.XDG_DATA_HOME = join(isolatedHome, '.local', 'share');
process.env.BLACKBOX_SKILL_HOME = join(isolatedHome, '.claude', 'skills');
mkdirSync(join(process.env.HOME, '.claude', 'local'), { recursive: true });
process.env.BLACKBOX_AUTOMATION_HOME = automationHome;
process.env.BLACKBOX_AUTOMATION_TIMEOUT_SECS = '2';
process.env.FAKE_CLAUDE_PID_FILE = pidFile;
const isolatedClaude = join(process.env.HOME, '.claude', 'local', 'claude');
if (!existsSync(isolatedClaude)) symlinkSync(fakeClaude, isolatedClaude);

function cli(...args) {
  return spawnSync(binary, ['--automation-tool', ...args], {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function sql(statement) {
  const result = spawnSync('sqlite3', [database, statement], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(`SQLite failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}


const definition = {
  version: 1,
  id: taskId,
  kind: 'cron',
  name: 'Lifecycle Smoke',
  prompt: 'This fixture must remain running until Black Box stops it.',
  status: 'PAUSED',
  rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=59;BYSECOND=0',
  model: 'claude-haiku-4-5-20251001',
  reasoning_effort: 'low',
  execution_environment: 'local',
  target: { type: 'project', projectId: workspace },
  cwds: [workspace],
  target_thread_id: null,
  provider_id: null,
  created_at: 0,
  updated_at: 0,
};
writeFileSync(taskFile, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
const upsert = cli('upsert', taskFile);
if (upsert.status !== 0) throw new Error(`Cannot upsert lifecycle fixture: ${upsert.stderr.trim()}`);

const timed = cli('run', taskId);
if (timed.status !== 0) throw new Error(`Blocking lifecycle run failed: ${timed.stderr.trim()}`);
const runId = sql(`SELECT run_id FROM automation_runs WHERE automation_id='${taskId}' ORDER BY started_at DESC LIMIT 1;`);
const timeoutState = sql(`SELECT status || '|' || COALESCE(error,'') FROM automation_runs WHERE run_id='${runId}';`);
if (!timeoutState.startsWith('FAILED|Automation timed out after 2 seconds')) {
  throw new Error(`Timeout was not recorded correctly: ${timeoutState}`);
}
if (!existsSync(pidFile)) throw new Error('Fake Claude process did not start');
const childPid = Number(readFileSync(pidFile, 'utf8').trim());
let childAlive = true;
try { process.kill(childPid, 0); } catch { childAlive = false; }
if (childAlive) throw new Error(`Timed-out Claude process is still alive: ${childPid}`);
if (sql(`SELECT COUNT(*) FROM automations WHERE id='${taskId}' AND active_run_id IS NOT NULL;`) !== '0') {
  throw new Error('Timeout did not release the automation claim');
}

sql(`UPDATE automation_runs SET status='RUNNING',error=NULL,summary='',finished_at=NULL WHERE run_id='${runId}'; UPDATE automations SET active_run_id='${runId}' WHERE id='${taskId}';`);
process.env.BLACKBOX_AUTOMATION_TIMEOUT_SECS = '30';
const log = await import('node:fs').then(({ openSync }) => openSync(appLog, 'a'));
const app = spawn(binary, [], {
  cwd: workspace,
  env: process.env,
  stdio: ['ignore', log, log],
});
try {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const state = sql(`SELECT status || '|' || COALESCE(error,'') FROM automation_runs WHERE run_id='${runId}';`);
    if (state.startsWith('FAILED|Interrupted because Black Box exited')) break;
    await sleep(200);
  }
  const recovered = sql(`SELECT status || '|' || COALESCE(error,'') FROM automation_runs WHERE run_id='${runId}';`);
  if (!recovered.startsWith('FAILED|Interrupted because Black Box exited')) {
    throw new Error(`Interrupted run was not recovered: ${recovered}`);
  }
  if (sql(`SELECT COUNT(*) FROM automations WHERE id='${taskId}' AND active_run_id IS NOT NULL;`) !== '0') {
    throw new Error('Startup recovery did not release the automation claim');
  }
  if (sql(`SELECT COUNT(*) FROM inbox_items WHERE run_id='${runId}';`) !== '1') {
    throw new Error('Startup recovery did not create one review inbox item');
  }
  process.stdout.write(`${JSON.stringify({
    testId,
    timeoutState,
    timedOutProcessKilled: true,
    interruptedState: recovered,
    activeClaimReleased: true,
    inboxCount: 1,
    passed: true,
  }, null, 2)}\n`);
} finally {
  if (app.exitCode === null) app.kill('SIGTERM');
}
