import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf-8');
const settingsSource = readFileSync(
  resolve(__dirname, '../components/settings/SettingsPanel.tsx'),
  'utf-8',
);
const settingsStoreSource = readFileSync(
  resolve(__dirname, '../stores/settingsStore.ts'),
  'utf-8',
);
const sidebarSource = readFileSync(
  resolve(__dirname, '../components/layout/Sidebar.tsx'),
  'utf-8',
);
const automationBackendSource = readFileSync(
  resolve(__dirname, '../../src-tauri/src/automations.rs'),
  'utf-8',
);
const automationUiSource = readFileSync(
  resolve(__dirname, '../components/settings/AutomationsTab.tsx'),
  'utf-8',
);
const automationCenterSource = readFileSync(
  resolve(__dirname, '../components/automations/AutomationCenter.tsx'),
  'utf-8',
);
const rustEntrySource = readFileSync(
  resolve(__dirname, '../../src-tauri/src/lib.rs'),
  'utf-8',
);
const rustManifest = readFileSync(
  resolve(__dirname, '../../src-tauri/Cargo.toml'),
  'utf-8',
);
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'),
);
const capability = JSON.parse(
  readFileSync(resolve(__dirname, '../../src-tauri/capabilities/default.json'), 'utf-8'),
);
const tauriConfig = JSON.parse(
  readFileSync(resolve(__dirname, '../../src-tauri/tauri.conf.json'), 'utf-8'),
);
const tauriDevConfig = JSON.parse(
  readFileSync(resolve(__dirname, '../../src-tauri/tauri.dev.conf.json'), 'utf-8'),
);
const i18nSource = readFileSync(resolve(__dirname, '../lib/i18n.ts'), 'utf-8');
const automationOutputSource = readFileSync(resolve(__dirname, '../lib/automation-output.ts'), 'utf-8');
const schedulerSmokeSource = readFileSync(
  resolve(__dirname, '../../scripts/scheduler-smoke.mjs'),
  'utf-8',
);
const toolUseSmokeSource = readFileSync(
  resolve(__dirname, '../../scripts/tool-use-smoke.mjs'),
  'utf-8',
);
const isolatedRunnerSource = readFileSync(
  resolve(__dirname, '../../scripts/run-isolated.sh'),
  'utf-8',
);
const viteConfigSource = readFileSync(
  resolve(__dirname, '../../vite.config.ts'),
  'utf-8',
);
const pluginSubagentSmokeSource = readFileSync(
  resolve(__dirname, '../../scripts/plugin-subagent-smoke.mjs'),
  'utf-8',
);

function readProductTree(root: string): string {
  return readdirSync(root)
    .filter((name) => name !== '__tests__')
    .map((name) => {
      const path = resolve(root, name);
      return statSync(path).isDirectory() ? readProductTree(path) : readFileSync(path, 'utf-8');
    })
    .join('\n');
}

describe('automation runtime regressions', () => {
  it('treats the macOS red close button as an explicit app quit', () => {
    expect(appSource).not.toContain('await win.hide();');
    expect(rustEntrySource).toContain('WindowEvent::CloseRequested');
    expect(rustEntrySource).toContain('api.prevent_close();');
    expect(rustEntrySource).toContain('graceful_stop_session_inner');
    expect(rustEntrySource).toContain('native close settled CLI sessions; exiting application');
  });

  it('keeps native macOS traffic lights in both formal and isolated development windows', () => {
    for (const config of [tauriConfig, tauriDevConfig]) {
      const window = config.app.windows[0];
      expect(window.titleBarStyle).toBe('Overlay');
      expect(window.hiddenTitle).toBe(true);
      expect(window.decorations).not.toBe(false);
    }
    expect(tauriDevConfig.identifier).toBe('com.blackbox.app.dev');
  });

  it('states that quitting stops local scheduling', () => {
    expect(i18nSource).toContain('Black Box 退出后本地调度停止');
    expect(i18nSource).toContain('Local scheduling stops when Black Box quits');
    expect(i18nSource).not.toContain('窗口关闭后，Black Box 仍会在后台保持调度');
  });

  it('offers explicit login startup and keeps login-item launches hidden', () => {
    expect(packageJson.dependencies['@tauri-apps/plugin-autostart']).toBeTruthy();
    expect(rustManifest).toContain('tauri-plugin-autostart');
    expect(capability.permissions).toEqual(expect.arrayContaining([
      'autostart:allow-enable',
      'autostart:allow-disable',
      'autostart:allow-is-enabled',
    ]));
    expect(rustEntrySource).toContain('tauri_plugin_autostart::init');
    expect(rustEntrySource).toContain('Some(vec!["--background"])');
    expect(rustEntrySource).toContain('argument == "--background"');
    expect(rustEntrySource).toContain('window.hide()?;');
    expect(rustEntrySource).toContain('RunEvent::Reopen');
    expect(automationUiSource).toContain("from '@tauri-apps/plugin-autostart'");
    expect(automationUiSource).toContain('await enableAutostart()');
    expect(automationUiSource).toContain('await disableAutostart()');
    expect(automationUiSource).toContain('await isAutostartEnabled()');
    expect(automationUiSource).toContain('role="switch"');
  });

  it('keeps isolated Tauri development runnable without inheriting Cargo credentials', () => {
    expect(isolatedRunnerSource).toContain('host_home="$HOME"');
    expect(isolatedRunnerSource).toContain('host_node_bin="${BLACKBOX_HOST_NODE_BIN:-}"');
    expect(isolatedRunnerSource).toContain('host_node_bin="$(command -v node 2>/dev/null || true)"');
    expect(isolatedRunnerSource).toContain('"$(dirname "$host_pnpm_bin")/../../node/bin/node"');
    expect(isolatedRunnerSource).toContain('export PATH="$(dirname "$host_node_bin"):$PATH"');
    expect(isolatedRunnerSource).toContain('export BLACKBOX_HOST_NODE_BIN="$host_node_bin"');
    expect(isolatedRunnerSource).toContain('export RUSTUP_HOME="${RUSTUP_HOME:-$host_home/.rustup}"');
    expect(isolatedRunnerSource).toContain('export PATH="$host_home/.cargo/bin:$PATH"');
    expect(isolatedRunnerSource).toContain('for cache in registry git; do');
    expect(isolatedRunnerSource).not.toContain('export CARGO_HOME=');
    expect(isolatedRunnerSource.indexOf('host_home="$HOME"')).toBeLessThan(
      isolatedRunnerSource.indexOf('export HOME="$isolated_home"'),
    );
    expect(isolatedRunnerSource.indexOf('host_node_bin="${BLACKBOX_HOST_NODE_BIN:-}"')).toBeLessThan(
      isolatedRunnerSource.indexOf('export HOME="$isolated_home"'),
    );
    expect(viteConfigSource).toContain('"**/.dev-runtime/**"');
  });

  it('exposes Scheduled as a first-class sidebar inbox with unread state', () => {
    expect(settingsStoreSource).toContain("export type SettingsTab = 'general' | 'provider' | 'cli'");
    expect(settingsStoreSource).toContain("export type MainView = 'chat' | 'extensions' | 'automations' | 'taskCenter'");
    expect(settingsStoreSource).toContain("openSettings: (tab?: SettingsTab) => void");
    expect(settingsSource).not.toContain("{ id: 'automations', labelKey: 'settings.tab.automations' }");
    expect(settingsSource).not.toContain('<AutomationsTab />');
    expect(sidebarSource).toContain("setMainView('automations')");
    expect(appSource).toContain("mainView === 'automations'");
    expect(appSource).toContain('<AutomationCenter />');
    expect(automationCenterSource).toContain('<AutomationsTab standalone');
    expect(automationCenterSource).toContain("setMainView('chat')");
    expect(automationUiSource).toContain('data-testid="automation-center-close"');
    expect(sidebarSource).toContain('bridge.listAutomations()');
    expect(sidebarSource).toContain('total + item.unreadRuns');
    expect(sidebarSource).not.toContain("'99+'");
    expect(automationUiSource).toContain('bridge.markAllAutomationRunsRead()');
    expect(sidebarSource).toContain("'data-testid': 'scheduled-button'");
  });

  it('ships only the generic scheduling skill in the public app', () => {
    expect(tauriConfig.bundle.resources['resources/blackbox-schedule']).toBe('blackbox-schedule');
    expect(Object.keys(tauriConfig.bundle.resources)).toHaveLength(3);
  });

  it('keeps private profile names and paths out of public product sources', () => {
    const text = [
      readProductTree(resolve(__dirname, '..')),
      readProductTree(resolve(__dirname, '../../src-tauri/src')),
      readProductTree(resolve(__dirname, '../../src-tauri/resources')),
      JSON.stringify(tauriConfig),
    ].join('\n').toLowerCase();
    const forbidden = [
      ['sher', 'lock'].join(''),
      ['agent', 'sync'].join(''),
      ['yao', 'guang'].join(''),
      String.fromCodePoint(0x7476, 0x5149),
    ];
    for (const token of forbidden) expect(text).not.toContain(token.toLowerCase());
  });

  it('passes the saved MCP set into scheduled Claude runs', () => {
    expect(automationBackendSource).toContain('build_mcp_scratch_config');
    expect(automationBackendSource).toContain('cleanup_mcp_scratch_config');
    expect(automationBackendSource).not.toContain('r#"{\"mcpServers\":{}}"#');
  });

  it('captures and renders redacted scheduled tool traces', () => {
    expect(automationBackendSource).toContain('--output-format');
    expect(automationBackendSource).toContain('stream-json');
    expect(automationBackendSource).toContain('Input fields:');
    expect(automationBackendSource).toContain('trace_json');
    expect(automationBackendSource).toContain('parent_tool_use_id');
    expect(automationBackendSource).toContain('task_started');
    expect(automationBackendSource).toContain('task_notification');
    expect(automationUiSource).toContain("t('automations.trace')");
    expect(automationUiSource).toContain('run.trace.map');
    expect(automationUiSource).toContain('event.agentDepth');
    expect(automationUiSource).toContain("event.agentKind === 'teammate'");
    expect(automationUiSource).toContain("t('agents.teammate')");
    expect(automationUiSource).toContain("t('agents.subAgent')");
  });

  it('renders named Agent calls as teammates instead of generic subagents', () => {
    expect(automationUiSource).toContain("event.agentKind === 'teammate'");
    const messageBubbleSource = readFileSync(
      resolve(__dirname, '../components/chat/MessageBubble.tsx'),
      'utf-8',
    );
    expect(messageBubbleSource).toContain("t('agents.teammate')");
    expect(messageBubbleSource).toContain('input.name.trim()');
    expect(messageBubbleSource).toContain('sanitizeToolResultForDisplay');
  });

  it('runs unattended work through a fail-closed sandbox allowlist', () => {
    expect(automationBackendSource).toContain('"dontAsk".to_string()');
    expect(automationBackendSource).toContain('"failIfUnavailable": true');
    expect(automationBackendSource).toContain('"allowUnsandboxedCommands": false');
    expect(automationBackendSource).not.toContain('"bypassPermissions".to_string()');
  });

  it('creates real Git worktrees and exposes their review path', () => {
    expect(automationBackendSource).toContain('"worktree",');
    expect(automationBackendSource).toContain('"add",');
    expect(automationBackendSource).toContain('execution_cwd');
    expect(automationUiSource).toContain("t('automations.execution.worktree')");
    expect(automationUiSource).toContain('run.executionCwd');
    expect(automationBackendSource).toContain('base_commit TEXT');
    expect(automationBackendSource).toContain('get_automation_worktree_review');
    expect(automationBackendSource).toContain('collect_worktree_review');
    expect(rustEntrySource).toContain('automations::get_automation_worktree_review');
    expect(automationUiSource).toContain('bridge.getAutomationWorktreeReview(run.runId)');
    expect(automationUiSource).toContain("t('automations.reviewChanges')");
    expect(automationUiSource).toContain('bridge.revealInFinder(run.executionCwd');
  });

  it('exposes bounded per-file patches only for actual non-ignored changes', () => {
    expect(automationBackendSource).toContain('get_automation_worktree_file_diff');
    expect(automationBackendSource).toContain('collect_worktree_files');
    expect(automationBackendSource).toContain('Requested path is not an exposed worktree change');
    expect(automationBackendSource).toContain('MAX_REVIEW_PATCH_BYTES');
    expect(rustEntrySource).toContain('automations::get_automation_worktree_file_diff');
    expect(automationUiSource).toContain('bridge.getAutomationWorktreeFileDiff(runId, path)');
    expect(automationUiSource).toContain('review.files.map');
    expect(automationUiSource).toContain("t('automations.reviewBinaryFile')");
    expect(i18nSource).toContain("'automations.reviewFiles': '逐文件变更'");
    expect(i18nSource).toContain("'automations.reviewFiles': 'Changed Files'");
  });

  it('renders scheduled reports as safe Markdown without the final inbox control record', () => {
    expect(automationUiSource).toContain('<MarkdownRenderer');
    expect(automationUiSource).toContain('stripFinalInboxDirective(run.output)');
    expect(automationOutputSource).toContain("const INBOX_DIRECTIVE = '::inbox-item{'");
    expect(automationOutputSource).toContain("!suffix.endsWith('}')");
  });

  it('persists each standalone run as a resumable task and reopens its associated environment', () => {
    expect(automationBackendSource).toContain('automation_session_target');
    expect(automationBackendSource).toContain('"--session-id".to_string()');
    expect(automationBackendSource).not.toContain('args.push("--no-session-persistence".to_string())');
    expect(automationBackendSource).toContain('session_id,status,title');
    expect(automationBackendSource).toContain('crate::track_managed_session(session_target.session_id.clone()).await');
    expect(automationBackendSource).toContain('Claude did not verify the durable session ID for this run');
    expect(packageJson.scripts['test:scheduler-resume-smoke']).toContain('BLACKBOX_SMOKE_RESUME=1');
    expect(schedulerSmokeSource).toContain('report.sessionId !== run.runId');
    expect(schedulerSmokeSource).toContain('report.transcriptVerified');
    expect(schedulerSmokeSource).toContain('resumeRun.sessionId === report.sessionId');
    expect(automationUiSource).toContain('continueAutomationRun(run)');
    expect(automationUiSource).toContain("new CustomEvent('blackbox:open-session'");
    expect(automationUiSource).toContain("t('automations.continueConversation')");
    expect(i18nSource).toContain("'automations.continueConversation': '继续这条任务对话'");
    expect(i18nSource).toContain("'automations.continueConversation': 'Continue this task'");
  });

  it('kills timed-out runs and recovers interrupted claims on startup', () => {
    expect(automationBackendSource).toContain('command.kill_on_drop(true)');
    expect(automationBackendSource).toContain('cancel_automation_run');
    expect(automationBackendSource).toContain('recover_interrupted_runs');
    expect(automationBackendSource).toContain('Interrupted because Black Box exited');
    expect(automationUiSource).toContain("t('automations.stop')");
  });

  it('snapshots before cleanup and exposes a recoverable worktree flow', () => {
    const cleanupSource = automationBackendSource.slice(
      automationBackendSource.indexOf('pub fn cleanup_automation_worktree'),
      automationBackendSource.indexOf('pub fn restore_automation_worktree'),
    );
    expect(automationBackendSource).toContain('cleanup_automation_worktree');
    expect(automationBackendSource).toContain('Refusing to clean a worktree outside Black Box storage');
    expect(cleanupSource).toContain('Refusing to clean without a recovery snapshot');
    expect(cleanupSource.indexOf('let snapshot = create_worktree_snapshot')).toBeLessThan(
      cleanupSource.indexOf('"worktree",\n        "remove"'),
    );
    expect(automationBackendSource).toContain('refs/blackbox/automation-snapshots');
    expect(automationBackendSource).toContain('restore_automation_worktree');
    expect(rustEntrySource).toContain('automations::restore_automation_worktree');
    expect(automationUiSource).toContain('bridge.restoreAutomationWorktree(run.runId)');
    expect(automationUiSource).toContain("t('automations.recoverySnapshot')");
    expect(automationUiSource).toContain("t('automations.cleanupConfirm')");
    expect(i18nSource).toContain("'automations.cleanupConfirm': '清理这次运行的独立工作树？");
    expect(i18nSource).toContain("'automations.cleanupConfirm': 'Clean this run’s isolated worktree?");
  });

  it('reviews cleaned runs directly from their verified recovery snapshot', () => {
    expect(automationBackendSource).toContain('ResolvedAutomationWorktreeReview::Snapshot');
    expect(automationBackendSource).toContain('collect_snapshot_review');
    expect(automationBackendSource).toContain('collect_snapshot_file_diff');
    expect(automationBackendSource).toContain('Stored run snapshot does not match recovery metadata');
    expect(automationUiSource).toContain("review.reviewSource === 'snapshot'");
    expect(automationUiSource).toContain("t('automations.reviewFromSnapshot')");
    expect(i18nSource).toContain("'automations.reviewFinalSnapshot': '清理前最终状态'");
    expect(i18nSource).toContain("'automations.reviewFinalSnapshot': 'Final state before cleanup'");
  });

  it('retains managed worktrees with a configurable fail-closed cleanup policy', () => {
    expect(automationBackendSource).toContain('automation_preferences');
    expect(automationBackendSource).toContain('DEFAULT_WORKTREE_RETENTION_LIMIT');
    expect(automationBackendSource).toContain('managed_worktree_retention_candidates');
    expect(automationBackendSource).toContain('record.status == "ARCHIVED" && record.branch_name.is_none()');
    expect(automationBackendSource).toContain('cleanup_automation_worktree(run_id.clone())');
    expect(rustEntrySource).toContain('automations::get_automation_preferences');
    expect(rustEntrySource).toContain('automations::set_automation_worktree_retention_limit');
    expect(automationUiSource).toContain('bridge.setAutomationWorktreeRetentionLimit(next)');
    expect(automationUiSource).toContain("t('automations.worktreeRetention')");
  });

  it('creates a verified branch in the managed worktree without mutating Local', () => {
    expect(automationBackendSource).toContain('worktree_branch_name TEXT');
    expect(automationBackendSource).toContain('create_automation_worktree_branch');
    expect(automationBackendSource).toContain('"check-ref-format"');
    expect(automationBackendSource).toContain('"switch", "-c"');
    expect(automationBackendSource).toContain('rollback_created_worktree_branch');
    expect(rustEntrySource).toContain('automations::create_automation_worktree_branch');
    expect(automationUiSource).toContain('bridge.createAutomationWorktreeBranch(run.runId, branchName)');
    expect(automationUiSource).toContain("t('automations.createBranchHere')");
    expect(i18nSource).toContain("'automations.createBranchHere': '在这里创建分支'");
    expect(i18nSource).toContain("'automations.createBranchHere': 'Create branch here'");
  });

  it('captures trigger-time source changes and copies only explicit ignored worktree inputs', () => {
    expect(automationBackendSource).toContain('refs/blackbox/automation-inputs');
    expect(automationBackendSource).toContain('Black Box input snapshot for automation run');
    expect(automationBackendSource).toContain('git_index_output(repository, &index_path, &["add", "-A", "--", "."]');
    expect(automationBackendSource).toContain('input_snapshot.base_commit');
    expect(automationBackendSource).toContain('"--exclude-from={}"');
    expect(automationBackendSource).toContain('"check-ignore", "--quiet", "--no-index"');
    expect(automationBackendSource).toContain('.create_new(true)');
    expect(automationBackendSource).toContain('Refusing to run without durable worktree metadata');
    expect(automationUiSource).toContain("t('automations.localInputsCaptured')");
    expect(automationUiSource).toContain("t('automations.includedIgnoredFiles')");
  });

  it('shows provider-native lead and auxiliary choices while persisting stable slots', () => {
    expect(automationUiSource).toContain('getModelDisplayOptions(editingProvider)');
    expect(automationUiSource).toContain("t('automations.mainModel')");
    expect(automationUiSource).toContain("t('automations.auxiliaryModel')");
    expect(automationUiSource).toContain('normalizeModelTier(definition.model)');
    expect(automationUiSource).toMatch(/createAutomationDraft\(\s*selectedModel,/);
    expect(automationUiSource).not.toMatch(/Opus 4|Sonnet 4|Haiku 4|1M/);
    expect(automationBackendSource).toContain('.unwrap_or("sonnet")');
    expect(automationBackendSource).toContain('.model_mappings');
    expect(automationBackendSource).toContain('has no model mapping for the {tier} tier');
    expect(automationBackendSource).toContain('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(automationBackendSource).toContain('&auxiliary_model');
  });

  it('creates scheduled targets without requiring users to type paths or conversation UUIDs', () => {
    expect(automationUiSource).toContain("import { open } from '@tauri-apps/plugin-dialog'");
    expect(automationUiSource).toContain('directory: true');
    expect(automationUiSource).toContain("t('automations.chooseFolder')");
    expect(automationUiSource).toContain('useSessionStore((state) => state.sessions)');
    expect(automationUiSource).toContain('session.cliResumeId');
    expect(automationUiSource).toContain("t('automations.selectConversation')");
    expect(automationUiSource).not.toContain('placeholder="/Users/you/project"');
  });

  it('falls back to local execution when the chosen project is not a Git repository', () => {
    expect(automationUiSource).toContain("bridge.runGitCommand(projectId, ['rev-parse', '--is-inside-work-tree'])");
    expect(automationUiSource).toContain('setWorktreeAvailable(available)');
    expect(automationUiSource).toContain("{ ...current, execution_environment: 'local' }");
    expect(automationUiSource).toContain('disabled={worktreeAvailable === false}');
    expect(automationUiSource).toContain("t('automations.nonGitHint')");
  });

  it('normalizes heartbeat tasks to local execution and the selected conversation cwd', () => {
    expect(automationUiSource).toContain("execution_environment: 'local'");
    expect(automationUiSource).toContain('prepareAutomationDefinitionForSave(');
    expect(automationUiSource).toContain('conversation?.projectDir ? [conversation.projectDir]');
    expect(automationUiSource).toContain('isAutomationDraftComplete(editing)');
  });

  it('localizes the scheduled-task surface instead of embedding one locale', () => {
    expect(automationUiSource).not.toMatch(/[\u3400-\u9fff]/);
    for (const key of [
      'automations.title',
      'automations.modelTier',
      'automations.trace',
      'automations.cleanupConfirm',
      'automations.recoverySnapshot',
      'automations.restoreWorktree',
      'automations.createBranchHere',
      'automations.createBranchHint',
      'automations.localInputsCaptured',
      'automations.includedIgnoredFiles',
      'automations.reviewFiles',
      'automations.reviewBinaryFile',
      'automations.reviewFromSnapshot',
      'automations.reviewFinalSnapshot',
      'automations.continueConversation',
      'automations.restoreAndContinue',
      'automations.chooseFolder',
      'automations.selectConversation',
      'automations.nonGitHint',
      'automations.launchAtLogin',
      'automations.launchAtLoginHint',
      'automations.worktreeRetention',
      'automations.worktreeRetentionHint',
    ]) {
      expect(i18nSource.match(new RegExp(`'${key.replace('.', '\\.')}'`, 'g'))).toHaveLength(2);
    }
  });

  it('pins model-calling smoke tests to Haiku or Sonnet and refuses Opus', () => {
    for (const source of [schedulerSmokeSource, toolUseSmokeSource, pluginSubagentSmokeSource]) {
      expect(source).toContain("item.tier === 'haiku'");
      expect(source).not.toContain("item.tier === 'opus'");
      expect(source).toMatch(/refuses? Opus/i);
    }
  });

  it('pins scheduled smoke runs to the isolated provider revision', () => {
    expect(schedulerSmokeSource).toContain('provider_id: activeProvider.id');
    expect(schedulerSmokeSource).toContain('provider_revision: Number(activeProvider.revision || 1)');
    expect(schedulerSmokeSource).not.toContain('provider_id: null');
  });

  it('gives each scheduled smoke a clean Claude profile and removes its transcripts', () => {
    expect(schedulerSmokeSource).toContain("const runClaudeConfig = join(runRoot, 'claude-config')");
    expect(schedulerSmokeSource).toContain('process.env.CLAUDE_CONFIG_DIR = runClaudeConfig');
    expect(schedulerSmokeSource).toContain('function cleanupRunConversations()');
    expect(schedulerSmokeSource).toContain("['projects', 'session-env', 'tasks', 'file-history']");
    expect(schedulerSmokeSource).toContain('cleanupRunConversations();');
  });
});
