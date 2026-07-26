import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rust = readFileSync(resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');
const resolver = readFileSync(
  resolve(__dirname, '../../src-tauri/src/commands/cli_resolver.rs'),
  'utf8',
);
const protocol = readFileSync(
  resolve(__dirname, '../../src-tauri/src/protocol.rs'),
  'utf8',
);
const bridge = readFileSync(resolve(__dirname, '../lib/tauri-bridge.ts'), 'utf8');
const stream = readFileSync(resolve(__dirname, '../hooks/useStreamProcessor.ts'), 'utf8');

describe('selected Claude CLI as the SDK runtime', () => {
  it('health-checks version and the stream-json control contract before selection', () => {
    expect(resolver).toContain('pub fn probe_sdk_runtime(');
    expect(resolver).toContain('cli_cmd_with_timeout(path, &["--version"], 5)');
    expect(resolver).toContain('help.contains("--input-format")');
    expect(resolver).toContain('&["--permission-prompt-tool", "stdio", "--version"]');
    expect(resolver).toContain('pub fn resolve_sdk_runtime() -> Result<SdkRuntime, String>');
    expect(resolver).toContain('A user pin is fail-closed');
  });

  it('starts new and resumed sessions with one exact resolved runtime', () => {
    const start = rust.indexOf('async fn start_claude_session(');
    const end = rust.indexOf('\\n#[tauri::command]\\nasync fn send_stdin', start);
    const sessionStart = rust.slice(start, end);
    expect(sessionStart).toContain('let sdk_runtime = resolve_claude_sdk_runtime()?;');
    expect(sessionStart).toContain('let claude_bin = sdk_runtime.path.clone();');
    expect(sessionStart).toContain('"--print".to_string()');
    expect(sessionStart).not.toContain('"claude".to_string()');
    expect(sessionStart).not.toContain('"claude.cmd".to_string()');
    expect(sessionStart).toContain('cli_version: sdk_runtime.version');
    expect(sessionStart).toContain('sdk_capabilities: sdk_runtime.capabilities');
  });

  it('negotiates newer hook and subagent stream flags from the selected CLI', () => {
    expect(rust).toContain('sdk_runtime.capabilities.include_hook_events');
    expect(rust).toContain('args.push("--include-hook-events".to_string())');
    expect(rust).toContain('sdk_runtime.capabilities.forward_subagent_text');
    expect(rust).toContain('args.push("--forward-subagent-text".to_string())');
    expect(bridge).toContain('sdk_capabilities?: {');
    expect(bridge).toContain('permissionPromptStdio: boolean');
  });

  it('expires interactive cards when a modern SDK cancels its control request', () => {
    expect(protocol).toContain('ControlCancelRequest');
    expect(rust).toContain('Some("control_cancel_request")');
    expect(rust).toContain('"type": "blackbox_control_request_cancelled"');
    expect(stream).toContain("case 'blackbox_control_request_cancelled'");
    expect(stream).toContain("interactionState: 'expired'");
  });

  it('uses canonical identity and a real health probe before deleting an environment', () => {
    expect(resolver).toContain('fn same_cli_identity(');
    expect(resolver).toContain('probe_sdk_runtime(Path::new(&candidate)).is_ok()');
    expect(resolver).toContain('current_native_version_target_with_home');
    expect(resolver).toContain('canonical_target.parent() == Some(versions_root.as_path())');
  });

  it('keeps the frontend home-directory bridge backed by a registered native command', () => {
    expect(bridge).toContain("invoke<string>('get_home_dir')");
    expect(rust).toContain('fn get_home_dir() -> Result<String, String>');
    expect(rust).toMatch(/write_file_content,\s+get_home_dir,\s+copy_file,/);
  });
});
