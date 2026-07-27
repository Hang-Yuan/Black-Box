import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const main = read('main.tsx');
const pet = read('components/desktop-pet/DesktopPet.tsx');
const petCss = read('components/desktop-pet/DesktopPet.css');
const avatar = read('components/desktop-pet/PetAvatar.tsx');
const stateBridge = read('components/desktop-pet/DesktopPetStateBridge.tsx');
const setting = read('components/settings/DesktopPetSetting.tsx');
const settingsPanel = read('components/settings/SettingsPanel.tsx');
const settingsStore = read('stores/settingsStore.ts');
const presets = read('lib/desktop-pet-presets.ts');
const bridge = read('lib/tauri-bridge.ts');
const rust = read('../src-tauri/src/desktop_pet.rs');
const rustEntry = read('../src-tauri/src/lib.rs');
const capability = read('../src-tauri/capabilities/default.json');
const tauriConfig = read('../src-tauri/tauri.conf.json');
const testHarness = read('../scripts/blackbox-cli.mjs');

describe('desktop pet integration regressions', () => {
  it('keeps the companion in an isolated WebView entry path', () => {
    expect(main).toContain('isDesktopPetWindow');
    expect(main).toContain('<DesktopPet />');
    expect(main).toContain('<DesktopPetStateBridge />');
    expect(stateBridge).toContain("emitTo(PET_WINDOW_LABEL, DESKTOP_PET_STATE_EVENT");
    expect(stateBridge).toContain('deriveDesktopPetState');
  });

  it('uses a transparent parametric companion with drag, focus, and close controls', () => {
    expect(pet).toContain('startDragging()');
    expect(pet).toContain('bridge.focusMainWindow()');
    expect(pet).toContain('bridge.setDesktopPetEnabled(false)');
    expect(pet).toContain('<PetAvatar');
    expect(pet).toContain('data-preset={appearance.presetId}');
    expect(avatar).toContain('data-body={design.body}');
    expect(avatar).toContain('<Accessory accessory={design.accessory} />');
    expect(petCss).toContain('background: transparent !important');
    expect(petCss).toContain('.desktop-pet--waiting');
    expect(petCss).toContain('.desktop-pet--error');
  });

  it('persists the toggle and position while clamping to available displays', () => {
    expect(rust).toContain('desktop-pet.json');
    expect(rust).toContain('clamp_position_to_monitors');
    expect(rust).toContain('available_monitors()');
    expect(rust).toContain('WindowEvent::Moved(position)');
    expect(rust).toContain('.always_on_top(true)');
    expect(rust).toContain('.visible_on_all_workspaces(true)');
    expect(rust).toContain('.skip_taskbar(true)');
    expect(rust).toContain('.decorations(false)');
    expect(rust).toContain('.transparent(true)');
    expect(tauriConfig).toContain('"macOSPrivateApi": true');
  });

  it('handles a companion close before the main application shutdown path', () => {
    const petGuard = rustEntry.indexOf('desktop_pet::handle_window_event(window, event)');
    const shutdown = rustEntry.indexOf('graceful_stop_all_sessions_inner', petGuard);
    expect(petGuard).toBeGreaterThan(-1);
    expect(shutdown).toBeGreaterThan(petGuard);
    expect(capability).toContain('"desktop-pet"');
  });

  it('exposes a dedicated settings tab, twenty presets, and the custom maker', () => {
    expect(settingsStore).toContain("'desktopPet'");
    expect(settingsPanel).toContain("{ id: 'desktopPet', labelKey: 'settings.tab.desktopPet' }");
    expect(settingsPanel).toContain("activeTab === 'desktopPet'");
    expect(setting).toContain('testId="desktop-pet-toggle"');
    expect(setting).toContain('data-testid="desktop-pet-preset-grid"');
    expect(setting).toContain('data-testid="desktop-pet-maker"');
    expect(setting).toContain('data-testid="desktop-pet-apply-custom"');
    expect(presets).toContain('export const DESKTOP_PET_PRESETS');
    expect(setting).toContain('bridge.getDesktopPetStatus()');
    expect(setting).toContain('bridge.setDesktopPetEnabled(!enabled)');
    expect(setting).toContain('bridge.setDesktopPetAppearance');
    expect(bridge).toContain("invoke<DesktopPetStatus>('get_desktop_pet_status')");
    expect(bridge).toContain("invoke<DesktopPetStatus>('set_desktop_pet_enabled'");
    expect(bridge).toContain("invoke<DesktopPetStatus>('set_desktop_pet_appearance'");
    expect(rustEntry).toContain('desktop_pet::set_desktop_pet_appearance');
  });

  it('keeps native visual acceptance able to target the companion window directly', () => {
    expect(testHarness).toContain("const windowLabel = flags.window || 'main'");
    expect(testHarness).toContain('window_label: windowLabel');
    expect(testHarness).toContain('--window LABEL');
  });
});
