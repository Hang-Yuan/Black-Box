import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('first-class extension center regressions', () => {
  it('opens as an independent main view from the sidebar', () => {
    const app = read('App.tsx');
    const sidebar = read('components/layout/Sidebar.tsx');
    const settings = read('stores/settingsStore.ts');

    expect(settings).toContain("export type MainView = 'chat' | 'extensions' | 'automations' | 'taskCenter'");
    expect(sidebar).toContain('data-testid="extensions-button"');
    expect(sidebar).toContain("setMainView('extensions')");
    expect(app).toContain("mainView === 'extensions'");
    expect(app).toContain('<ExtensionCenter />');
  });

  it('uses real management surfaces for all six extension types', () => {
    const center = read('components/extensions/ExtensionCenter.tsx');
    const agents = read('components/extensions/AgentCatalog.tsx');
    const workflows = read('components/extensions/WorkflowCatalog.tsx');
    const hooks = read('components/extensions/HookCatalog.tsx');
    const settings = read('components/settings/SettingsPanel.tsx');
    const secondary = read('components/layout/SecondaryPanel.tsx');
    expect(center).toContain('<PluginsTab standalone />');
    expect(center).toContain('<SkillsCatalog />');
    expect(center).toContain('<WorkflowCatalog />');
    expect(center).toContain('<McpTab />');
    expect(center).toContain('<AgentCatalog />');
    expect(center).toContain('<HookCatalog />');
    expect(center).toContain('extension-tab-');
    expect(center).not.toContain('extensions.capability.');
    expect(agents).toContain('bridge.listAgentDefinitions');
    expect(center).toContain("setSecondaryTab('files')");
    expect(agents).toContain("setSecondaryTab('files')");
    expect(workflows).toContain("setSecondaryTab('files')");
    expect(hooks).toContain("setSecondaryTab('files')");
    expect(hooks).toContain('bridge.listHookDefinitions');
    expect(hooks).toContain('bridge.createHookDefinition');
    expect(hooks).toContain('data-testid="hook-create-form"');
    expect(settings).not.toContain('<McpTab />');
    expect(settings).not.toContain('<PluginsTab />');
    expect(settings).not.toContain('<AutomationsTab />');
    expect(secondary).not.toContain('SkillsPanel');
  });

  it('surfaces built-in and configured hooks and writes new hooks atomically', () => {
    const hooks = read('components/extensions/HookCatalog.tsx');
    const backend = read('../src-tauri/src/lib.rs');
    const timeHook = read('../src-tauri/src/time_context_hook.rs');
    expect(backend).toContain('built-in:UserPromptSubmit:time-context');
    expect(backend).toContain('scan_hook_tree');
    expect(backend).toContain('async fn create_hook_definition');
    expect(backend).toContain('atomic_write_bytes(&path, &encoded, "Claude Hook settings")');
    expect(timeHook).toContain('"additionalContext"');
    expect(timeHook).toContain('Local::now()');
    expect(hooks).toContain("'command', 'http', 'prompt', 'agent', 'mcp_tool'");
  });

  it('guards Hook mutations and does not offer fake per-Hook or source switches', () => {
    const hooks = read('components/extensions/HookCatalog.tsx');
    const bridge = read('lib/tauri-bridge.ts');
    const backend = read('../src-tauri/src/lib.rs');

    expect(bridge).toContain("invoke<HookDefinitionInfo[]>('list_hook_definitions', { cwd })");
    expect(bridge).toContain("invoke<HookDefinitionInfo>('create_hook_definition', { cwd, request })");
    expect(bridge).toContain("invoke<HookDefinitionInfo>('update_hook_definition', { cwd, guard: hook, request })");
    expect(bridge).toContain("invoke<void>('delete_hook_definition', { cwd, guard: hook })");
    expect(bridge).toContain('sourceDigest: string;');
    expect(bridge).toContain('handlerFingerprint: string;');

    expect(hooks).toContain('const loadGeneration = useRef(0);');
    expect(hooks).toContain('const generation = ++loadGeneration.current;');
    expect(hooks).toContain('if (loadGeneration.current !== generation || workingDirectoryRef.current !== directory) return;');
    expect(hooks).toContain('bridge.updateHookDefinition(editingHook, draft, operationDirectory || undefined)');
    expect(hooks).toContain('bridge.deleteHookDefinition(deleteTarget, operationDirectory || undefined)');
    expect(hooks).toContain('hook.disabledBySource &&');
    expect(hooks).not.toContain('type="checkbox"');
    expect(hooks).not.toContain('role="switch"');
    expect(hooks).not.toContain('toggleHook');
    expect(hooks).not.toContain('toggleSource');
    expect(bridge).not.toContain('toggle_hook_definition');
    expect(backend).not.toContain('async fn toggle_hook_definition');

    expect(backend).toContain('source_digest: String,');
    expect(backend).toContain('handler_fingerprint: String,');
    expect(backend).toContain('fn hook_handler_fingerprint(');
    expect(backend).toContain('if source_digest != guard.source_digest');
    expect(backend).toContain('!= guard.handler_fingerprint');
    expect(backend).toContain('verify_hook_source_unchanged(&path, &source_digest)?');
  });

  it('builds the plugin directory from real marketplace metadata instead of fixture cards', () => {
    const plugins = read('components/settings/PluginsTab.tsx');
    const catalog = read('lib/plugin-catalog.ts');
    const backend = read('../src-tauri/src/plugin_manager.rs');
    expect(plugins).toContain('data-testid="installed-plugin-strip"');
    expect(plugins).toContain('data-testid="plugin-directory-grid"');
    expect(plugins).toContain('plugin-audience-');
    expect(plugins).toContain('plugin-category-filter');
    expect(plugins).toContain('data-testid="plugin-install-preview"');
    expect(plugins).toContain("data-plugin-loaded={loaded ? 'true' : 'false'}");
    expect(plugins).toContain('data-testid="plugin-catalog-error"');
    expect(plugins).toContain('catalogDetailText');
    expect(catalog).toContain("export type PluginAudience = 'public' | 'personal'");
    expect(catalog).toContain('right.installCount');
    expect(backend).toContain('enrich_plugin_records_from_manifest');
    expect(backend).toContain('MARKETPLACE_MANIFEST_LIMIT');
  });

  it('keeps the native extension smoke responsible for CLI discovery', () => {
    const smoke = read('../scripts/extension-navigation-smoke.mjs');
    expect(smoke).toContain('pluginCatalogResolvesClaudeCli');
    expect(smoke).toContain('data-plugin-loaded="true"');
    expect(smoke).toContain('Claude CLI not found');
  });

  it('returns to chat when a conversation or project draft is selected', () => {
    const conversations = read('components/conversations/ConversationList.tsx');
    expect(conversations.match(/setMainView\('chat'\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
