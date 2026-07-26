export const ACCENT_THEMES = ['black', 'blue', 'purple', 'green'] as const;
export const SURFACE_THEMES = ['graphite', 'midnight', 'paper', 'forest'] as const;
export const THEME_MODES = ['light', 'dark', 'system'] as const;

export type AppearanceAccent = typeof ACCENT_THEMES[number];
export type AppearanceSurface = typeof SURFACE_THEMES[number];
export type AppearanceMode = typeof THEME_MODES[number];

export function normalizeAccent(value: unknown): AppearanceAccent {
  return ACCENT_THEMES.includes(value as AppearanceAccent) ? value as AppearanceAccent : 'black';
}

export function normalizeSurface(value: unknown): AppearanceSurface {
  return SURFACE_THEMES.includes(value as AppearanceSurface) ? value as AppearanceSurface : 'graphite';
}

export function normalizeAppearanceMode(value: unknown): AppearanceMode {
  return THEME_MODES.includes(value as AppearanceMode) ? value as AppearanceMode : 'system';
}

export function applyAppearanceClasses(
  root: Pick<DOMTokenList, 'add' | 'remove'>,
  accent: unknown,
  surface: unknown,
) {
  root.remove(...ACCENT_THEMES.map((value) => `accent-${value}`));
  root.remove(...SURFACE_THEMES.map((value) => `surface-${value}`));
  root.add(`accent-${normalizeAccent(accent)}`);
  root.add(`surface-${normalizeSurface(surface)}`);
}

export function appearanceUsesDarkMode(
  mode: unknown,
  prefersDark = typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches,
): boolean {
  const normalized = normalizeAppearanceMode(mode);
  return normalized === 'dark' || (normalized === 'system' && prefersDark);
}

export function bootstrapAppearance(storage: Pick<Storage, 'getItem'> = localStorage) {
  let persisted: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(storage.getItem('blackbox-settings') || '{}');
    persisted = parsed?.state && typeof parsed.state === 'object' ? parsed.state : {};
  } catch {
    persisted = {};
  }
  const root = document.documentElement;
  applyAppearanceClasses(root.classList, persisted.colorTheme, persisted.surfaceTheme);
  root.classList.toggle('dark', appearanceUsesDarkMode(persisted.theme));
}
