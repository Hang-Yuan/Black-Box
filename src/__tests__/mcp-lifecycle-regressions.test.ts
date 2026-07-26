import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const backend = readFileSync(resolve(__dirname, '../../src-tauri/src/mcp_manager.rs'), 'utf8');
const libBackend = readFileSync(resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');
const bridge = readFileSync(resolve(__dirname, '../lib/tauri-bridge.ts'), 'utf8');
const store = readFileSync(resolve(__dirname, '../stores/mcpStore.ts'), 'utf8');
const ui = readFileSync(resolve(__dirname, '../components/settings/McpTab.tsx'), 'utf8');

describe('MCP lifecycle regressions', () => {
  it('resolves Claude config dir and all three scopes in the backend', () => {
    expect(backend).toContain('client_runtime::claude_config_dir()');
    expect(backend).toContain('Self::Local => 3');
    expect(backend).toContain('Self::Project => 2');
    expect(backend).toContain('Self::User => 1');
    expect(backend).toContain('enabledMcpjsonServers');
    expect(backend).toContain('disabledMcpjsonServers');
  });

  it('keeps pending project servers out of strict MCP scratch configs', () => {
    expect(backend).toContain('PendingApproval | McpConnectionStatus::Rejected');
    expect(libBackend).toContain('mcp_manager::effective_mcp_servers(cwd)');
    expect(libBackend).toContain('build_mcp_scratch_config(');
    expect(libBackend).not.toContain('"blackbox_plan".to_string()');
    expect(libBackend).not.toContain('"blackbox_web".to_string()');
  });

  it('delegates OAuth credentials to Claude CLI instead of storing secrets', () => {
    expect(backend).toContain('OAuth client secrets must not be stored');
    expect(backend).toContain('&["mcp", "login", name.trim()]');
    expect(backend).toContain('&["mcp", "logout", name.trim()]');
    expect(ui).toContain("t('mcp.oauthTokenNote')");
  });

  it('exposes HTTP transport, scope, approvals, health, and runtime tool counts', () => {
    expect(bridge).toContain("invoke<McpServerRecord[]>('list_mcp_servers'");
    expect(ui).toContain('<option value="http">');
    expect(ui).toContain('<option value="project"');
    expect(ui).toContain("server.status === 'pendingApproval'");
    expect(store).toContain('recordRuntimeServers');
    expect(store).toContain('runtimeTools: [...new Set(tools)]');
    expect(store).toContain('const prefix = `mcp__${server.name}__`');
  });

  it('does not directly rewrite the home-level Claude JSON from the webview', () => {
    expect(store).not.toContain("`${home}/.claude.json`");
    expect(store).not.toContain('writeFileContent(path, JSON.stringify');
  });

  it('confirms before clearing Claude-owned OAuth login state', () => {
    expect(ui).toContain("t('mcp.confirmLogout')");
    expect(ui).toContain('await logoutServer(server.name, cwd)');
  });
});
