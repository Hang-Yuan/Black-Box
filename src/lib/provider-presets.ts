import providerCatalog from './provider-catalog.json';

export type ProviderApiFormat = 'anthropic' | 'openai' | 'gemini';
export type ProviderAuthScheme = 'x-api-key' | 'bearer' | 'x-goog-api-key';

export interface PresetProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: ProviderApiFormat;
  authScheme: ProviderAuthScheme;
  extraEnv: Record<string, string>;
  /** URL to the provider's API key management page */
  keyUrl?: string;
  /** Provider-level thinking support: full = native, ignored = param silently dropped, unknown = untested */
  thinkingSupport?: 'full' | 'ignored' | 'unknown';
  /** Default model for all tiers (non-Claude providers) */
  defaultModel?: string;
  /** Per-tier default models (takes precedence over defaultModel) */
  defaultModels?: {
    fable?: string;
    opus?: string;
    sonnet?: string;
    haiku?: string;
  };
}

function requiredStringRecord(
  value: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`Provider catalog field '${field}' must contain non-empty string values.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Shared JSON is the one authority for the fixed provider catalogue. Rust
 * embeds the same file for auth fallback and synthetic transport tests, so a
 * frontend preset cannot silently drift from the process-side gateway.
 */
export const PROVIDER_CATALOG_VERSION = providerCatalog.version;
export const PROVIDER_PRESETS: PresetProvider[] = providerCatalog.providers.map((provider) => ({
  ...provider,
  apiFormat: provider.apiFormat as ProviderApiFormat,
  authScheme: provider.authScheme as ProviderAuthScheme,
  thinkingSupport: provider.thinkingSupport as PresetProvider['thinkingSupport'],
  extraEnv: requiredStringRecord(provider.extraEnv, `${provider.id}.extraEnv`),
  defaultModels: requiredStringRecord(
    provider.defaultModels,
    `${provider.id}.defaultModels`,
  ) as PresetProvider['defaultModels'],
}));

export const FIXED_PROVIDER_IDS = PROVIDER_PRESETS.map((provider) => provider.id) as readonly string[];

/**
 * Preserve legacy custom providers exactly: old Anthropic-format entries used
 * x-api-key. Known fixed presets carry an explicit scheme when their protocol
 * still matches; OpenAI-compatible providers use Bearer and Gemini native
 * providers use Google's x-goog-api-key header.
 */
export function inferProviderAuthScheme(provider: {
  apiFormat: ProviderApiFormat;
  authScheme?: ProviderAuthScheme;
  preset?: string;
}): ProviderAuthScheme {
  if (
    provider.authScheme === 'x-api-key'
    || provider.authScheme === 'bearer'
    || provider.authScheme === 'x-goog-api-key'
  ) {
    return provider.authScheme;
  }
  if (provider.apiFormat === 'openai') return 'bearer';
  if (provider.apiFormat === 'gemini') return 'x-goog-api-key';
  const matchingPreset = PROVIDER_PRESETS.find(
    (preset) => preset.id === provider.preset && preset.apiFormat === provider.apiFormat,
  );
  return matchingPreset?.authScheme ?? 'x-api-key';
}
