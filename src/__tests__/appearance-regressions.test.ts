import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACCENT_THEMES,
  SURFACE_THEMES,
  appearanceUsesDarkMode,
  applyAppearanceClasses,
  normalizeAccent,
  normalizeSurface,
} from '../lib/appearance';

const css = readFileSync(resolve(__dirname, '../App.css'), 'utf8');
const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');
const general = readFileSync(resolve(__dirname, '../components/settings/GeneralTab.tsx'), 'utf8');
const shell = readFileSync(resolve(__dirname, '../components/layout/AppShell.tsx'), 'utf8');
const store = readFileSync(resolve(__dirname, '../stores/settingsStore.ts'), 'utf8');
const messageBubble = readFileSync(resolve(__dirname, '../components/chat/MessageBubble.tsx'), 'utf8');
const userAvatar = readFileSync(resolve(__dirname, '../components/shared/UserAvatar.tsx'), 'utf8');
const chatPanel = readFileSync(resolve(__dirname, '../components/chat/ChatPanel.tsx'), 'utf8');
const providerCard = readFileSync(resolve(__dirname, '../components/settings/ProviderCard.tsx'), 'utf8');
const dragState = readFileSync(resolve(__dirname, '../lib/drag-state.ts'), 'utf8');
const i18n = readFileSync(resolve(__dirname, '../lib/i18n.ts'), 'utf8');

class FakeTokens {
  values = new Set<string>();
  add(...tokens: string[]) { tokens.forEach((token) => this.values.add(token)); }
  remove(...tokens: string[]) { tokens.forEach((token) => this.values.delete(token)); }
}

function cssVariables(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
  return Object.fromEntries(
    [...body.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
  );
}

function contrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.slice(1).match(/.{2}/g)!.map((value) => parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('appearance system regressions', () => {
  it('uses original Black Box work-state copy', () => {
    for (const inherited of ['摸鱼中', '划水中', '搬砖中', '找猫粮中', 'Procrastinating', 'Slacking off', 'Hauling bricks']) {
      expect(i18n).not.toContain(inherited);
    }
    expect(i18n).toContain("'chat.thinkingCycle.0': '读取上下文'");
    expect(i18n).toContain("'chat.thinkingCycle.16': '完成校验'");
  });
  it('keeps four surfaces and four accents as independent class dimensions', () => {
    expect(SURFACE_THEMES).toEqual(['graphite', 'midnight', 'paper', 'forest']);
    expect(ACCENT_THEMES).toEqual(['black', 'blue', 'purple', 'green']);
    const classes = new FakeTokens();
    applyAppearanceClasses(classes, 'purple', 'paper');
    expect(classes.values).toEqual(new Set(['accent-purple', 'surface-paper']));
    applyAppearanceClasses(classes, 'green', 'paper');
    expect(classes.values).toEqual(new Set(['accent-green', 'surface-paper']));
  });

  it('fails unknown persisted appearance values back to neutral graphite', () => {
    expect(normalizeAccent('unknown')).toBe('black');
    expect(normalizeSurface('unknown')).toBe('graphite');
    expect(appearanceUsesDarkMode('system', true)).toBe(true);
    expect(appearanceUsesDarkMode('system', false)).toBe(false);
  });

  it('boots appearance classes before React renders and keeps live updates in App', () => {
    expect(main.indexOf('bootstrapAppearance();')).toBeLessThan(main.indexOf('ReactDOM.createRoot'));
    expect(app).toContain('applyAppearanceClasses(document.documentElement.classList, colorTheme, surfaceTheme)');
  });

  it('persists the surface dimension through the current settings schema', () => {
    expect(store).toContain("export type SurfaceTheme = 'graphite' | 'midnight' | 'paper' | 'forest'");
    expect(store).toContain("surfaceTheme: 'graphite'");
    expect(store).toContain('version: 13');
    expect(store).toContain('if (version < 10)');
    expect(store).toContain('surfaceTheme: state.surfaceTheme');
  });

  it('ships complete light and dark surface tokens plus accent palettes', () => {
    for (const surface of SURFACE_THEMES) expect(css).toContain(`surface-${surface}`);
    for (const accent of ACCENT_THEMES) expect(css).toContain(`accent-${accent}`);
    expect(css).toContain('.dark.surface-midnight');
    expect(css).toContain('.dark.surface-paper');
    expect(css).toContain('.dark.surface-forest');
    expect(css).toContain('--surface-main-overlay');
  });

  it('keeps text and user bubbles WCAG-readable across all 32 explicit palettes', () => {
    const base = cssVariables('@theme');
    const darkBase = { ...base, ...cssVariables('.dark') };
    for (const dark of [false, true]) {
      for (const surface of SURFACE_THEMES) {
        for (const accent of ACCENT_THEMES) {
          const tokens = {
            ...(dark ? darkBase : base),
            ...(surface === 'graphite' ? {} : cssVariables(`${dark ? '.dark' : ''}.surface-${surface}`)),
            ...cssVariables(`${dark ? '.dark' : ''}.accent-${accent}`),
          };
          expect(contrast(tokens['--color-text-primary'], tokens['--color-bg-chat']), `${dark ? 'dark' : 'light'} ${surface} primary`).toBeGreaterThanOrEqual(7);
          expect(contrast(tokens['--color-text-secondary'], tokens['--color-bg-chat']), `${dark ? 'dark' : 'light'} ${surface} secondary`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(tokens['--color-text-inverse'], tokens['--color-bg-user-msg']), `${dark ? 'dark' : 'light'} ${accent} bubble`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('previews both dimensions and applies layered surfaces to every shell panel', () => {
    expect(general).toContain('SURFACE_OPTIONS.map');
    expect(general).toContain('ACCENT_OPTIONS.map');
    expect(general).toContain("setSurfaceTheme(option.id)");
    expect(general).toContain("setColorTheme(option.id)");
    expect(shell).toContain('app-main-surface');
    expect(shell).toContain('app-sidebar-surface');
  });

  it('keeps the normal model UI at four logical tiers while redesigning appearance', () => {
    expect(general).toContain('getModelDisplayOptions(activeProvider)');
    for (const tier of ['Fable', 'Opus', 'Sonnet', 'Haiku']) expect(store).toContain(`label: '${tier}'`);
    expect(general).not.toMatch(/Opus 4|Sonnet 4|Haiku 4|1M/);
  });

  it('uses semantic inverse text on every accent-backed user surface', () => {
    expect(messageBubble).toContain('text-text-inverse/60');
    expect(messageBubble).not.toContain('text-white/60');
    expect(userAvatar).toContain('text-text-inverse');
    expect(userAvatar).not.toContain('stroke="white"');
  });

  it('routes primary glow, drag, provider, and crash surfaces through appearance tokens', () => {
    expect(chatPanel).toContain('var(--color-accent-glow)');
    expect(chatPanel).not.toContain('rgba(59,111,224,0.12)');
    expect(providerCard).toContain('shadow-[0_0_4px_var(--color-accent-glow)]');
    expect(providerCard).not.toContain('--accent-rgb,99,102,241');
    expect(dragState).toContain("background: 'var(--color-accent)'");
    expect(dragState).toContain("color: 'var(--color-text-inverse)'");
    expect(dragState).not.toContain('rgba(99,102,241');
    expect(main).toContain('background: "var(--color-bg-chat)"');
    expect(main).toContain('background: "var(--color-accent)"');
    expect(main).not.toContain('#8B6CC5');
  });
});
