import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('macOS power assertion integration', () => {
  it('defaults to system wake while leaving display wake opt-in', () => {
    const store = read('stores/settingsStore.ts');
    expect(store).toContain('keepSystemAwake: true');
    expect(store).toContain('keepDisplayAwake: false');
    expect(store).toContain('setKeepSystemAwake');
    expect(store).toContain('setKeepDisplayAwake');
    expect(store).toContain('version: 13');
  });

  it('reconciles persisted settings through the native bridge on startup', () => {
    const app = read('App.tsx');
    const bridge = read('lib/tauri-bridge.ts');
    expect(app).toContain('bridge.setPowerAssertion(keepSystemAwake, keepDisplayAwake)');
    expect(app).toContain("blackbox:power-assertion-status");
    expect(app).toContain('bridge.getPowerAssertionStatus()');
    expect(bridge).toContain("invoke<PowerAssertionStatus>('set_power_assertion'");
    expect(bridge).toContain("invoke<PowerAssertionStatus>('get_power_assertion_status')");
  });

  it('uses native IOKit assertions and releases them during shutdown', () => {
    const rust = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
    expect(rust).toContain('PreventUserIdleSystemSleep');
    expect(rust).toContain('PreventUserIdleDisplaySleep');
    expect(rust).toContain('IOPMAssertionCreateWithName');
    expect(rust).toContain('IOPMAssertionRelease');
    expect(rust).toContain('power_assertions.release_all()');
  });

  it('exposes separate accessible system and display controls in General settings', () => {
    const general = read('components/settings/GeneralTab.tsx');
    expect(general).toContain('data-testid="power-settings-section"');
    expect(general).toContain('testId="keep-system-awake-toggle"');
    expect(general).toContain('testId="keep-display-awake-toggle"');
    expect(general).toContain('disabled={!keepSystemAwake}');
    expect(general).toContain('data-testid="power-assertion-effective-status"');
    expect(general).toContain('data-testid="power-assertion-error"');
    expect(general).toContain('bridge.getPowerAssertionStatus()');
  });
});
