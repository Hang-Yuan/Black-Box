import { describe, it, expect, beforeEach, vi } from 'vitest';
import { is1MModel, getAutoCompactThreshold, resolveModelForProvider, resolveModelOrError } from '../lib/api-provider';
import { useProviderStore } from '../stores/providerStore';
import { normalizeModelTier, useSettingsStore } from '../stores/settingsStore';
import type { ApiProvider } from '../stores/providerStore';
import { migrateLegacyFableMapping } from '../stores/providerStore';
import { parseAndValidate } from '../lib/api-config';

vi.hoisted(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
    configurable: true,
  });
});

beforeEach(() => {
  useProviderStore.setState({
    providers: [],
    activeProviderId: null,
    loaded: true,
  });
  useSettingsStore.setState({ selectedModel: 'sonnet', auxiliaryModel: 'sonnet' });
});

function provider(id: string, suffix: string, mappings?: ApiProvider['modelMappings']): ApiProvider {
  return {
    id,
    name: `Provider ${id}`,
    baseUrl: 'https://api.example.com',
    apiFormat: 'anthropic',
    modelMappings: mappings ?? [
      { tier: 'fable', providerModel: `fable-${suffix}` },
      { tier: 'opus', providerModel: `opus-${suffix}` },
      { tier: 'sonnet', providerModel: `sonnet-${suffix}` },
      { tier: 'haiku', providerModel: `haiku-${suffix}` },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('model context routing', () => {
  it('treats only explicit 1M variants as 1M models', () => {
    // Standard variants are 200K; 1M is opt-in via -1m / [1m].
    expect(is1MModel('claude-fable-5')).toBe(false);
    expect(is1MModel('claude-fable-5-1m')).toBe(true);
    expect(is1MModel('claude-fable-5[1m]')).toBe(true);
    expect(is1MModel('claude-opus-4-8')).toBe(false);
    expect(is1MModel('claude-opus-4-8-1m')).toBe(true);
    expect(is1MModel('claude-opus-4-8[1m]')).toBe(true);
    expect(is1MModel('claude-opus-4-6-1m')).toBe(true);
    expect(is1MModel('mimo-v2-pro[1m]')).toBe(true);
    expect(is1MModel('claude-opus-4-6')).toBe(false);
    expect(getAutoCompactThreshold('claude-fable-5')).toBe(160_000);
    expect(getAutoCompactThreshold('claude-fable-5-1m')).toBe(800_000);
    expect(getAutoCompactThreshold('claude-opus-4-8')).toBe(160_000);
    expect(getAutoCompactThreshold('claude-opus-4-8-1m')).toBe(800_000);
    expect(getAutoCompactThreshold('claude-opus-4-6-1m')).toBe(800_000);
    expect(getAutoCompactThreshold('claude-opus-4-6')).toBe(160_000);
  });

  it('maps the four UI tiers to built-in native model ids', () => {
    expect(resolveModelForProvider('fable')).toBe('claude-fable-5');
    expect(resolveModelForProvider('opus')).toBe('claude-opus-4-8');
    expect(resolveModelForProvider('sonnet')).toBe('claude-sonnet-4-6');
    expect(resolveModelForProvider('haiku')).toBe('claude-haiku-4-5-20251001');
  });

  it('migrates legacy exact ids to logical tiers with Fable separate from Opus', () => {
    expect(normalizeModelTier('claude-fable-5-1m')).toBe('fable');
    expect(normalizeModelTier('claude-opus-4-8-1m')).toBe('opus');
    expect(normalizeModelTier('claude-sonnet-4-6')).toBe('sonnet');
    expect(normalizeModelTier('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  it('re-resolves the same selected tier when the active provider changes', () => {
    const p1 = provider('p1', 'alpha');
    const p2 = provider('p2', 'beta');
    useProviderStore.setState({ providers: [p1, p2], activeProviderId: 'p1' });
    useSettingsStore.setState({ selectedModel: 'sonnet' });
    expect(resolveModelForProvider(useSettingsStore.getState().selectedModel)).toBe('sonnet-alpha');

    useProviderStore.setState({ activeProviderId: 'p2' });
    expect(useSettingsStore.getState().selectedModel).toBe('sonnet');
    expect(resolveModelForProvider(useSettingsStore.getState().selectedModel)).toBe('sonnet-beta');
  });

  it('uses an independent Fable mapping and materializes legacy compatibility once', () => {
    const modern = provider('modern', 'x');
    useProviderStore.setState({ providers: [modern], activeProviderId: modern.id });
    expect(resolveModelForProvider('fable')).toBe('fable-x');
    expect(resolveModelForProvider('opus')).toBe('opus-x');

    const legacyMappings = [
      { tier: 'opus', providerModel: 'legacy-strong' },
      { tier: 'sonnet', providerModel: 'legacy-balanced' },
      { tier: 'haiku', providerModel: 'legacy-fast' },
    ];
    const migrated = migrateLegacyFableMapping(legacyMappings);
    expect(migrated).toContainEqual({ tier: 'fable', providerModel: 'legacy-strong' });
    const legacy = provider('legacy', 'x', migrated);
    useProviderStore.setState({ providers: [legacy], activeProviderId: legacy.id });
    expect(resolveModelForProvider('fable')).toBe('legacy-strong');
    expect(resolveModelForProvider('opus')).toBe('legacy-strong');
  });

  it('fails closed after an explicit tier mapping is removed', () => {
    const p = provider('strict', 'x', [
      { tier: 'opus', providerModel: 'strong' },
      { tier: 'sonnet', providerModel: 'balanced' },
      { tier: 'haiku', providerModel: 'fast' },
    ]);
    useProviderStore.setState({ providers: [p], activeProviderId: p.id });
    expect(resolveModelOrError('fable')).toEqual({
      ok: false,
      reason: 'no_mapping',
      tier: 'fable',
      providerName: 'Provider strict',
    });
    expect(() => resolveModelForProvider('fable')).toThrow(/no fable model mapping/);
  });

  it('reports a missing mapping instead of silently sending the tier name', () => {
    const p = provider('partial', 'x', [{ tier: 'haiku', providerModel: 'fast-only' }]);
    useProviderStore.setState({ providers: [p], activeProviderId: p.id });
    expect(resolveModelOrError('sonnet')).toEqual({
      ok: false,
      reason: 'no_mapping',
      tier: 'sonnet',
      providerName: 'Provider partial',
    });
  });

  it('derives context size from the provider mapping, not the tier label', () => {
    const p = provider('long', 'x', [
      { tier: 'opus', providerModel: 'mimo-v2-pro[1m]' },
      { tier: 'sonnet', providerModel: 'mimo-v2-omni' },
    ]);
    useProviderStore.setState({ providers: [p], activeProviderId: p.id });
    expect(is1MModel('opus')).toBe(true);
    expect(getAutoCompactThreshold('opus')).toBe(800_000);
    expect(is1MModel('sonnet')).toBe(false);
  });

  it('accepts all four tiers in imported provider mappings', () => {
    const parsed = parseAndValidate(JSON.stringify({
      version: 2,
      provider: {
        name: 'Imported',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        modelMappings: [
          { tier: 'fable', model: 'ultra' },
          { tier: 'opus', model: 'strong' },
          { tier: 'sonnet', model: 'balanced' },
          { tier: 'haiku', model: 'fast' },
        ],
      },
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.provider.modelMappings.map((mapping) => mapping.tier)).toEqual([
        'fable', 'opus', 'sonnet', 'haiku',
      ]);
    }
  });
});
