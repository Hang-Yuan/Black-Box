#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const binary = resolve(process.env.BLACKBOX_SMOKE_BINARY || join(repoRoot, 'src-tauri/target/debug/blackbox'));
const claudeBinary = process.env.BLACKBOX_SMOKE_CLAUDE_BIN;
const providerFile = process.env.BLACKBOX_SMOKE_PROVIDER_FILE;
const isolationRoot = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
const automationBase = process.env.BLACKBOX_AUTOMATION_HOME;
const timeoutMs = Number(process.env.BLACKBOX_SMOKE_TIMEOUT_MS || 180_000);
const stdioMcpMode = process.env.BLACKBOX_SMOKE_MCP === '1';
const httpMcpMode = process.env.BLACKBOX_SMOKE_MCP_HTTP === '1';
const mcpMode = stdioMcpMode || httpMcpMode;
const worktreeMode = process.env.BLACKBOX_SMOKE_WORKTREE === '1';
const pluginSubagentMode = process.env.BLACKBOX_SMOKE_PLUGIN_SUBAGENT === '1';
const agentTeamMode = process.env.BLACKBOX_SMOKE_AGENT_TEAM === '1';
const resumeMode = process.env.BLACKBOX_SMOKE_RESUME === '1';
const pluginMarketplace = join(scriptDir, 'fixtures', 'claude-plugin-marketplace');

function requirePath(value, label) {
  if (!value || !existsSync(value)) {
    throw new Error(`${label} is required and must exist`);
  }
  return resolve(value);
}

requirePath(binary, 'BLACKBOX_SMOKE_BINARY');
const resolvedClaude = requirePath(claudeBinary, 'BLACKBOX_SMOKE_CLAUDE_BIN');
const resolvedProvider = requirePath(providerFile, 'BLACKBOX_SMOKE_PROVIDER_FILE');
const resolvedIsolationRoot = requirePath(isolationRoot, 'BLACKBOX_DEV_ISOLATION_ROOT');
if (!automationBase) throw new Error('BLACKBOX_AUTOMATION_HOME is required');

const providers = JSON.parse(readFileSync(resolvedProvider, 'utf8'));
const activeProvider = providers.providers?.find((item) => item.id === providers.activeProviderId);
if (!activeProvider) throw new Error('Active provider is missing');
const smokeModel = process.env.BLACKBOX_SMOKE_MODEL
  || activeProvider.modelMappings?.find((item) => item.tier === 'haiku')?.providerModel
  || 'claude-haiku-4-5-20251001';
if (/opus|fable/i.test(smokeModel)) {
  throw new Error(`Smoke tests refuse Opus/Fable models; choose Haiku or Sonnet instead (received ${smokeModel})`);
}
process.env.CLAUDE_CODE_SUBAGENT_MODEL = smokeModel;

const runId = `generic-scheduler-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workspace = join(resolvedIsolationRoot, runId);
const runRoot = join(resolve(automationBase), 'smoke-runs', runId);
const automationHome = join(runRoot, 'automation-home');
const runClaudeConfig = join(runRoot, 'claude-config');
// macOS limits Unix-domain socket paths to roughly 104 bytes. Keep the
// coordination endpoint short while still making every isolated run unique.
const testSocket = `/tmp/blackbox-smoke-${process.pid}.sock`;
process.env.BLACKBOX_AUTOMATION_HOME = automationHome;
process.env.BLACKBOX_SOCKET = testSocket;
process.env.CLAUDE_CONFIG_DIR = runClaudeConfig;
process.env.BLACKBOX_SKILL_HOME = join(runClaudeConfig, 'skills');
const skillDir = join(workspace, '.claude', 'skills', 'scheduler-smoke');
const sourceResultFile = join(workspace, 'scheduler-smoke-result.txt');
const taskFile = join(runRoot, 'automation.json');
const resumeTaskFile = join(runRoot, 'resume-automation.json');
const appLog = join(runRoot, 'blackbox-app.log');
const reportFile = join(runRoot, 'report.json');
const mcpReadyFile = join(runRoot, 'mcp-http-ready.json');
const mcpHttpLog = join(runRoot, 'mcp-http.log');
const mcpHttpRequestLog = join(runRoot, 'mcp-http-requests.log');
const marker = `SCHEDULER_SMOKE_OK_${Date.now()}`;
const teamAlphaFile = join(workspace, 'team-alpha.txt');
const teamBetaFile = join(workspace, 'team-beta.txt');
const taskId = `generic-scheduler-smoke-${Date.now()}`;
const resumeTaskId = `${taskId}-resume`;

mkdirSync(skillDir, { recursive: true });
mkdirSync(runRoot, { recursive: true });
mkdirSync(runClaudeConfig, { recursive: true });
mkdirSync(join(process.env.HOME, '.claude', 'local'), { recursive: true });
mkdirSync(resolve(automationHome), { recursive: true });
if (agentTeamMode) {
  writeFileSync(teamAlphaFile, `ALPHA_${marker}\n`, 'utf8');
  writeFileSync(teamBetaFile, `BETA_${marker}\n`, 'utf8');
}
const claudeStateDirectory = runClaudeConfig;
mkdirSync(claudeStateDirectory, { recursive: true });
const claudeStateFile = join(claudeStateDirectory, '.claude.json');

function cleanupRunConversations() {
  for (const directory of ['projects', 'session-env', 'tasks', 'file-history']) {
    rmSync(join(runClaudeConfig, directory), { recursive: true, force: true });
  }
  for (const filename of ['history.jsonl', 'blackbox_session_names.json']) {
    rmSync(join(runClaudeConfig, filename), { force: true });
  }
}

let mcpServerProcess = null;
let mcpHttpUrl = null;
if (httpMcpMode) {
  const server = join(scriptDir, 'fixtures', 'mcp-http-smoke-server.mjs');
  requirePath(server, 'HTTP MCP smoke server');
  const serverLogFd = openSync(mcpHttpLog, 'a');
  mcpServerProcess = spawn(process.execPath, [server], {
    cwd: workspace,
    env: {
      ...process.env,
      MCP_SMOKE_MARKER: marker,
      MCP_HTTP_READY_FILE: mcpReadyFile,
      MCP_HTTP_LOG_FILE: mcpHttpRequestLog,
    },
    stdio: ['ignore', serverLogFd, serverLogFd],
  });
  const readyStarted = Date.now();
  while (!existsSync(mcpReadyFile) && Date.now() - readyStarted < 5_000) {
    if (mcpServerProcess.exitCode !== null) {
      throw new Error(`HTTP MCP fixture exited early with ${mcpServerProcess.exitCode}`);
    }
    await sleep(50);
  }
  if (!existsSync(mcpReadyFile)) throw new Error('HTTP MCP fixture did not become ready');
  mcpHttpUrl = JSON.parse(readFileSync(mcpReadyFile, 'utf8')).url;
}

const isolatedClaude = join(process.env.HOME, '.claude', 'local', 'claude');
if (!existsSync(isolatedClaude)) symlinkSync(resolvedClaude, isolatedClaude);
copyFileSync(resolvedProvider, join(resolve(automationHome), 'providers.json'));

function pluginCli(args) {
  const result = spawnSync(resolvedClaude, args, {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`claude ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout || '';
}

if (pluginSubagentMode) {
  requirePath(pluginMarketplace, 'plugin marketplace fixture');
  pluginCli(['plugin', 'validate', '--strict', pluginMarketplace]);
  const marketplaces = JSON.parse(pluginCli(['plugin', 'marketplace', 'list', '--json']));
  if (marketplaces.some((item) => item.name === 'blackbox-smoke')) {
    pluginCli(['plugin', 'marketplace', 'update', 'blackbox-smoke']);
  } else {
    pluginCli(['plugin', 'marketplace', 'add', pluginMarketplace]);
  }
  const installedPlugins = JSON.parse(pluginCli(['plugin', 'list', '--json']));
  const fixture = installedPlugins.find((item) => item.id === 'blackbox-trace-plugin@blackbox-smoke');
  if (fixture) {
    pluginCli(['plugin', 'update', 'blackbox-trace-plugin@blackbox-smoke', '--scope', 'user']);
    if (!fixture.enabled) pluginCli(['plugin', 'enable', 'blackbox-trace-plugin@blackbox-smoke', '--scope', 'user']);
  } else {
    pluginCli(['plugin', 'install', 'blackbox-trace-plugin@blackbox-smoke', '--scope', 'user']);
  }
  const details = pluginCli(['plugin', 'details', 'blackbox-trace-plugin@blackbox-smoke']);
  if (!/Skills \(1\)/.test(details) || !/Agents \(1\)/.test(details)) {
    throw new Error('Installed plugin inventory did not expose one skill and one agent');
  }
}

if (mcpMode) {
  const server = join(scriptDir, 'fixtures', 'mcp-smoke-server.mjs');
  if (stdioMcpMode) requirePath(server, 'MCP smoke server');
  writeFileSync(
    claudeStateFile,
    `${JSON.stringify({
      mcpServers: {
        scheduler_smoke: httpMcpMode
          ? { type: 'http', url: mcpHttpUrl, alwaysLoad: true }
          : {
            type: 'stdio',
            command: process.execPath,
            args: [server],
            env: { MCP_SMOKE_MARKER: marker },
            alwaysLoad: true,
          },
      },
    }, null, 2)}\n`,
    'utf8',
  );
} else {
  writeFileSync(claudeStateFile, '{"mcpServers":{}}\n', 'utf8');
}

if (!pluginSubagentMode) {
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    mcpMode
      ? `---\nname: scheduler-smoke\ndescription: Isolated scheduled MCP acceptance skill.\n---\n\n# Scheduled MCP smoke\n\nCall mcp__scheduler_smoke__emit_marker with an empty input. Use the Write tool (not Bash) to create ${sourceResultFile} with the exact text returned by that MCP tool. Do not guess or invent the marker.\n\nAfter the write succeeds, finish with this directive on its own line:\n\n::inbox-item{title="Generic scheduler MCP smoke" summary="Scheduled MCP and Write tool completed in isolation"}\n`
      : `---\nname: scheduler-smoke\ndescription: Isolated generic scheduler acceptance skill.\n---\n\n# Scheduler smoke\n\nWhen invoked, use the Write tool (not Bash) to create ${worktreeMode ? 'scheduler-smoke-result.txt in the current working directory' : `this exact file:\n\n${sourceResultFile}`} with these exact contents:\n\n${marker}\n\nAfter the write succeeds, finish with this directive on its own line:\n\n::inbox-item{title="Generic scheduler smoke" summary="Scheduled skill and Write tool completed in isolation"}\n`,
    'utf8',
  );
}

if (worktreeMode) {
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Black Box Smoke'],
    ['config', 'user.email', 'blackbox-smoke@example.invalid'],
    ['add', '.claude'],
    ['commit', '-qm', 'worktree smoke fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    if (git.status !== 0) throw new Error(`Cannot prepare worktree smoke repository: ${(git.stderr || git.stdout).trim()}`);
  }
}

const logFd = openSync(appLog, 'a');
const app = spawn(binary, [], {
  cwd: workspace,
  env: process.env,
  detached: false,
  stdio: ['ignore', logFd, logFd],
});

function cli(...args) {
  const result = spawnSync(binary, ['--automation-tool', ...args], {
    cwd: workspace,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`automation CLI failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function findNamedFile(root, name) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findNamedFile(path, name);
      if (nested) return nested;
    }
  }
  return null;
}

const report = {
  runId,
  mode: worktreeMode
    ? 'scheduled-worktree'
    : agentTeamMode
      ? 'scheduled-agent-team'
    : pluginSubagentMode
      ? 'scheduled-plugin-subagent'
    : httpMcpMode
      ? 'scheduled-http-mcp'
      : mcpMode
        ? 'scheduled-mcp'
        : 'scheduled-skill',
  workspace,
  automationHome: resolve(automationHome),
  claudeConfigDir: runClaudeConfig,
  appLog,
  taskId,
  model: smokeModel,
  scheduledAt: null,
  runStatus: null,
  toolUses: [],
  agentTypes: [],
  agentKinds: [],
  teammateNames: [],
  nestedWriteObserved: false,
  nestedReadObserved: false,
  agentLifecycleObserved: false,
  sharedTaskToolsObserved: false,
  inboxCount: 0,
  resultFile: sourceResultFile,
  executionCwd: null,
  sessionId: null,
  sessionTracked: false,
  transcriptFile: null,
  transcriptVerified: false,
  resumeRunId: null,
  resumeStatus: null,
  resumeContextVerified: false,
  sourceUnchanged: null,
  markerVerified: false,
  passed: false,
};

try {
  await sleep(2_000);
  if (app.exitCode !== null || app.signalCode !== null) {
    throw new Error(`Black Box exited early with ${app.exitCode ?? app.signalCode}`);
  }

  const second = new Date().getSeconds();
  const task = {
    version: 1,
    id: report.taskId,
    kind: 'cron',
    name: agentTeamMode
      ? 'Generic Scheduler Agent Team Smoke'
      : pluginSubagentMode
        ? 'Generic Scheduler Plugin Subagent Smoke'
        : mcpMode
          ? 'Generic Scheduler MCP Smoke'
          : 'Generic Scheduler Smoke',
    prompt: agentTeamMode
      ? `Run this Agent Teams acceptance literally. Create two shared tasks with TaskCreate. Spawn exactly two named teammates with Agent(name): reader-alpha must own its task, read ${teamAlphaFile}, and send its exact marker to reader-beta with SendMessage; reader-beta must own its task, read ${teamBetaFile}, and send its exact marker to reader-alpha with SendMessage. Use TaskUpdate so both tasks finish completed. The lead must wait for both teammates and must not read either input file itself. After receiving both findings, the lead must use Write to create ${sourceResultFile} containing exactly ${marker} and a trailing newline. Then emit this directive on its own line: ::inbox-item{title="Scheduled Agent Team smoke" summary="Scheduled shared tasks, named teammates, peer messaging, and nested reads completed in isolation"}`
      : pluginSubagentMode
      ? `Use the Skill tool to invoke blackbox-trace-plugin:delegated-write and follow it exactly. Delegate this exact output file to the plugin agent: ${sourceResultFile}\nThe exact marker is: ${marker}\nDo not write the file in the main agent. After the plugin skill completes, emit this directive on its own line: ::inbox-item{title="Scheduled plugin subagent smoke" summary="Scheduled Skill, Agent, and Write completed in isolation"}`
      : 'Invoke the scheduler-smoke skill with the Skill tool and follow it exactly. Do not read or write outside the current isolated project.',
    status: 'ACTIVE',
    rrule: `FREQ=MINUTELY;INTERVAL=1;BYSECOND=${second}`,
    model: smokeModel,
    reasoning_effort: 'low',
    agent_teams_enabled: agentTeamMode,
    execution_environment: worktreeMode ? 'worktree' : 'local',
    target: { type: 'project', projectId: workspace },
    cwds: [workspace],
    target_thread_id: null,
    provider_id: activeProvider.id,
    provider_revision: Number(activeProvider.revision || 1),
    created_at: 0,
    updated_at: 0,
  };
  writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  const upserted = cli('upsert', taskFile);
  report.scheduledAt = upserted.nextRunAt;

  const started = Date.now();
  let run;
  while (Date.now() - started < timeoutMs) {
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`Black Box exited during the scheduled run with ${app.exitCode ?? app.signalCode}`);
    }
    const runs = cli('runs', report.taskId);
    run = runs[0];
    if (run && ['PENDING_REVIEW', 'FAILED'].includes(run.status)) break;
    await sleep(2_000);
  }
  if (!run) throw new Error('No scheduled run was recorded before timeout');
  cli('pause', report.taskId);
  report.runStatus = run.status;
  if (run.status !== 'PENDING_REVIEW') throw new Error(`Scheduled run failed: ${run.error || run.summary}`);
  report.sessionId = run.sessionId || null;
  if (!report.sessionId || report.sessionId !== run.runId) {
    throw new Error(`Scheduled run did not persist its run UUID as the Claude session ID: ${report.sessionId || 'missing'}`);
  }
  const trackedSessionsFile = join(process.env.HOME, '.blackbox', 'tracked_sessions.txt');
  report.sessionTracked = existsSync(trackedSessionsFile)
    && readFileSync(trackedSessionsFile, 'utf8').split(/\r?\n/).includes(report.sessionId);
  if (!report.sessionTracked) throw new Error('Scheduled Claude session was not added to the Black Box session index');
  report.toolUses = (run.trace || [])
    .filter((event) => event.eventType === 'tool_use')
    .map((event) => event.toolName)
    .filter(Boolean);
  const requiredTools = agentTeamMode
    ? ['TaskCreate', 'Agent', 'Read', 'SendMessage', 'TaskUpdate', 'Write']
    : mcpMode
    ? ['Skill', 'mcp__scheduler_smoke__emit_marker', 'Write']
    : pluginSubagentMode
      ? ['Skill', 'Agent', 'Write']
      : ['Skill', 'Write'];
  const missingTools = requiredTools.filter((tool) => !report.toolUses.includes(tool));
  if (missingTools.length) {
    throw new Error(`Scheduled trace missed required tools: ${missingTools.join(', ')}`);
  }
  if (pluginSubagentMode) {
    const trace = run.trace || [];
    report.agentTypes = [...new Set(trace.map((event) => event.agentType).filter(Boolean))];
    report.nestedWriteObserved = trace.some((event) => event.eventType === 'tool_use'
      && event.toolName === 'Write'
      && event.agentDepth === 1
      && event.parentToolUseId);
    report.agentLifecycleObserved = trace.some((event) => event.eventType === 'agent_start'
      && event.agentType === 'blackbox-trace-plugin:trace-worker')
      && trace.some((event) => event.eventType === 'agent_result' && event.summary === 'Completed');
    if (!report.nestedWriteObserved) throw new Error('Scheduled Write was not attributed to the plugin subagent');
    if (!report.agentLifecycleObserved) throw new Error('Scheduled trace missed the plugin subagent lifecycle');
  }
  if (agentTeamMode) {
    const trace = run.trace || [];
    report.agentTypes = [...new Set(trace.map((event) => event.agentType).filter(Boolean))];
    report.agentKinds = [...new Set(trace.map((event) => event.agentKind).filter(Boolean))];
    report.teammateNames = report.agentTypes.filter((name) => name === 'reader-alpha' || name === 'reader-beta');
    report.nestedReadObserved = trace.some((event) => event.eventType === 'tool_use'
      && event.toolName === 'Read'
      && event.agentKind === 'teammate'
      && event.agentDepth === 1
      && event.parentToolUseId);
    report.agentLifecycleObserved = ['reader-alpha', 'reader-beta'].every((name) => (
      trace.some((event) => event.eventType === 'agent_start'
        && event.agentKind === 'teammate'
        && event.agentType === name)
      && trace.some((event) => event.eventType === 'agent_result'
        && event.agentKind === 'teammate'
        && event.agentType === name
        && event.summary === 'Completed')
    ));
    report.sharedTaskToolsObserved = ['TaskCreate', 'TaskUpdate'].every((tool) => report.toolUses.includes(tool));
    if (report.teammateNames.length !== 2) {
      throw new Error(`Scheduled trace did not preserve both stable teammate names: ${report.teammateNames.join(', ')}`);
    }
    if (!report.nestedReadObserved) throw new Error('Scheduled nested Read was not attributed to a teammate');
    if (!report.agentLifecycleObserved) throw new Error('Scheduled trace missed a named teammate lifecycle');
    if (!report.sharedTaskToolsObserved) throw new Error('Scheduled trace missed shared task lifecycle tools');
  }
  report.executionCwd = run.executionCwd || null;
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude');
  report.transcriptFile = findNamedFile(join(claudeRoot, 'projects'), `${report.sessionId}.jsonl`);
  if (report.transcriptFile) {
    report.transcriptVerified = readFileSync(report.transcriptFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => {
        try {
          const event = JSON.parse(line);
          return event.sessionId === report.sessionId && event.cwd === report.executionCwd;
        } catch {
          return false;
        }
      });
  }
  if (!report.transcriptVerified) {
    throw new Error('Scheduled Claude transcript did not preserve the expected session ID and execution directory');
  }
  const resultFile = worktreeMode
    ? join(run.executionCwd || '', 'scheduler-smoke-result.txt')
    : sourceResultFile;
  report.resultFile = resultFile;
  if (!existsSync(resultFile)) throw new Error('Scheduled skill did not create its isolated result file');
  report.markerVerified = readFileSync(resultFile, 'utf8').trim() === marker;
  if (!report.markerVerified) throw new Error('Scheduled result marker did not match the skill-only marker');
  if (worktreeMode) {
    if (!run.executionCwd || run.executionCwd === workspace) throw new Error('Worktree run did not record an isolated execution directory');
    if (existsSync(sourceResultFile)) throw new Error('Worktree run modified the source project');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
    if (status.status !== 0) throw new Error(`Cannot inspect source repository: ${status.stderr.trim()}`);
    report.sourceUnchanged = status.stdout.trim() === '';
    if (!report.sourceUnchanged) throw new Error(`Source repository changed: ${status.stdout.trim()}`);
  }

  const inbox = spawnSync(
    'sqlite3',
    [join(resolve(automationHome), 'automations.sqlite'), `SELECT COUNT(*) FROM inbox_items WHERE run_id='${run.runId}';`],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (inbox.status !== 0) throw new Error(`Cannot verify inbox: ${inbox.stderr.trim()}`);
  report.inboxCount = Number(inbox.stdout.trim());
  if (report.inboxCount !== 1) throw new Error(`Expected one inbox item, got ${report.inboxCount}`);

  if (resumeMode) {
    writeFileSync(resumeTaskFile, `${JSON.stringify({
      version: 1,
      id: resumeTaskId,
      kind: 'heartbeat',
      name: 'Generic Scheduler Resume Smoke',
      prompt: 'Without using any tool or reading any file, return the exact SCHEDULER_SMOKE_OK marker from the task you just completed.',
      status: 'PAUSED',
      rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=59;BYSECOND=0',
      model: smokeModel,
      reasoning_effort: 'low',
      agent_teams_enabled: false,
      execution_environment: 'local',
      target: null,
      cwds: [report.executionCwd || workspace],
      target_thread_id: report.sessionId,
      provider_id: activeProvider.id,
      provider_revision: Number(activeProvider.revision || 1),
      created_at: 0,
      updated_at: 0,
    }, null, 2)}\n`, 'utf8');
    cli('upsert', resumeTaskFile);
    const resumeResponse = cli('run', resumeTaskId);
    if (resumeResponse?.Err) throw new Error(`Resume run failed: ${resumeResponse.Err}`);
    const resumeRun = cli('runs', resumeTaskId)[0];
    if (!resumeRun) throw new Error('Resume run finished without a run record');
    report.resumeRunId = resumeRun.runId;
    report.resumeStatus = resumeRun.status;
    report.resumeContextVerified = resumeRun.status === 'PENDING_REVIEW'
      && resumeRun.sessionId === report.sessionId
      && String(resumeRun.output || '').includes(marker);
    if (!report.resumeContextVerified) {
      throw new Error(`Durable session could not recover its prior task context: ${resumeRun.error || resumeRun.output || resumeRun.status}`);
    }
  }

  report.passed = true;
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  try { cli('pause', report.taskId); } catch { /* best-effort test cleanup */ }
  if (resumeMode) {
    try { cli('pause', resumeTaskId); } catch { /* best-effort test cleanup */ }
  }
  if (app.exitCode === null) app.kill('SIGTERM');
  if (mcpServerProcess?.exitCode === null) mcpServerProcess.kill('SIGTERM');
  cleanupRunConversations();
}
