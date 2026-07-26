import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const backend = readFileSync(resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');
const cliTab = readFileSync(resolve(__dirname, '../components/settings/CliTab.tsx'), 'utf8');
const bridge = readFileSync(resolve(__dirname, '../lib/tauri-bridge.ts'), 'utf8');
const sidebar = readFileSync(resolve(__dirname, '../components/layout/Sidebar.tsx'), 'utf8');
const settingsPanel = readFileSync(resolve(__dirname, '../components/settings/SettingsPanel.tsx'), 'utf8');
const resolver = readFileSync(
  resolve(__dirname, '../../src-tauri/src/commands/cli_resolver.rs'),
  'utf8',
);

describe('Claude CLI lifecycle regressions', () => {
  it('routes updates through the installation owner', () => {
    expect(backend).toContain('CliInstallMethod::Native => run_cli_owner_update(&path, &["update"])');
    expect(backend).toContain('"brew", &["upgrade", "--cask", "claude-code"]');
    expect(backend).toContain('"winget"');
    expect(backend).toContain('@anthropic-ai/claude-code@latest');
    expect(backend).toContain('This installation must be updated by its owner');
  });

  it('verifies the requested version and adopts a migrated native install', () => {
    expect(bridge).toContain("invoke<string>('update_claude_cli', { expectedVersion:");
    expect(cliTab).toContain('bridge.updateClaudeCli(cliLatestVersion || null)');
    expect(backend).toContain('reconcile_cli_after_update(');
    expect(backend).toContain('newest_healthy_cli_candidate');
    expect(backend).toContain('commands::cli_resolver::pin_cli(&best.path)?');
    expect(backend).toContain('CLI update did not reach the requested');
  });

  it('preflights persistent sessions, settles them with frontend state, and remains fail-closed', () => {
    expect(backend).toContain('async fn get_cli_update_blockers');
    expect(backend).toContain('CLI_UPDATE_BLOCKED_SESSIONS:{}');
    expect(backend).toContain('CLI_UPDATE_BLOCKED_AUTOMATION');
    expect(bridge).toContain("invoke<CliUpdateBlockers>('get_cli_update_blockers')");
    expect(cliTab).toContain('settleBackendProcessesForCliUpdate(blockers.activeSessionIds)');
    expect(cliTab).toContain("t('cli.confirmStopSessionsForUpdate')");
    expect(backend).toContain('.manage(CliMaintenanceState::default())');
    expect(backend).toContain('CLI_UPDATE_IN_PROGRESS.store(true');
  });

  it('shows source, release channel, auto-update state, and manual command', () => {
    expect(bridge).toContain("invoke<CliLifecycleInfo>('get_cli_lifecycle')");
    expect(cliTab).toContain("t('cli.installMethod')");
    expect(cliTab).toContain("t('cli.releaseChannel')");
    expect(cliTab).toContain("t('cli.autoUpdates')");
    expect(cliTab).toContain("t('cli.copyCommand')");
    expect(cliTab).toContain('lifecycle?.canUpdateInApp');
    expect(cliTab).toContain('bridge.reinstallClaudeCli()');
    expect(bridge).toContain("invoke<string>('reinstall_claude_cli')");
    expect(backend).toContain('&["install", "--force", channel]');
  });

  it('does not hide the update notice behind a constant false guard', () => {
    expect(cliTab).not.toContain('false && useSettingsStore.getState().cliUpdateAvailable');
    expect(cliTab).toContain('cliUpdateAvailable &&');
    expect(sidebar).toContain("openSettings(cliUpdateAvailable ? 'cli' : 'general')");
    expect(sidebar).toContain('bg-red-500');
    expect(settingsPanel).toContain("tab.id === 'cli' && cliUpdateAvailable");
  });

  it('injects live time context into every interactive and scheduled prompt', () => {
    expect(backend).toContain('"UserPromptSubmit"');
    expect(backend).toContain('"--time-context-hook"');
    expect(backend).toContain('pub fn run_time_context_hook()');
  });

  it('allows guarded deletion for app-owned and exact native-installer environments', () => {
    expect(cliTab).toContain('c.canDelete && !active && healthyCount > 1');
    expect(resolver).toContain('managed_native_delete_kind_with_home');
    expect(resolver).toContain('Switch to another healthy CLI before deleting this environment');
    expect(resolver).toContain('The last healthy CLI environment cannot be deleted');
    expect(resolver).toContain('This CLI is owned by an external package manager');
  });

  it('keeps the selected SDK runtime in Black Box-owned storage', () => {
    expect(resolver).toContain('home.join(".blackbox").join("cli-pin.json")');
    expect(resolver).not.toContain('join(".her")');
    expect(resolver).toContain('write_cli_pin(&pin_path, &pin)?');
    expect(resolver).toContain('an older compatibility file can');
  });

  it('confirms PATH mutation and rejects non-Claude executable targets', () => {
    expect(cliTab).toContain("t('cli.confirmInjectPath').replace('{path}', path)");
    expect(resolver).toContain('validate_cli_binary_path(Path::new(cli_path))?');
    expect(resolver).toContain('expected a Claude executable');
  });
});
