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
const automationSessionMonitorSource = readFileSync(
  resolve(__dirname, '../components/automations/AutomationSessionMonitor.tsx'),
  'utf-8',
);
const chatPanelSource = readFileSync(
  resolve(__dirname, '../components/chat/ChatPanel.tsx'),
  'utf-8',
);
const inputBarSource = readFileSync(
  resolve(__dirname, '../components/chat/InputBar.tsx'),
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
const bundledScheduleSkillSource = readFileSync(
  resolve(__dirname, '../../src-tauri/resources/blackbox-schedule/SKILL.md'),
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
  it('keeps scheduled self-inspection read-only and exposes the active run identity', () => {
    expect(automationBackendSource).toContain('SQLITE_OPEN_READ_ONLY');
    expect(automationBackendSource).toContain('PRAGMA query_only=ON');
    expect(automationBackendSource).toContain('get_automation_read_only');
    expect(automationBackendSource).toContain('list_automation_runs_read_only');
    expect(automationBackendSource).toContain('BLACKBOX_AUTOMATION_ID');
    expect(automationBackendSource).toContain('BLACKBOX_AUTOMATION_RUN_ID');
    expect(automationBackendSource).toContain('BLACKBOX_AUTOMATION_TRIGGER');
    expect(automationBackendSource).toContain('"scheduled"');
    expect(automationBackendSource).toContain('"manual"');
    expect(automationBackendSource).toContain('"filesystem"');
    expect(automationBackendSource).toContain('"allowWrite"');
    expect(automationBackendSource).toContain('"--add-dir"');
    expect(automationBackendSource).toContain('data_write_subdirectories');
    expect(automationBackendSource).toContain('prepare_automation_write_paths');
  });

  it('keeps the macOS app resident when the red close button hides the window', () => {
    expect(rustEntrySource).toContain('WindowEvent::CloseRequested');
    expect(rustEntrySource).toContain('api.prevent_close();');
    expect(rustEntrySource).toContain('window.hide()');
    const closePath = rustEntrySource.split('WindowEvent::CloseRequested')[1]
      ?.split('.setup(|app|')[0] ?? '';
    expect(closePath).not.toContain('graceful_stop_all_sessions_inner');
    expect(closePath).not.toContain('app.exit(0)');
    expect(rustEntrySource).toContain('TrayIconBuilder::with_id("blackbox-menu-bar")');
    expect(rustEntrySource).toContain('"blackbox-show"');
    expect(rustEntrySource).toContain('"blackbox-quit"');
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

  it('keeps the macOS WebView alive while the window is occluded', () => {
    for (const config of [tauriConfig, tauriDevConfig]) {
      expect(config.app.windows[0].backgroundThrottling).toBe('disabled');
    }
  });

  it('distinguishes closing the window from explicitly quitting the app', () => {
    expect(i18nSource).toContain('关闭窗口后 Black Box 继续在后台调度');
    expect(i18nSource).toContain('Closing the window keeps Black Box scheduling in the background');
    expect(i18nSource).toContain('仅明确退出应用时停止');
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
    expect(automationUiSource).not.toContain('if (standalone) await bridge.markAllAutomationRunsRead()');
    expect(automationUiSource).toContain("t('automations.markAllRead')");
    expect(sidebarSource).toContain("'data-testid': 'scheduled-button'");
  });

  it('separates scheduled result severity from read state', () => {
    expect(automationBackendSource).toContain("status='SUCCEEDED'");
    expect(automationBackendSource).toContain("status='NEEDS_ATTENTION'");
    expect(automationBackendSource).toContain('::automation-needs-attention{');
    expect(automationBackendSource).toContain('migrate_legacy_run_statuses');
    expect(automationUiSource).toContain("case 'SUCCEEDED':");
    expect(automationUiSource).toContain("case 'NEEDS_ATTENTION':");
    expect(automationUiSource).toContain('isUnreadAutomationResult(run)');
    expect(i18nSource).toContain("'automations.status.succeeded': '已完成'");
    expect(i18nSource).toContain("'automations.status.needsAttention': '已完成 · 待裁决'");
  });

  it('keeps recent-run status, unread state, and timestamp in aligned non-wrapping slots', () => {
    expect(automationUiSource).toContain('grid-cols-[minmax(0,1fr)_max-content]');
    expect(automationUiSource).toContain('flex shrink-0 items-center justify-end gap-2 whitespace-nowrap');
    expect(automationUiSource).toContain('flex shrink-0 items-center justify-end gap-3 whitespace-nowrap');
    expect(automationUiSource).toContain('whitespace-nowrap text-right text-[10px] tabular-nums');
  });

  it('links failed scheduled runs to auditable retries and presents successful recovery', () => {
    expect(automationBackendSource).toContain('pub fn retry_automation_run');
    expect(automationBackendSource).toContain("status='RECOVERED'");
    expect(automationBackendSource).toContain('retry_of_run_id');
    expect(automationBackendSource).toContain('recovered_by_run_id');
    expect(rustEntrySource).toContain('automations::retry_automation_run');
    expect(automationUiSource).toContain('bridge.retryAutomationRun(runId)');
    expect(automationUiSource).toContain("case 'RECOVERED':");
    expect(i18nSource).toContain("'automations.status.recovered': '已完成 · 已恢复'");
  });

  it('reconciles committed completion receipts without rerunning finished work', () => {
    expect(automationBackendSource).toContain('AutomationCompletionProbe');
    expect(automationBackendSource).toContain('probe_completion_receipt');
    expect(automationBackendSource).toContain('reconcile_failed_completion_probes');
    expect(automationBackendSource).toContain('completion-receipt:');
    expect(automationBackendSource).toContain('base_directory == "automation_data"');
    expect(automationBackendSource).toContain('json_matches_reference');
    expect(automationBackendSource).toContain('required_absent_relative_paths');
    expect(automationBackendSource).toContain("status='RECOVERED'");
    expect(i18nSource).toContain('后续完成凭证已确认');
  });

  it('ships only the generic scheduling skill in the public app', () => {
    expect(tauriConfig.bundle.resources['resources/blackbox-schedule']).toBe('blackbox-schedule');
    expect(Object.keys(tauriConfig.bundle.resources)).toHaveLength(3);
  });

  it('makes scheduled write scope and post-save smoke part of the creation contract', () => {
    expect(bundledScheduleSkillSource).toContain('"data_write_subdirectories": []');
    expect(bundledScheduleSkillSource).toContain('Resolve the write scope before upsert');
    expect(bundledScheduleSkillSource).toContain('smallest common project directory');
    expect(bundledScheduleSkillSource).toContain('Delete the smoke task');
    expect(automationBackendSource).toContain('<automation_result_contract>');
    expect(automationBackendSource).toContain('::automation-needs-attention{');
    expect(automationBackendSource).toContain('automation_completion_recovery_prompt');
    expect(automationBackendSource).toContain('automation_needs_completion_recovery');
    expect(automationBackendSource).toContain('AUTOMATION_COMPLETION_RECOVERY_LIMIT: usize = 3');
    expect(automationBackendSource).toContain('for attempt in 1..=AUTOMATION_COMPLETION_RECOVERY_LIMIT');
    expect(automationBackendSource).toContain('recover_automation_completion(');
    expect(automationBackendSource).toContain('"--resume".to_string()');
    expect(automationBackendSource).toContain('::automation-failed{');
    expect(automationBackendSource).toContain('automation_reported_failure');
    expect(automationBackendSource).toContain('Never return a directive by itself');
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
    expect(automationOutputSource).toContain("const ATTENTION_DIRECTIVE = '::automation-needs-attention{'");
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

  it('keeps a running scheduled conversation visible and prevents a concurrent resume', () => {
    expect(rustEntrySource).toContain('automations::list_active_automation_sessions');
    expect(automationBackendSource).toContain('pub fn list_active_automation_sessions()');
    expect(automationBackendSource).toContain("r.status = 'RUNNING'");
    expect(appSource).toContain('<AutomationSessionMonitor />');
    expect(automationSessionMonitorSource).toContain('bridge.listActiveAutomationSessions()');
    expect(automationSessionMonitorSource).toContain('bridge.loadSession(session.path)');
    expect(automationSessionMonitorSource).toContain('parseSessionMessages(rawMessages)');
    expect(automationSessionMonitorSource).toContain('terminalSettles');
    expect(automationSessionMonitorSource).toContain('terminalChatStatus(finished.status)');
    expect(chatPanelSource).toContain('data-testid="automation-session-banner"');
    expect(chatPanelSource).toContain("t('automations.chatRunning')");
    expect(inputBarSource).toContain('activeBySession.has(tabId)');
    expect(inputBarSource).toContain('Boolean(activeAutomation)');
    expect(i18nSource).toContain("'automations.chatSendLocked'");
  });

  it('fails closed when a cron omits its terminal receipt or skips final Agent synthesis', () => {
    expect(automationBackendSource).toContain('Scheduled task ended without the required user-facing report and final result directive');
    expect(automationBackendSource).toContain("the run ended without a final synthesis");
    expect(automationBackendSource).toContain('last_main_assistant_event');
    expect(automationBackendSource).toContain('last_agent_completion_event');
    expect(automationBackendSource).toContain('definition.kind == "cron"');
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

  it('inherits the three user system defaults while retaining optional per-task model overrides', () => {
    expect(automationUiSource).toContain('getModelDisplayOptions(defaultProvider)');
    expect(automationUiSource).not.toContain('editingProvider');
    expect(automationUiSource).toContain("t('automations.mainModel')");
    expect(automationUiSource).toContain("t('automations.auxiliaryModel')");
    expect(automationUiSource).toContain('normalizeModelTier(definition.model)');
    expect(automationUiSource).toContain("t('automations.useSystemDefault')");
    expect(automationUiSource).toMatch(/createAutomationDraft\(\s*workingDirectory/);
    expect(automationUiSource).not.toMatch(/Opus 4|Sonnet 4|Haiku 4|1M/);
    expect(automationBackendSource).toContain('providers.default_main_model.clone()');
    expect(automationBackendSource).toContain('providers.default_auxiliary_model.clone()');
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
      'automations.status.succeeded',
      'automations.status.needsAttention',
      'automations.status.recovered',
      'automations.retry',
      'automations.retrying',
      'automations.retryOf',
      'automations.recoveredSummary',
      'automations.recoveredDetail',
      'automations.markAllRead',
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

  it('launches scheduled work like a normal new conversation without task credentials', () => {
    expect(schedulerSmokeSource).not.toContain('provider_id: activeProvider.id');
    expect(schedulerSmokeSource).not.toContain('provider_revision: Number(activeProvider.revision || 1)');
    expect(automationBackendSource).toContain('providers.default_api');
    expect(automationUiSource).toContain('configured.providers.find(');
    expect(automationUiSource).not.toContain('SYSTEM_API_ID');
    expect(automationUiSource).not.toContain('checkClaudeAuth()');
    expect(automationBackendSource).toContain('System Claude Login has been retired');
    expect(automationBackendSource).toContain('migrate_legacy_provider_index_bindings');
    expect(automationBackendSource).toContain('migrate_legacy_definition_provider_bindings');
    expect(automationBackendSource).toContain('crate::resolve_claude_sdk_runtime()');
    const scheduledInvoke = automationBackendSource.split('async fn invoke_claude(')[1]
      ?.split('fn parse_result_directive(')[0] || '';
    expect(scheduledInvoke).not.toContain('find_claude_binary()');
    expect(automationUiSource).not.toContain("t('automations.providerPinned')");
    expect(i18nSource).not.toContain("'automations.providerPinned'");
  });

  it('gives each scheduled smoke a clean Claude profile and removes its transcripts', () => {
    expect(schedulerSmokeSource).toContain("const runClaudeConfig = join(runRoot, 'claude-config')");
    expect(schedulerSmokeSource).toContain('process.env.CLAUDE_CONFIG_DIR = runClaudeConfig');
    expect(schedulerSmokeSource).toContain('process.env.BLACKBOX_CLAUDE_CONFIG_DIR = runClaudeConfig');
    expect(schedulerSmokeSource).toContain('function cleanupRunConversations()');
    for (const conversationArtifact of [
      'projects',
      'sessions',
      'session-env',
      'shell-snapshots',
      'tasks',
      'file-history',
      'history.jsonl',
      'blackbox_session_names.json',
    ]) {
      expect(schedulerSmokeSource).toContain(`'${conversationArtifact}'`);
    }
    expect(schedulerSmokeSource).toContain('cleanupRunConversations();');
    expect(schedulerSmokeSource).toContain('report.conversationArtifactsDeleted =');
    expect(schedulerSmokeSource).toContain('report.testArtifactsDeleted =');
    expect(schedulerSmokeSource).toContain('cleanupRunArtifacts();');
    expect(schedulerSmokeSource).toContain('data_write_subdirectories: [dataWriteSubdirectory]');
    expect(schedulerSmokeSource).toContain('report.dataMarkerVerified =');
  });
});
