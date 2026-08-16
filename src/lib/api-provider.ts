import {
  hasUsableProviderCredential,
  useProviderStore,
  type ApiProvider,
} from '../stores/providerStore';
import {
  MODEL_OPTIONS,
  isModelTier,
  normalizeModelTier,
  useSettingsStore,
  type ModelTier,
  type ThinkingLevel,
} from '../stores/settingsStore';
import { bridge } from '../lib/tauri-bridge';

/**
 * Legacy/exact ids mapped to their stable logical tier. Fable is deliberately
 * independent from Opus; the old UI incorrectly collapsed both into `opus`.
 */
export const TIER_MAP: Record<string, ModelTier> = {
  fable: 'fable',
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  'claude-fable-5': 'fable',
  'claude-fable-5-1m': 'fable',
  'claude-fable-5[1m]': 'fable',
  'claude-opus-4-8': 'opus',
  'claude-opus-4-8-1m': 'opus',
  'claude-opus-4-8[1m]': 'opus',
  'claude-opus-4-6-1m': 'opus',
  'claude-opus-4-6[1m]': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
};

/** Built-in native Claude mapping used when no custom provider is active. */
export const DEFAULT_MODEL_FOR_TIER: Record<ModelTier, string> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

export interface ModelDisplayOption {
  id: string;
  label: string;
  short: string;
  mapped: boolean;
  isExtra: boolean;
  providerModel?: string;
  sourceTier?: string;
}

function logicalModelDisplayOptions(includeNativeCustomModels: boolean): ModelDisplayOption[] {
  const base: ModelDisplayOption[] = MODEL_OPTIONS.map((model) => ({
    id: model.id,
    label: model.label,
    short: model.short,
    mapped: false,
    isExtra: false,
  }));
  // Append native custom model options configured via ANTHROPIC_CUSTOM_MODEL_OPTION.
  // These come from the login shell and are read once from the Rust bridge.
  if (includeNativeCustomModels && NATIVE_CUSTOM_MODEL_OPTIONS.length > 0) {
    for (const opt of NATIVE_CUSTOM_MODEL_OPTIONS) {
      base.push({
        id: opt.model_id,
        label: opt.label,
        short: opt.label,
        mapped: false,
        isExtra: true,
        providerModel: opt.model_id,
        sourceTier: 'custom',
      });
    }
  }
  return base;
}

// Lazy-init cache for native custom model options from the login shell.
let NATIVE_CUSTOM_MODEL_OPTIONS: Array<{
  model_id: string;
  label: string;
  description: string;
}> = [];
let NATIVE_CUSTOM_MODEL_OPTIONS_LOADED = false;
let _onNativeOptionsLoaded: (() => void) | null = null;

export function initNativeCustomModelOptions(): void {
  if (NATIVE_CUSTOM_MODEL_OPTIONS_LOADED) return;
  NATIVE_CUSTOM_MODEL_OPTIONS_LOADED = true;
  bridge.getNativeCustomModelOptions()
    .then((opts) => {
      NATIVE_CUSTOM_MODEL_OPTIONS = opts;
      const selectedCustomModel = useSettingsStore.getState().customModelId;
      if (
        selectedCustomModel
        && !opts.some((option) => option.model_id === selectedCustomModel)
      ) {
        useSettingsStore.getState().setCustomModelId(null);
      }
      if (_onNativeOptionsLoaded) _onNativeOptionsLoaded();
    })
    .catch(() => {}); // Silently ignore — custom options are nice-to-have
}

/** Register a callback fired after native custom model options are loaded. */
export function onNativeCustomModelOptionsLoaded(cb: () => void): void {
  _onNativeOptionsLoaded = cb;
}

function formatKnownProviderModel(modelId: string): string {
  const match = modelId.match(/^(gpt|gemini|deepseek|glm|doubao|qwen|kimi|minimax)[-_](.+)$/i);
  if (!match) return modelId;
  const rawBrand = match[1].toLowerCase();
  const brand = rawBrand === 'gpt'
    ? 'GPT'
    : rawBrand === 'glm'
      ? 'GLM'
      : rawBrand === 'minimax'
        ? 'MiniMax'
        : match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  const suffix = match[2]
    .split(/[-_]/)
    .map((part) => {
      if (part.toLowerCase() === 'terra') return 'Tera';
      if (/^[mk]\d/i.test(part)) return part[0].toUpperCase() + part.slice(1);
      return /^(sol|luna|ultra|turbo|pro|flash|lite|code|max|mini|preview)$/i.test(part)
        ? part[0].toUpperCase() + part.slice(1).toLowerCase()
        : part;
    })
    .join(' ');
  return `${brand} ${suffix}`;
}

function titleCaseProviderModel(modelId: string): string {
  return getResolvedModelDisplayName(modelId);
}

/** Provider-backed sessions expose concrete upstream model names in ordinary UI. */
export function shouldUseProviderModelOptions(provider: ApiProvider | null): boolean {
  return Boolean(provider?.modelMappings.some(
    (mapping) => isModelTier(mapping.tier) && mapping.providerModel.trim().length > 0,
  ));
}

export function getModelDisplayOptions(
  provider: ApiProvider | null = useProviderStore.getState().getActive(),
): ModelDisplayOption[] {
  if (!shouldUseProviderModelOptions(provider)) return logicalModelDisplayOptions(provider === null);

  return MODEL_OPTIONS.flatMap((slot) => {
    const providerModel = provider!.modelMappings.find(
      (mapping) => mapping.tier === slot.id,
    )?.providerModel.trim();
    if (!providerModel) return [];
    const label = titleCaseProviderModel(providerModel);
    return [{
      id: slot.id,
      label,
      short: label,
      mapped: true,
      isExtra: false,
      providerModel,
      sourceTier: slot.id,
    }];
  });
}

/** Connection probes are intentionally limited to the inexpensive tiers. */
export function getProviderConnectionTestModel(
  mappings: readonly { tier: string; providerModel: string }[],
): string {
  for (const tier of ['haiku', 'sonnet']) {
    const model = mappings.find((mapping) => mapping.tier === tier)?.providerModel.trim();
    if (model) return model;
  }
  return '';
}

export function getSelectedModelOptionId(
  selectedModel: string,
  options: readonly ModelDisplayOption[],
  provider: ApiProvider | null = useProviderStore.getState().getActive(),
): string {
  const tier = normalizeModelTier(selectedModel);
  if (options.some((option) => option.id === tier)) return tier;
  const mapped = provider?.modelMappings.find((mapping) => mapping.tier === tier)?.providerModel.trim();
  return options.find((option) => option.providerModel === mapped)?.id
    ?? options[0]?.id
    ?? tier;
}

/** Resolve a raw runtime model name back to a user-facing tier when possible. */
export function getModelTierForResolvedModel(
  modelId: string,
  provider: ApiProvider | null = useProviderStore.getState().getActive(),
): ModelTier | null {
  const raw = modelId.trim();
  const lower = raw.toLowerCase();
  if (isModelTier(lower)) return lower;
  if (TIER_MAP[lower]) return TIER_MAP[lower];

  if (provider) {
    const selectedTier = useSettingsStore.getState().selectedModel;
    const selectedResolution = resolveModelOrError(selectedTier);
    if (selectedResolution.ok && selectedResolution.model === raw) return selectedTier;

    const mapping = provider.modelMappings.find(
      (entry) => entry.providerModel.trim().toLowerCase() === lower && isModelTier(entry.tier),
    );
    if (mapping && isModelTier(mapping.tier)) return mapping.tier;
  }

  if (lower.includes('fable')) return 'fable';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

export function getModelDisplayLabel(modelId: string): string {
  const tier = getModelTierForResolvedModel(modelId);
  return MODEL_OPTIONS.find((option) => option.id === tier)?.short ?? modelId;
}

/**
 * Format the concrete runtime model for status surfaces without hiding a
 * custom relay model behind its logical tier. Known provider ids get a compact
 * human label; unknown relay ids remain verbatim so users can verify them.
 */
export function getResolvedModelDisplayName(modelId: string): string {
  const raw = modelId.trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const oneMillion = lower.endsWith('-1m') || lower.endsWith('[1m]');
  const withoutContextSuffix = raw.replace(/(?:-1m|\[1m\])$/i, '');
  const normalized = withoutContextSuffix.toLowerCase();
  const match = normalized.match(
    /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/,
  );
  if (!match) {
    return `${formatKnownProviderModel(withoutContextSuffix)}${oneMillion ? ' (1M)' : ''}`;
  }
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${family} ${version}${oneMillion ? ' (1M)' : ''}`;
}

/**
 * Check whether the given model ID (or the currently selected model) uses
 * the 1M context window variant.
 *
 * 1M variants advertise themselves either via a `-1m` suffix (UI ids such as
 * `claude-opus-4-8-1m`) or a `[1m]` marker (CLI / provider ids such as
 * `claude-opus-4-8[1m]`). Standard variants (e.g. `claude-opus-4-8`) are 200K.
 */
export function is1MModel(modelId?: string): boolean {
  const raw = modelId ?? useSettingsStore.getState().selectedModel;
  let id = raw;
  if (isModelTier(raw)) {
    const resolution = resolveModelOrError(raw);
    if (!resolution.ok) return false;
    id = resolution.model;
  }
  const lower = id.toLowerCase();
  return lower.endsWith('-1m')
    || lower.includes('[1m]');
}

/**
 * Return the auto-compact token threshold for the given model.
 * 80% of context window: 160K for 200K models, 800K for 1M models.
 */
export function getAutoCompactThreshold(modelId?: string): number {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const override = Number((window as any).__blackbox_test_auto_compact_threshold);
    if (Number.isFinite(override) && override >= 0) return override;
  }
  return is1MModel(modelId) ? 800_000 : 160_000;
}

/**
 * Result of model resolution — either a mapped model name or an error.
 */
export type ModelResolution =
  | { ok: true; model: string }
  | { ok: false; reason: 'no_mapping'; tier: string; providerName: string };

export type SpawnConfigurationError =
  | Extract<ModelResolution, { ok: false }>
  | {
      ok: false;
      reason: 'provider_unavailable';
    }
  | {
      ok: false;
      reason: 'thinking_required';
      tier: ModelTier;
      providerName: string;
      model: string;
      minimumThinkingLevel: 'low';
    };

const OFFICIAL_KIMI_ANTHROPIC_ENDPOINT = 'https://api.moonshot.cn/anthropic';

function requiresThinkingForOfficialKimi(
  provider: ApiProvider | null,
  model: string,
): boolean {
  return provider?.preset === 'kimi'
    && provider.baseUrl.trim().replace(/\/+$/, '').toLowerCase()
      === OFFICIAL_KIMI_ANTHROPIC_ENDPOINT
    && model.trim().toLowerCase() === 'kimi-k2.7-code';
}

export function getSpawnConfigurationErrorMessage(
  error: SpawnConfigurationError,
  translate: (key: string) => string,
): string {
  if (error.reason === 'provider_unavailable') {
    return translate('provider.runtimeRouteUnavailable');
  }
  if (error.reason === 'thinking_required') {
    return translate('provider.thinkingRequired')
      .replace('{provider}', error.providerName)
      .replace('{model}', getResolvedModelDisplayName(error.model));
  }
  return translate('provider.noModelMapping')
    .replace('{provider}', error.providerName)
    .replace('{tier}', error.tier);
}

function resolveModelAgainstProvider(
  selectedModel: string,
  provider: ApiProvider | null,
): ModelResolution {
  const tier = normalizeModelTier(selectedModel);
  if (!provider) return { ok: true, model: DEFAULT_MODEL_FOR_TIER[tier] };

  // Preserve compatibility with old configs that keyed a direct mapping by an
  // exact model id instead of a logical tier.
  const directMapping = provider.modelMappings.find(
    (m) => m.tier === selectedModel && m.providerModel,
  );
  if (directMapping?.providerModel) {
    return { ok: true, model: directMapping.providerModel.trim() };
  }

  const mapping = provider.modelMappings.find(
    (m) => m.tier === tier && m.providerModel,
  );
  if (!mapping?.providerModel) {
    return { ok: false, reason: 'no_mapping', tier, providerName: provider.name };
  }
  return { ok: true, model: mapping.providerModel.trim() };
}

/**
 * Resolve the UI-selected model ID to the provider's actual model name,
 * returning an error if the provider has no mapping for the selected tier.
 */
export function resolveModelOrError(selectedModel: string): ModelResolution {
  const provider = useProviderStore.getState().getActive();
  const customModel = useSettingsStore.getState().customModelId;
  if (!provider && customModel) return { ok: true, model: customModel };
  return resolveModelAgainstProvider(selectedModel, provider);
}

export function resolveModelForProvider(selectedModel: string): string {
  const r = resolveModelOrError(selectedModel);
  if (!r.ok) {
    throw new Error(`Provider ${r.providerName} has no ${r.tier} model mapping`);
  }
  return r.model;
}

export type SpawnConfigurationCapture =
  | {
      ok: true;
      providerId: string;
      selectedModel: ModelTier;
      model: string;
      auxiliaryModelTier: ModelTier;
      auxiliaryModel: string;
      thinkingLevel: ThinkingLevel;
      agentTeamsEnabled: boolean;
      configHash: string;
      envFingerprint: string;
    }
  | SpawnConfigurationError;

/**
 * Capture every provider/model setting used by one CLI spawn in a single
 * synchronous read. Callers must keep using this returned object after any
 * await; re-reading the stores would mix a newly selected provider/model into
 * metadata for a process that was already started with the old configuration.
 */
export function captureSpawnConfiguration(): SpawnConfigurationCapture {
  const providerState = useProviderStore.getState();
  const settings = useSettingsStore.getState();
  const providerId = providerState.activeProviderId ?? '';
  const provider = providerState.providers.find((entry) => entry.id === providerId) ?? null;
  if (
    !providerId
    || !provider
    || !hasUsableProviderCredential(provider)
  ) {
    return { ok: false, reason: 'provider_unavailable' };
  }
  const selectedModel = normalizeModelTier(settings.selectedModel);
  const resolution = resolveModelAgainstProvider(selectedModel, provider);
  if (!resolution.ok) return resolution;
  const auxiliaryModelTier = normalizeModelTier(settings.auxiliaryModel);
  const auxiliaryResolution = resolveModelAgainstProvider(auxiliaryModelTier, provider);
  if (!auxiliaryResolution.ok) return auxiliaryResolution;

  if (settings.thinkingLevel === 'off') {
    const constrainedModel = [
      { tier: selectedModel, model: resolution.model },
      { tier: auxiliaryModelTier, model: auxiliaryResolution.model },
    ].find(({ model }) => requiresThinkingForOfficialKimi(provider, model));
    if (constrainedModel) {
      return {
        ok: false,
        reason: 'thinking_required',
        tier: constrainedModel.tier,
        providerName: provider?.name ?? 'Kimi',
        model: constrainedModel.model,
        minimumThinkingLevel: 'low',
      };
    }
  }

  const providerRevision = provider?.revision ?? 0;
  const providerUpdatedAt = provider?.updatedAt ?? 0;
  return {
    ok: true,
    providerId,
    selectedModel,
    model: resolution.model,
    auxiliaryModelTier,
    auxiliaryModel: auxiliaryResolution.model,
    thinkingLevel: settings.thinkingLevel,
    agentTeamsEnabled: settings.agentTeamsEnabled,
    configHash: [
      providerId,
      selectedModel,
      '', // retired native custom-model slot; retained for hash compatibility
      auxiliaryModelTier,
      settings.thinkingLevel,
      settings.agentTeamsEnabled ? 'teams' : 'solo',
      providerRevision,
      providerUpdatedAt,
    ].join('|'),
    envFingerprint: JSON.stringify({
      activeProviderId: providerState.activeProviderId,
      providerRevision,
      providerUpdatedAt,
    }),
  };
}

/**
 * Provider environment resolution happens in Rust from providers.json. Await
 * the store's serialized persistence barrier before capturing spawn metadata
 * so the UI snapshot and the backend environment describe the same revision.
 */
export async function flushAndCaptureSpawnConfiguration(): Promise<SpawnConfigurationCapture> {
  let providerState = useProviderStore.getState();
  if (!providerState.loaded) {
    await providerState.load();
    providerState = useProviderStore.getState();
  }
  await providerState.flushSave();
  return captureSpawnConfiguration();
}

export interface ResumeConfigurationSnapshot {
  providerId?: string | null;
  model?: string;
  envFingerprint?: string;
}

export interface ResumeConfigurationSwitch {
  providerSwitched: boolean;
  modelSwitched: boolean;
}

/**
 * Detect compatibility-sensitive drift before resuming a stopped session.
 *
 * A stopped process has no stdinId, so the live-process drift checks in
 * InputBar cannot run. The persisted spawn snapshot still identifies the
 * provider/model that produced the JSONL. Provider changes (including edits
 * to the same provider) and resolved-model changes require thinking-block
 * sanitization before --resume.
 *
 * Missing legacy fields fail open: without a previous value there is no safe
 * basis for declaring a switch.
 */
export function detectResumeConfigurationSwitch(
  previous: ResumeConfigurationSnapshot,
  current: ResumeConfigurationSnapshot,
): ResumeConfigurationSwitch {
  const providerIdChanged = previous.providerId !== undefined
    && current.providerId !== undefined
    && (previous.providerId ?? '') !== (current.providerId ?? '');
  const providerConfigChanged = previous.envFingerprint !== undefined
    && current.envFingerprint !== undefined
    && previous.envFingerprint !== current.envFingerprint;
  const modelSwitched = Boolean(
    previous.model
    && current.model
    && previous.model !== current.model,
  );

  return {
    providerSwitched: providerIdChanged || providerConfigChanged,
    modelSwitched,
  };
}

/**
 * Stable fingerprint of the current API provider config.
 * Any provider config change invalidates the pre-warmed session.
 */
export function envFingerprint(): string {
  const { activeProviderId, providers } = useProviderStore.getState();
  const provider = providers.find((p) => p.id === activeProviderId);
  return JSON.stringify({
    activeProviderId,
    providerRevision: provider?.revision ?? 0,
    providerUpdatedAt: provider?.updatedAt ?? 0,
  });
}

/**
 * Stable hash of the spawn-time CLI configuration.
 *
 * Captures every dimension whose change requires kill + respawn of the CLI
 * process: active provider, selected model, thinking level, Agent Teams opt-in,
 * the provider's persisted revision, and its monotonic local edit timestamp
 * (base URL / credential / mappings before persistence completes).
 *
 * Deliberately EXCLUDES `sessionMode` — mode switches go through the runtime
 * `set_permission_mode` SDK control protocol (see settingsStore.ts:364-389)
 * and must NOT trigger a respawn. See v3 plan appendix E.2 H2.
 */
export function spawnConfigHash(): string {
  const providerState = useProviderStore.getState();
  const settings = useSettingsStore.getState();
  const activeProvider = providerState.getActive();
  return [
    providerState.activeProviderId ?? '',
    settings.selectedModel,
    providerState.activeProviderId ? '' : settings.customModelId ?? '',
    settings.auxiliaryModel,
    settings.thinkingLevel,
    settings.agentTeamsEnabled ? 'teams' : 'solo',
    activeProvider?.revision ?? 0,
    activeProvider?.updatedAt ?? 0,
  ].join('|');
}
