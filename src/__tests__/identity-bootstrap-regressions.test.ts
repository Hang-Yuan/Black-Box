import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const backend = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
const main = readFileSync(resolve(root, '../src-tauri/src/main.rs'), 'utf8');
const bootstrap = readFileSync(
  resolve(root, '../src-tauri/src/identity_bootstrap.rs'),
  'utf8',
);
const bridge = readFileSync(resolve(root, 'lib/tauri-bridge.ts'), 'utf8');
const settings = readFileSync(resolve(root, 'components/settings/GeneralTab.tsx'), 'utf8');

describe('private identity bootstrap regressions', () => {
  it('registers one native SessionStart hook for every supported lifecycle source', () => {
    expect(backend).toContain('"SessionStart"');
    expect(backend).toContain('"startup|resume|clear|compact|fork"');
    expect(backend).toContain('"--identity-bootstrap-hook"');
    expect(main).toContain('blackbox_lib::run_identity_bootstrap_hook()');
  });

  it('keeps identity runtime state private and integrity checked', () => {
    expect(bootstrap).toContain('client_runtime::private_claude_config_dir()?.join("identity-bootstrap")');
    expect(bootstrap).toContain('Identity snapshot changed');
    expect(bootstrap).toContain('BLACKBOX_IDENTITY_BOOTSTRAP_V1');
    expect(bootstrap).not.toContain('dirs::home_dir()?.join(".claude")');
    expect(bootstrap).toContain('client_runtime::uses_system_environment()?');
    expect(bootstrap).toContain('"suppressOutput": true');
  });

  it('exposes explicit snapshot and startup skill import controls', () => {
    expect(bridge).toContain("invoke<IdentityBootstrapStatus>('configure_identity_bootstrap'");
    expect(settings).toContain('bridge.configureIdentityBootstrap(');
    expect(settings).toContain('data-testid="identity-bootstrap-settings"');
    expect(settings).toContain('testId="identity-bootstrap-toggle"');
    expect(settings).toContain("extensions: ['md', 'txt']");
    expect(settings).toContain("extensions: ['md']");
  });
});
