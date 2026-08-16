import { create } from 'zustand';
import { bridge, type ProvidersFile } from '../lib/tauri-bridge';
import { isModelTier, type ModelTier } from './settingsStore';
import {
  PROVIDER_PRESETS,
  inferProviderAuthScheme,
  type ProviderApiFormat,
  type ProviderAuthScheme,
  type PresetProvider,
} from '../lib/provider-presets';

export interface ModelMapping {
  /** Stable tier ('fable'|'opus'|'sonnet'|'haiku') or a legacy direct model ID */
  tier: string;
  providerModel: string;
}

export interface ApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: ProviderApiFormat;
  authScheme?: ProviderAuthScheme;
  /** Transient input. The backend persists it locally but never returns it to the UI. */
  apiKey?: string;
  credentialRef?: string;
  credentialHint?: string;
  credentialState?: 'missing' | 'local_file';
  revision?: number;
  modelMappings: ModelMapping[];
  extraEnv?: Record<string, string>;
  proxyUrl?: string;
  preset?: string;
  createdAt: number;
  updatedAt: number;
}

interface ProviderState {
  providers: ApiProvider[];
  defaultApi: string | null;
  defaultMainModel: ModelTier | null;
  defaultAuxiliaryModel: ModelTier | null;
  activeProviderId: string | null;
  loaded: boolean;

  load: () => Promise<void>;
  flushSave: () => Promise<void>;
  addProvider: (p: Omit<ApiProvider, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateProvider: (id: string, patch: Partial<ApiProvider>) => void;
  deleteProvider: (id: string) => Promise<void>;
  clearProviderCredential: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  setDefaultApi: (id: string | null) => void;
  setDefaultMainModel: (model: ModelTier | null) => void;
  setDefaultAuxiliaryModel: (model: ModelTier | null) => void;
  getActive: () => ApiProvider | null;
}

const LEGACY_SYSTEM_API_ID = 'system';

export function hasUsableProviderCredential(
  provider: Pick<ApiProvider, 'apiKey' | 'credentialState'> | null | undefined,
): boolean {
  return Boolean(
    provider
    && (provider.apiKey?.trim() || provider.credentialState === 'local_file'),
  );
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Providers saved before the four-tier UI had no Fable key because the old UI
 * collapsed Fable into Opus. Materialize that compatibility choice once so
 * runtime routing can remain strict and every tier is independently editable.
 */
export function migrateLegacyFableMapping(mappings: readonly ModelMapping[]): ModelMapping[] {
  if (mappings.some((mapping) => mapping.tier === 'fable')) return [...mappings];
  const legacyOpus = mappings.find(
    (mapping) => mapping.tier === 'opus' && mapping.providerModel.trim().length > 0,
  );
  if (!legacyOpus) return [...mappings];
  return [
    { tier: 'fable', providerModel: legacyOpus.providerModel },
    ...mappings,
  ];
}

type HistoricalPresetSnapshot = {
  baseUrl: string;
  apiFormat: ProviderApiFormat;
  authSchemes: readonly (ProviderAuthScheme | undefined)[];
  modelMappings: readonly ModelMapping[];
  extraEnv?: Record<string, string>;
};

function fourTierMappings(
  fable: string,
  opus: string,
  sonnet: string,
  haiku: string,
): ModelMapping[] {
  return [
    { tier: 'fable', providerModel: fable },
    { tier: 'opus', providerModel: opus },
    { tier: 'sonnet', providerModel: sonnet },
    { tier: 'haiku', providerModel: haiku },
  ];
}

/**
 * Exact historical defaults that shipped in v0.14.1 or existed earlier in
 * this development train. A provider is upgraded only when its entire
 * transport snapshot still matches one of these records. One user edit makes
 * the snapshot non-matching and therefore preserves every configured field.
 */
const HISTORICAL_PRESET_SNAPSHOTS: Readonly<Record<string, readonly HistoricalPresetSnapshot[]>> = {
  openai: [
    {
      baseUrl: 'https://api.openai.com/v1',
      apiFormat: 'openai',
      authSchemes: ['bearer'],
      modelMappings: fourTierMappings('gpt-5.1', 'gpt-5.1', 'gpt-5-mini', 'gpt-5-nano'),
    },
    {
      baseUrl: 'https://api.openai.com/v1',
      apiFormat: 'openai',
      authSchemes: ['bearer'],
      modelMappings: fourTierMappings(
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
      ),
    },
  ],
  gemini: [
    {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      authSchemes: [undefined, 'bearer'],
      modelMappings: fourTierMappings(
        'gemini-3.5-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
      ),
    },
    {
      // Untouched catalog-v2 native preset. Exact matching makes the official
      // model refresh auditable without rewriting a user-customized endpoint.
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiFormat: 'gemini',
      authSchemes: ['x-goog-api-key'],
      modelMappings: fourTierMappings(
        'gemini-3.5-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
      ),
    },
  ],
  deepseek: [{
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiFormat: 'anthropic',
    authSchemes: ['bearer'],
    modelMappings: fourTierMappings(
      'deepseek-v4-pro',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash',
    ),
  }],
  zhipu: [
    {
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      authSchemes: [undefined, 'x-api-key'],
      modelMappings: fourTierMappings('glm-5', 'glm-5', 'glm-5-turbo', 'glm-4.7'),
    },
    {
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      authSchemes: ['bearer'],
      modelMappings: fourTierMappings('glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7'),
    },
  ],
  doubao: [{
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    apiFormat: 'anthropic',
    authSchemes: ['bearer'],
    modelMappings: fourTierMappings(
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-lite',
      'doubao-seed-2.0-mini',
    ),
  }],
  qwen: [
    {
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiFormat: 'anthropic',
      authSchemes: [undefined, 'x-api-key'],
      modelMappings: fourTierMappings('qwen3-max', 'qwen3-max', 'qwen3.5-plus', 'qwen3.5-flash'),
    },
    {
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiFormat: 'anthropic',
      authSchemes: ['bearer'],
      modelMappings: fourTierMappings('qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash'),
    },
  ],
  minimax: [
    {
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      authSchemes: [undefined, 'x-api-key'],
      modelMappings: fourTierMappings('MiniMax-M2.7', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1'),
      extraEnv: {
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
    {
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      authSchemes: ['bearer'],
      modelMappings: fourTierMappings('MiniMax-M2.7', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1'),
      extraEnv: {
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
    {
      // Untouched catalog-v2 preset. The 1M compact override cannot safely
      // apply once the picker exposes MiniMax's real 204.8K models as well.
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      authSchemes: ['x-api-key'],
      modelMappings: fourTierMappings('MiniMax-M3', 'MiniMax-M3', 'MiniMax-M3', 'MiniMax-M3'),
      extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    },
  ],
  kimi: [
    {
      baseUrl: 'https://api.moonshot.cn/anthropic/',
      apiFormat: 'anthropic',
      authSchemes: [undefined, 'x-api-key'],
      modelMappings: fourTierMappings('kimi-k2.5', 'kimi-k2.5', 'kimi-k2', 'kimi-k2-turbo-preview'),
    },
    {
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      authSchemes: ['bearer'],
      modelMappings: fourTierMappings('kimi-k2.7-code', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5'),
    },
    {
      // Untouched catalog-v2 preset. Keep the official runtime flags while
      // migrating its single duplicated model into the documented whitelist.
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      authSchemes: ['bearer'],
      modelMappings: fourTierMappings(
        'kimi-k2.7-code',
        'kimi-k2.7-code',
        'kimi-k2.7-code',
        'kimi-k2.7-code',
      ),
      extraEnv: {
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
      },
    },
  ],
};

function normalizeRecord(record: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeMappings(mappings: readonly ModelMapping[]): string {
  return JSON.stringify(
    mappings
      .map(({ tier, providerModel }) => [tier, providerModel.trim()])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function currentPresetMappings(preset: PresetProvider): ModelMapping[] {
  return fourTierMappings(
    preset.defaultModels?.fable || preset.defaultModels?.opus || preset.defaultModel || '',
    preset.defaultModels?.opus || preset.defaultModel || '',
    preset.defaultModels?.sonnet || preset.defaultModel || '',
    preset.defaultModels?.haiku || preset.defaultModel || '',
  );
}

/**
 * Upgrade a provider only when it is still an untouched historical preset.
 * Credentials, display name, proxy, timestamps and revision are preserved.
 */
export function migrateKnownPresetDefaults(provider: ApiProvider): ApiProvider {
  if (!provider.preset) return provider;
  const current = PROVIDER_PRESETS.find((preset) => preset.id === provider.preset);
  const historical = HISTORICAL_PRESET_SNAPSHOTS[provider.preset];
  if (!current || !historical) return provider;

  const materializedMappings = migrateLegacyFableMapping(provider.modelMappings);
  const matchingSnapshot = historical.find((snapshot) => (
    provider.baseUrl === snapshot.baseUrl
    && provider.apiFormat === snapshot.apiFormat
    && snapshot.authSchemes.includes(provider.authScheme)
    && normalizeMappings(materializedMappings) === normalizeMappings(snapshot.modelMappings)
    && normalizeRecord(provider.extraEnv) === normalizeRecord(snapshot.extraEnv)
  ));
  if (!matchingSnapshot) return provider;

  return {
    ...provider,
    baseUrl: current.baseUrl,
    apiFormat: current.apiFormat,
    authScheme: current.authScheme,
    modelMappings: currentPresetMappings(current),
    extraEnv: { ...current.extraEnv },
  };
}

let _saveTimer: ReturnType<typeof setTimeout> | undefined;
let _saveQueue: Promise<void> = Promise.resolve();
let _flushPromise: Promise<void> | null = null;
let _loadPromise: Promise<void> | null = null;
let _dirtyGeneration = 0;
let _persistedGeneration = 0;

type ProviderStateSetter = (
  partial: Partial<ProviderState> | ((state: ProviderState) => Partial<ProviderState>),
) => void;

function markProviderStateDirty() {
  _dirtyGeneration += 1;
}

/**
 * Serialize provider writes so an older, slower save can never land after a
 * newer one. The generation check also lets flushSave stay a true no-op when
 * no local provider change is waiting for disk.
 */
function enqueueProviderSave(
  get: () => ProviderState,
  set: ProviderStateSetter,
): Promise<void> {
  const persistLatest = async () => {
    if (_persistedGeneration >= _dirtyGeneration) return;

    const targetGeneration = _dirtyGeneration;
    const {
      providers,
      activeProviderId,
      defaultApi,
      defaultMainModel,
      defaultAuxiliaryModel,
    } = get();
    const capturedActiveProviderId = activeProviderId;
    const capturedDefaultApi = defaultApi;
    const capturedDefaultMainModel = defaultMainModel;
    const capturedDefaultAuxiliaryModel = defaultAuxiliaryModel;
    const snapshots = new Map(providers.map((provider) => [provider.id, provider]));
    const data: ProvidersFile = {
      version: 4,
      defaultApi,
      defaultMainModel,
      defaultAuxiliaryModel,
      activeProviderId,
      providers,
    };
    const saved = await bridge.saveProviders(data);
    set((state) => ({
      defaultApi: state.defaultApi === capturedDefaultApi
        ? saved.defaultApi
        : state.defaultApi,
      defaultMainModel: state.defaultMainModel === capturedDefaultMainModel
        ? saved.defaultMainModel
        : state.defaultMainModel,
      defaultAuxiliaryModel: state.defaultAuxiliaryModel === capturedDefaultAuxiliaryModel
        ? saved.defaultAuxiliaryModel
        : state.defaultAuxiliaryModel,
      activeProviderId: state.activeProviderId === capturedActiveProviderId
        ? saved.activeProviderId
        : state.activeProviderId,
      providers: state.providers.map((current) => {
        const persisted = saved.providers.find((provider) => provider.id === current.id) as ApiProvider | undefined;
        const snapshot = snapshots.get(current.id);
        if (!persisted || !snapshot) return current;
        // Provider updates replace the object. Identity therefore remains a
        // reliable stale-write guard even when two edits share one millisecond.
        if (current === snapshot) return persisted;
        return {
          ...current,
          credentialRef: persisted.credentialRef,
          credentialHint: persisted.credentialHint,
          credentialState: persisted.credentialState,
          revision: persisted.revision,
        };
      }),
    }));
    _persistedGeneration = Math.max(_persistedGeneration, targetGeneration);
  };

  const queued = _saveQueue.then(persistLatest, persistLatest);
  // Keep the serialization lane usable after a failed caller-visible save.
  _saveQueue = queued.catch(() => undefined);
  return queued;
}

function debouncedSave(state: ProviderState) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = undefined;
    state.flushSave().catch((e) => console.error('[providerStore] save failed:', e));
  }, 500);
}

export const useProviderStore = create<ProviderState>()((set, get) => ({
  providers: [],
  defaultApi: null,
  defaultMainModel: null,
  defaultAuxiliaryModel: null,
  activeProviderId: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    if (_loadPromise) return _loadPromise;

    const loadTask = (async () => {
      try {
        let data = await bridge.loadProviders();
        let needsSave = false;

        // `system` was the retired native-login pseudo-provider. Defaults now
        // name one real, credentialed API provider; keep old files readable
        // while forcing an explicit replacement before any new process starts.
        if (data.defaultApi === LEGACY_SYSTEM_API_ID) {
          data.defaultApi = null;
          needsSave = true;
        }

        // If providers.json is empty, try migrating from old settingsStore data
        if (data.providers.length === 0) {
          const migrated = migrateFromSettingsStore();
          if (migrated) {
            data.providers = [migrated];
            data.activeProviderId = migrated.id;
            needsSave = true;
            console.log('[providerStore] Migrated old API settings to provider:', migrated.name);
          }
        }

        data.providers = data.providers.map((provider) => {
          const modelMappings = migrateLegacyFableMapping(provider.modelMappings);
          const fableMigrated = {
            ...provider,
            modelMappings,
          } as ApiProvider;
          const presetMigrated = migrateKnownPresetDefaults(fableMigrated);
          const authScheme = inferProviderAuthScheme(presetMigrated);
          if (
            modelMappings.length !== provider.modelMappings.length
            || provider.authScheme !== authScheme
            || presetMigrated !== fableMigrated
          ) needsSave = true;
          return { ...presetMigrated, authScheme };
        });

        if (data.defaultApi) {
          const defaultProvider = data.providers.find(
            (provider) => provider.id === data.defaultApi,
          );
          if (
            !defaultProvider
            || !hasUsableProviderCredential(defaultProvider)
          ) {
            data.defaultApi = null;
            needsSave = true;
          }
        }

        if (needsSave) data = await bridge.saveProviders(data);

        set({
          providers: data.providers as ApiProvider[],
          defaultApi: data.defaultApi,
          defaultMainModel: isModelTier(data.defaultMainModel) ? data.defaultMainModel : null,
          defaultAuxiliaryModel: isModelTier(data.defaultAuxiliaryModel)
            ? data.defaultAuxiliaryModel
            : null,
          activeProviderId: data.activeProviderId,
          loaded: true,
        });
      } catch (e) {
        console.error('[providerStore] load failed:', e);
        set({ loaded: true });
      }
    })();
    _loadPromise = loadTask;
    try {
      await loadTask;
    } finally {
      if (_loadPromise === loadTask) _loadPromise = null;
    }
  },

  flushSave: async () => {
    clearTimeout(_saveTimer);
    _saveTimer = undefined;
    if (_flushPromise) return _flushPromise;

    const flushTask = (async () => {
      // Join any save already in flight, then keep persisting until every edit
      // that happened during that await has also reached disk.
      await _saveQueue;
      while (_persistedGeneration < _dirtyGeneration) {
        await enqueueProviderSave(get, set);
      }
      clearTimeout(_saveTimer);
      _saveTimer = undefined;
    })();
    _flushPromise = flushTask;
    try {
      await flushTask;
    } finally {
      if (_flushPromise === flushTask) _flushPromise = null;
    }
  },

  addProvider: (p) => {
    const now = Date.now();
    const newProvider: ApiProvider = {
      ...p,
      authScheme: inferProviderAuthScheme(p),
      modelMappings: migrateLegacyFableMapping(p.modelMappings),
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ providers: [...s.providers, newProvider] }));
    markProviderStateDirty();
    debouncedSave(get());
  },

  updateProvider: (id, patch) => {
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === id
          ? { ...p, ...patch, updatedAt: Math.max(Date.now(), p.updatedAt + 1) }
          : p,
      ),
    }));
    markProviderStateDirty();
    debouncedSave(get());
  },

  deleteProvider: async (id) => {
    clearTimeout(_saveTimer);
    _saveTimer = undefined;
    await get().flushSave();
    const saved = await bridge.deleteProvider(id);
    set({
      providers: saved.providers as ApiProvider[],
      defaultApi: saved.defaultApi,
      defaultMainModel: saved.defaultMainModel,
      defaultAuxiliaryModel: saved.defaultAuxiliaryModel,
      activeProviderId: saved.activeProviderId,
    });
  },

  clearProviderCredential: async (id) => {
    clearTimeout(_saveTimer);
    _saveTimer = undefined;
    await get().flushSave();
    const saved = await bridge.clearProviderCredential(id);
    set({
      providers: saved.providers as ApiProvider[],
      defaultApi: saved.defaultApi,
      defaultMainModel: saved.defaultMainModel,
      defaultAuxiliaryModel: saved.defaultAuxiliaryModel,
      activeProviderId: saved.activeProviderId,
    });
  },

  setActive: (id) => {
    if (get().activeProviderId === id) return;
    set({ activeProviderId: id });
    markProviderStateDirty();
    debouncedSave(get());
  },

  setDefaultApi: (id) => {
    if (id) {
      const provider = get().providers.find((candidate) => candidate.id === id);
      if (
        !provider
        || !hasUsableProviderCredential(provider)
      ) return;
    }
    if (get().defaultApi === id) return;
    set({ defaultApi: id });
    markProviderStateDirty();
    debouncedSave(get());
  },

  setDefaultMainModel: (model) => {
    if (model && !isModelTier(model)) return;
    if (get().defaultMainModel === model) return;
    set({ defaultMainModel: model });
    markProviderStateDirty();
    debouncedSave(get());
  },

  setDefaultAuxiliaryModel: (model) => {
    if (model && !isModelTier(model)) return;
    if (get().defaultAuxiliaryModel === model) return;
    set({ defaultAuxiliaryModel: model });
    markProviderStateDirty();
    debouncedSave(get());
  },

  getActive: () => {
    const { providers, activeProviderId } = get();
    if (!activeProviderId) return null;
    return providers.find((p) => p.id === activeProviderId) ?? null;
  },
}));

/**
 * Migrate from old settingsStore API fields to a new ApiProvider.
 * Returns null if no old config exists or mode is 'inherit'.
 */
function migrateFromSettingsStore(): ApiProvider | null {
  try {
    // Read old settings from localStorage (settingsStore persists there)
    const raw = localStorage.getItem('blackbox-settings');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const state = parsed?.state;
    if (!state) return null;

    const mode = state.apiProviderMode;
    if (!mode || mode === 'inherit') return null;

    const now = Date.now();
    const apiFormat = (state.customProviderApiFormat || 'anthropic') as ProviderApiFormat;
    const provider: ApiProvider = {
      id: generateId(),
      name: state.customProviderName || (mode === 'official' ? 'Anthropic (官方)' : 'Custom'),
      baseUrl: mode === 'official' ? 'https://api.anthropic.com' : (state.customProviderBaseUrl || ''),
      apiFormat,
      authScheme: inferProviderAuthScheme({ apiFormat }),
      modelMappings: migrateLegacyFableMapping(Array.isArray(state.customProviderModelMappings)
        ? state.customProviderModelMappings.map((m: { tier: string; providerModel: string }) => ({
            tier: m.tier,
            providerModel: m.providerModel,
          }))
        : []),
      createdAt: now,
      updatedAt: now,
    };

    return provider;
  } catch {
    return null;
  }
}
