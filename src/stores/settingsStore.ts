import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { settingsEvents } from '../lib/settingsEvents';

// --- Types ---

export type Theme = 'light' | 'dark' | 'system';
export type ColorTheme = 'black' | 'blue' | 'purple' | 'green';
export type SurfaceTheme = 'graphite' | 'midnight' | 'paper' | 'forest';
export type SecondaryPanelTab = 'activity' | 'files';
export type MainView = 'chat' | 'extensions' | 'automations' | 'taskCenter';
export type SettingsTab = 'general' | 'provider' | 'cli' | 'desktopPet';
export type ModelTier = 'fable' | 'opus' | 'sonnet' | 'haiku';
/** @deprecated Prefer ModelTier. Kept as a source-compatible alias. */
export type ModelId = ModelTier;
/**
 * Stable frontend ids for the five interactive Claude Code permission modes.
 * `ask` is retained as the persisted id for backwards compatibility, but is
 * presented to users as Manual and maps to the CLI's `manual` mode.
 * `dontAsk` is intentionally reserved for background automation and is not an
 * interactive session option.
 */
export type SessionMode = 'code' | 'ask' | 'plan' | 'auto' | 'bypass';
/** CLI permission mode for the SDK control protocol */
export type CliPermissionMode = 'acceptEdits' | 'manual' | 'plan' | 'auto' | 'bypassPermissions';
export type Locale = 'zh' | 'en';

/** Map frontend session mode to CLI permission mode */
export function mapSessionModeToPermissionMode(mode: SessionMode): CliPermissionMode {
  switch (mode) {
    case 'code': return 'acceptEdits';
    case 'ask': return 'manual';
    case 'plan': return 'plan';
    case 'auto': return 'auto';
    case 'bypass': return 'bypassPermissions';
  }
}
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

// --- Logical model tiers ---

// These ids remain a backwards-compatible storage ABI. User-facing selectors
// render the active provider's concrete model names, so users never need to
// understand the Claude-shaped slot names used by older provider files.
export const MODEL_OPTIONS: { id: ModelTier; label: string; short: string }[] = [
  { id: 'fable', label: 'Fable', short: 'Fable' },
  { id: 'opus', label: 'Opus', short: 'Opus' },
  { id: 'sonnet', label: 'Sonnet', short: 'Sonnet' },
  { id: 'haiku', label: 'Haiku', short: 'Haiku' },
];

export function isModelTier(value: unknown): value is ModelTier {
  return value === 'fable' || value === 'opus' || value === 'sonnet' || value === 'haiku';
}

/** Normalize every legacy/exact model id into one of the four stable tiers. */
export function normalizeModelTier(value: unknown): ModelTier {
  const model = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isModelTier(model)) return model;
  if (model.includes('fable')) return 'fable';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return 'sonnet';
}

// --- Store State & Actions ---

interface SettingsState {
  theme: Theme;
  colorTheme: ColorTheme;
  surfaceTheme: SurfaceTheme;
  sidebarOpen: boolean;
  secondaryPanelOpen: boolean;
  secondaryPanelTab: SecondaryPanelTab;
  secondaryPanelWidth: number;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  mainView: MainView;
  workingDirectory: string;
  selectedModel: ModelTier;
  /** Lightweight model slot used by every subagent and Black Box web retrieval. */
  auxiliaryModel: ModelTier;
  sessionMode: SessionMode;
  locale: Locale;
  /** Global UI font size in px (default 18) */
  fontSize: number;
  /** Sidebar width in px (default 280) */
  sidebarWidth: number;
  /** Whether the CLI setup wizard has been completed or skipped */
  setupCompleted: boolean;
  /** Thinking effort level: off disables, low/medium/high/max set effort */
  thinkingLevel: ThinkingLevel;
  /** Whether a newer version is available (set by auto-check on startup) */
  updateAvailable: boolean;
  /** Whether a newer CLI version is available */
  cliUpdateAvailable: boolean;
  /** Latest CLI version string (for display) */
  cliLatestVersion: string;
  /** Version string of the available update */
  updateVersion: string;
  /** Whether the update has been downloaded and is ready for restart (transient, not persisted) */
  updateDownloaded: boolean;
  /** Last app version the user has seen the changelog for */
  lastSeenVersion: string;
  /** Custom AI avatar image (data URL or empty string for default </> icon) */
  aiAvatarUrl: string;
  /** Custom user avatar image (data URL or empty string for default initials) */
  userAvatarUrl: string;
  /** User display name shown next to messages */
  userDisplayName: string;
  /** Whether to show dotfiles (hidden files) in the file tree */
  showHiddenFiles: boolean;
  /** Explicit opt-in for Claude Code's experimental, higher-cost Agent Teams runtime. */
  agentTeamsEnabled: boolean;
  /** Keep macOS awake while Black Box is running, while still allowing display sleep. */
  keepSystemAwake: boolean;
  /** Optionally keep the display awake too. Requires keepSystemAwake. */
  keepDisplayAwake: boolean;

  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setColorTheme: (colorTheme: ColorTheme) => void;
  setSurfaceTheme: (surfaceTheme: SurfaceTheme) => void;
  /** Whether the floating agent panel is open */
  agentPanelOpen: boolean;

  toggleSidebar: () => void;
  toggleSecondaryPanel: () => void;
  toggleAgentPanel: () => void;
  setSecondaryTab: (tab: SecondaryPanelTab) => void;
  setSecondaryPanelWidth: (width: number) => void;
  toggleSettings: () => void;
  openSettings: (tab?: SettingsTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setMainView: (view: MainView) => void;
  setWorkingDirectory: (dir: string) => void;
  setSelectedModel: (model: string) => void;
  setAuxiliaryModel: (model: string) => void;
  setSessionMode: (mode: SessionMode) => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  setFontSize: (size: number) => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setSidebarWidth: (width: number) => void;
  setSetupCompleted: (completed: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setUpdateAvailable: (available: boolean, version?: string) => void;
  setUpdateDownloaded: (downloaded: boolean) => void;
  setLastSeenVersion: (version: string) => void;
  setAiAvatarUrl: (url: string) => void;
  setUserAvatarUrl: (url: string) => void;
  setUserDisplayName: (name: string) => void;
  toggleHiddenFiles: () => void;
  setAgentTeamsEnabled: (enabled: boolean) => void;
  setKeepSystemAwake: (enabled: boolean) => void;
  setKeepDisplayAwake: (enabled: boolean) => void;
}

// --- Theme cycle order ---

const themeCycle: Theme[] = ['light', 'dark', 'system'];

function nextTheme(current: Theme): Theme {
  const idx = themeCycle.indexOf(current);
  return themeCycle[(idx + 1) % themeCycle.length];
}

// --- Store ---

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      colorTheme: 'black',
      surfaceTheme: 'graphite',
      sidebarOpen: true,
      secondaryPanelOpen: false,
      secondaryPanelTab: 'files',
      secondaryPanelWidth: 300,
      settingsOpen: false,
      settingsTab: 'general',
      mainView: 'chat',
      agentPanelOpen: false,
      workingDirectory: '',
      selectedModel: 'sonnet',
      auxiliaryModel: 'sonnet',
      sessionMode: 'bypass',
      locale: 'zh',
      fontSize: 18,
      sidebarWidth: 280,
      setupCompleted: false,
      thinkingLevel: 'medium' as ThinkingLevel,
      updateAvailable: false,
      updateVersion: '',
      cliUpdateAvailable: false,
      cliLatestVersion: '',
      updateDownloaded: false,
      lastSeenVersion: '',
      aiAvatarUrl: '',
      userAvatarUrl: '',
      userDisplayName: '',
      showHiddenFiles: false,
      agentTeamsEnabled: false,
      keepSystemAwake: true,
      keepDisplayAwake: false,

      toggleTheme: () =>
        set((state) => ({ theme: nextTheme(state.theme) })),

      setTheme: (theme) => set(() => ({ theme })),

      setColorTheme: (colorTheme) => set(() => ({ colorTheme })),

      setSurfaceTheme: (surfaceTheme) => set(() => ({ surfaceTheme })),

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      toggleSecondaryPanel: () =>
        set((state) => ({
          secondaryPanelOpen: !state.secondaryPanelOpen,
        })),

      toggleAgentPanel: () =>
        set((state) => ({ agentPanelOpen: !state.agentPanelOpen })),

      setSecondaryTab: (tab) =>
        set(() => ({
          secondaryPanelTab: tab,
          secondaryPanelOpen: true,
        })),

      setSecondaryPanelWidth: (width) =>
        set(() => ({ secondaryPanelWidth: width })),

      toggleSettings: () =>
        set((state) => ({
          settingsOpen: !state.settingsOpen,
          // Clear update badge when opening settings
          ...(!state.settingsOpen && state.updateAvailable ? { updateAvailable: false } : {}),
        })),

      openSettings: (tab = 'general') =>
        set((state) => ({
          settingsOpen: true,
          settingsTab: tab,
          ...(state.updateAvailable ? { updateAvailable: false } : {}),
        })),

      setSettingsTab: (tab) => set(() => ({ settingsTab: tab })),

      setMainView: (view) => set(() => ({ mainView: view })),

      setWorkingDirectory: (dir) =>
        set(() => ({ workingDirectory: dir })),

      setSelectedModel: (model) => {
        const old = get().selectedModel;
        const next = normalizeModelTier(model);
        set(() => ({ selectedModel: next }));
        if (old !== next) settingsEvents.emit('model-changed', { old, next });
      },

      setAuxiliaryModel: (model) => {
        const old = get().auxiliaryModel;
        const next = normalizeModelTier(model);
        set(() => ({ auxiliaryModel: next }));
        if (old !== next) settingsEvents.emit('model-changed', { old, next });
      },

      setSessionMode: (mode) => {
        const old = get().sessionMode;
        set(() => ({ sessionMode: mode }));
        if (old !== mode) settingsEvents.emit('session-mode-changed', { old, next: mode });
      },

      setLocale: (locale) =>
        set(() => ({ locale })),

      toggleLocale: () =>
        set((state) => ({ locale: state.locale === 'zh' ? 'en' : 'zh' })),

      setFontSize: (size) =>
        set(() => ({ fontSize: Math.max(10, Math.min(36, size)) })),

      increaseFontSize: () =>
        set((state) => ({ fontSize: Math.min(36, state.fontSize + 1) })),

      decreaseFontSize: () =>
        set((state) => ({ fontSize: Math.max(10, state.fontSize - 1) })),

      setSidebarWidth: (width) =>
        set(() => ({ sidebarWidth: Math.max(180, Math.min(450, width)) })),

      setSetupCompleted: (completed) =>
        set(() => ({ setupCompleted: completed })),

      setThinkingLevel: (level) => {
        const old = get().thinkingLevel;
        set(() => ({ thinkingLevel: level }));
        if (old !== level) settingsEvents.emit('thinking-changed', { old, next: level });
      },

      setUpdateAvailable: (available, version) =>
        set(() => ({
          updateAvailable: available,
          ...(version !== undefined ? { updateVersion: version } : {}),
          ...(!available ? { updateVersion: '', updateDownloaded: false } : {}),
        })),

      setUpdateDownloaded: (downloaded) =>
        set(() => ({ updateDownloaded: downloaded })),

      setLastSeenVersion: (version) =>
        set(() => ({ lastSeenVersion: version })),

      setAiAvatarUrl: (url) =>
        set(() => ({ aiAvatarUrl: url })),

      setUserAvatarUrl: (url) =>
        set(() => ({ userAvatarUrl: url })),

      setUserDisplayName: (name) =>
        set(() => ({ userDisplayName: name.slice(0, 20) })),
      toggleHiddenFiles: () =>
        set((state) => ({ showHiddenFiles: !state.showHiddenFiles })),
      setAgentTeamsEnabled: (enabled) =>
        set(() => ({ agentTeamsEnabled: enabled })),
      setKeepSystemAwake: (enabled) =>
        set(() => ({
          keepSystemAwake: enabled,
          ...(!enabled ? { keepDisplayAwake: false } : {}),
        })),
      setKeepDisplayAwake: (enabled) =>
        set((state) => ({ keepDisplayAwake: state.keepSystemAwake && enabled })),
    }),
    {
      name: 'blackbox-settings',
      version: 13,
      migrate: (persistedState: unknown, version: number) => {
        const persisted = persistedState as Record<string, unknown>;
        if (version === 0) {
          // Migrate legacy model IDs to current ones
          const legacyMap: Record<string, string> = {
            'claude-opus-4-0': 'claude-opus-4-8',
            'claude-sonnet-4-0': 'claude-sonnet-4-6',
            'claude-haiku-3-5': 'claude-haiku-4-5-20251001',
          };
          const old = persisted.selectedModel as string;
          if (old && legacyMap[old]) {
            persisted.selectedModel = legacyMap[old];
          }
        }
        if (version < 2) {
          persisted.updateAvailable = false;
          persisted.updateVersion = '';
          persisted.lastSeenVersion = '';
        }
        if (version < 3) {
          persisted.apiProviderMode = 'inherit';
          persisted.customProviderName = '';
          persisted.customProviderBaseUrl = '';
          persisted.customProviderModelMappings = [];
          persisted.customProviderApiFormat = 'anthropic';
        }
        if (version < 4) {
          // Migrate boolean thinkingEnabled → ThinkingLevel
          const oldThinking = persisted.thinkingEnabled;
          persisted.thinkingLevel = oldThinking === false ? 'off' : 'high';
          delete persisted.thinkingEnabled;
        }
        if (version < 5) {
          // Force default mode to bypass — old versions may have persisted 'code'/'ask'
          persisted.sessionMode = 'bypass';
        }
        if (version < 6) {
          // Fix Haiku model ID: claude-haiku-4-5 → claude-haiku-4-5-20251001
          if (persisted.selectedModel === 'claude-haiku-4-5') {
            persisted.selectedModel = 'claude-haiku-4-5-20251001';
          }
        }
        // v7 migration removed (Phase 2 §2.5 / §5.1): users are free to pick
        // 4.6 / 4.6-1m / 4.7 / 4.7-1m. The earlier migration forcibly rewrote
        // 4.6 selections to 4.7, which silently broke old-CLI users.
        if (version < 8) {
          // 4.7 is retired in favor of 4.8. Only remap the two existing 4.7
          // selections to their 4.8 equivalents — never force-rewrite any other
          // model (4.8 is a CLI-supported model, so this is a same-tier upgrade,
          // not the v7-style unconditional rewrite that broke old-CLI users).
          const opusUpgradeMap: Record<string, string> = {
            'claude-opus-4-7': 'claude-opus-4-8',
            'claude-opus-4-7-1m': 'claude-opus-4-8-1m',
          };
          const current = persisted.selectedModel as string;
          if (current && opusUpgradeMap[current]) {
            persisted.selectedModel = opusUpgradeMap[current];
          }
        }
        if (version < 9) {
          // UI model selection is now a stable logical tier. Exact ids remain
          // private to the active provider mapping and are resolved at runtime.
          persisted.selectedModel = normalizeModelTier(persisted.selectedModel);
        }
        if (version < 10) {
          const accentThemes = new Set(['black', 'blue', 'purple', 'green']);
          const surfaceThemes = new Set(['graphite', 'midnight', 'paper', 'forest']);
          if (!accentThemes.has(String(persisted.colorTheme || ''))) {
            persisted.colorTheme = 'black';
          }
          if (!surfaceThemes.has(String(persisted.surfaceTheme || ''))) {
            persisted.surfaceTheme = 'graphite';
          }
        }
        if (version < 11) {
          // Agent Teams are experimental and materially increase token use.
          // Never opt an existing installation in during migration.
          persisted.agentTeamsEnabled = false;
        }
        if (version < 12) {
          // Black Box is expected to keep long-running CLI/API/automation work
          // alive after the display sleeps. Display wake remains opt-in to
          // avoid unnecessary battery and panel use.
          persisted.keepSystemAwake = true;
          persisted.keepDisplayAwake = false;
        }
        if (version < 13) {
          // The first auxiliary routing profile uses the balanced slot. For
          // the built-in catalog this resolves to Sonnet on Claude and Terra
          // on OpenAI; users can change it directly from the model selector.
          persisted.auxiliaryModel = 'sonnet';
        }
        return persisted;
      },
      partialize: (state) => ({
        theme: state.theme,
        colorTheme: state.colorTheme,
        surfaceTheme: state.surfaceTheme,
        sidebarOpen: state.sidebarOpen,
        secondaryPanelWidth: state.secondaryPanelWidth,
        // workingDirectory intentionally NOT persisted — app starts at WelcomeScreen
        selectedModel: state.selectedModel,
        auxiliaryModel: state.auxiliaryModel,
        sessionMode: state.sessionMode,
        locale: state.locale,
        fontSize: state.fontSize,
        sidebarWidth: state.sidebarWidth,
        setupCompleted: state.setupCompleted,
        thinkingLevel: state.thinkingLevel,
        updateAvailable: state.updateAvailable,
        updateVersion: state.updateVersion,
        lastSeenVersion: state.lastSeenVersion,
        aiAvatarUrl: state.aiAvatarUrl,
        userAvatarUrl: state.userAvatarUrl,
        userDisplayName: state.userDisplayName,
        showHiddenFiles: state.showHiddenFiles,
        agentTeamsEnabled: state.agentTeamsEnabled,
        keepSystemAwake: state.keepSystemAwake,
        keepDisplayAwake: state.keepDisplayAwake,
      }),
    },
  ),
);

// --- Per-session effective value helpers (Phase 4) ---
// These read the snapshotted value from SessionMeta, falling back to the global store.
// Import SessionMeta lazily to avoid circular dependency.

/** Get the effective session mode for a given session's meta snapshot */
export function getEffectiveMode(meta: { snapshotMode?: SessionMode } | undefined): SessionMode {
  return meta?.snapshotMode ?? useSettingsStore.getState().sessionMode;
}

/** Get the effective model for a given session's meta snapshot */
export function getEffectiveModel(meta: { snapshotModel?: string } | undefined): string {
  return meta?.snapshotModel ?? useSettingsStore.getState().selectedModel;
}

/** Get the effective thinking level for a given session's meta snapshot */
export function getEffectiveThinking(meta: { snapshotThinking?: ThinkingLevel } | undefined): ThinkingLevel {
  return meta?.snapshotThinking ?? useSettingsStore.getState().thinkingLevel;
}

// --- Runtime mode switching via SDK control protocol ---
// When sessionMode changes and there's an active CLI session, send set_permission_mode.

let _skipNextModeSync = false;

/** Update frontend sessionMode WITHOUT sending set_permission_mode to CLI.
 *  Use when CLI already switched modes internally (e.g. after ExitPlanMode allow). */
export function setSessionModeLocal(mode: SessionMode): void {
  _skipNextModeSync = true;
  useSettingsStore.getState().setSessionMode(mode);
}

// Phase 2 §2.3 runtime sync policy:
//
// - sessionMode change → SDK control protocol `set_permission_mode` on the
//   live session (no kill). Handled here.
// - selectedModel / thinkingLevel / activeProviderId change → DO NOT kill.
//   InputBar.handleSubmit detects the spawnConfigHash mismatch on the next
//   user send and handles teardown + resume spawn. Killing here would drop
//   in-flight turns and cross-tab races between the sidebar and pre-warm.
useSettingsStore.subscribe((state, prevState) => {
  if (state.sessionMode === prevState.sessionMode) return;

  if (_skipNextModeSync) {
    _skipNextModeSync = false;
    return;
  }

  const cliMode = mapSessionModeToPermissionMode(state.sessionMode);

  // Dynamically import to avoid circular deps
  Promise.all([
    import('../lib/tauri-bridge'),
    import('./chatStore'),
  ]).then(([{ bridge }, { getActiveTabState }]) => {
    const stdinId = getActiveTabState().sessionMeta.stdinId;
    if (!stdinId) return; // No active session

    bridge.setPermissionMode(stdinId, cliMode).catch((err: unknown) => {
      console.error('[BLACKBOX] Failed to set permission mode:', err);
    });
  }).catch((err: unknown) => {
    // Dynamic imports can fail during WebView/test teardown. The mode remains
    // persisted and will still be applied to the next CLI spawn.
    console.error('[BLACKBOX] Failed to load runtime mode bridge:', err);
  });
});
