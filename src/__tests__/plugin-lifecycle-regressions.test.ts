import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const backend = readFileSync(resolve(__dirname, '../../src-tauri/src/plugin_manager.rs'), 'utf8');
const libBackend = readFileSync(resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');
const bridge = readFileSync(resolve(__dirname, '../lib/tauri-bridge.ts'), 'utf8');
const store = readFileSync(resolve(__dirname, '../stores/pluginStore.ts'), 'utf8');
const ui = readFileSync(resolve(__dirname, '../components/settings/PluginsTab.tsx'), 'utf8');
const extensionCenter = readFileSync(resolve(__dirname, '../components/extensions/ExtensionCenter.tsx'), 'utf8');
const smoke = readFileSync(resolve(__dirname, '../../scripts/plugin-subagent-smoke.mjs'), 'utf8');
const schedulerSmoke = readFileSync(resolve(__dirname, '../../scripts/scheduler-smoke.mjs'), 'utf8');

describe('Claude plugin lifecycle regressions', () => {
  it('routes the complete plugin lifecycle through Claude CLI commands', () => {
    for (const command of [
      'list_plugins',
      'diagnose_plugins',
      'plugin_details',
      'install_plugin',
      'set_plugin_enabled',
      'update_plugin',
      'uninstall_plugin',
      'add_plugin_marketplace',
      'update_plugin_marketplace',
      'remove_plugin_marketplace',
      'validate_plugin',
    ]) {
      expect(libBackend).toContain(`plugin_manager::${command}`);
      expect(bridge).toContain(`'${command}'`);
    }
    expect(backend).toContain('kill_on_drop(true)');
    expect(backend).toContain('BLACKBOX_DEV_ISOLATION_ROOT');
  });

  it('reports strict validation, deterministic content identity, source pins, and only runtime-relevant conflicts', () => {
    expect(backend).toContain('PluginDiagnosticsReport');
    expect(backend).toContain('fingerprint_validated_plugin_tree');
    expect(backend).toContain('PluginSourcePinStatus');
    expect(backend).toContain('PluginConflictKind::NamespaceCollision');
    expect(backend).toContain('PluginConflictKind::DuplicateScope');
    expect(backend).toContain('PluginConflictKind::McpEndpointOverlap');
    expect(backend).toContain('signature_verification_available: false');
    expect(bridge).toContain('PluginDiagnosticsReport');
    expect(store).toContain('diagnosticsLoading');
    expect(ui).toContain('data-testid="plugin-security-diagnostics"');
    expect(ui).toContain('data-testid="plugin-signature-disclaimer"');
    expect(ui).toContain('plugins.diagnostics.signatureUnavailable');
  });

  it('keeps managed plugins read-only and project/local scopes cwd-bound', () => {
    expect(backend).toContain('PluginScope::Managed');
    expect(backend).toContain('Managed plugins are read-only');
    expect(backend).toContain('Project/local plugin scope requires a working directory');
    expect(ui).toContain("plugin.scope !== 'managed'");
    expect(ui).toContain("installScope === 'project' || installScope === 'local'");
  });

  it('exposes Plugins only through the first-class extension center with destructive confirmations', () => {
    expect(extensionCenter).toContain("{ id: 'plugins', labelKey: 'extensions.plugins' }");
    expect(extensionCenter).toContain("section === 'plugins' && <PluginsTab standalone />");
    expect(ui).toContain('plugins.trustWarning');
    expect(ui).toContain('plugins.uninstallConfirm');
    expect(ui).toContain('plugins.removeMarketplaceConfirm');
    expect(ui).toContain('data-testid="plugin-install-preview"');
    expect(ui).toContain('plugins.installRisk');
    expect(ui).toContain('plugins.confirmInstall');
    expect(ui).toContain('const [keepData, setKeepData] = useState(true)');
  });

  it('clears busy state and surfaces errors after every mutation', () => {
    expect(store).toContain("set({ busyKey: key, error: '' })");
    expect(store).toContain('set({ error: message(error) })');
    expect(store).toContain('set({ busyKey: null })');
  });

  it('proves Skill to Agent to Write without accepting a main-agent write', () => {
    expect(smoke).toContain("'--allowedTools', 'Skill,Agent,Write'");
    expect(smoke).toContain('subagentWriteResultObserved');
    expect(smoke).toContain('agentToolResultObserved');
    expect(smoke).toContain('agentLifecycleObserved');
    expect(smoke).toContain('!report.mainAgentWriteObserved');
    expect(smoke).toMatch(/refuses Opus\/Fable models/i);
  });

  it('verifies the same plugin subagent chain on a true scheduled run', () => {
    expect(schedulerSmoke).toContain("BLACKBOX_SMOKE_PLUGIN_SUBAGENT === '1'");
    expect(schedulerSmoke).toContain("['Skill', 'Agent', 'Write']");
    expect(schedulerSmoke).toContain("event.agentDepth === 1");
    expect(schedulerSmoke).toContain("event.agentType === 'blackbox-trace-plugin:trace-worker'");
    expect(schedulerSmoke).toContain('Scheduled Write was not attributed to the plugin subagent');
  });
});
