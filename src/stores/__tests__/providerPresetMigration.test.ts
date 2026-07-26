import { describe, expect, it } from 'vitest';
import {
  migrateKnownPresetDefaults,
  type ApiProvider,
} from '../providerStore';

function provider(overrides: Partial<ApiProvider>): ApiProvider {
  return {
    id: 'preset-provider',
    name: 'User-visible provider name',
    baseUrl: 'https://example.invalid',
    apiFormat: 'anthropic',
    modelMappings: [],
    credentialHint: '•••• 1234',
    credentialState: 'local_file',
    proxyUrl: 'http://127.0.0.1:7890',
    revision: 7,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

describe('known preset default migration', () => {
  it.each([
    {
      label: 'OpenAI',
      input: {
        preset: 'openai', baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai' as const,
        authScheme: 'bearer' as const,
        models: ['gpt-5.1', 'gpt-5.1', 'gpt-5-mini', 'gpt-5-nano'],
      },
      expected: {
        baseUrl: 'https://api.openai.com/v1', authScheme: 'bearer',
        models: ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      },
    },
    {
      label: 'DeepSeek',
      input: {
        preset: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic' as const,
        authScheme: 'bearer' as const,
        models: ['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash'],
      },
      expected: {
        baseUrl: 'https://api.deepseek.com/anthropic', authScheme: 'x-api-key',
        models: ['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash'],
      },
    },
    {
      label: 'GLM',
      input: {
        preset: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiFormat: 'anthropic' as const,
        authScheme: 'bearer' as const,
        models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7'],
      },
      expected: {
        baseUrl: 'https://open.bigmodel.cn/api/anthropic', authScheme: 'x-api-key',
        models: ['glm-5.2', 'glm-5.2', 'glm-5.2', 'glm-4.7'],
      },
    },
    {
      label: 'Doubao',
      input: {
        preset: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', apiFormat: 'anthropic' as const,
        authScheme: 'bearer' as const,
        models: ['doubao-seed-2.0-pro', 'doubao-seed-2.0-code', 'doubao-seed-2.0-lite', 'doubao-seed-2.0-mini'],
      },
      expected: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', authScheme: 'bearer',
        models: ['doubao-seed-2.0-pro', 'doubao-seed-2.0-code', 'doubao-seed-2.0-lite', 'doubao-seed-2.0-lite'],
      },
    },
  ])('upgrades the untouched $label development preset', ({ input, expected }) => {
    const legacy = provider({
      preset: input.preset,
      baseUrl: input.baseUrl,
      apiFormat: input.apiFormat,
      authScheme: input.authScheme,
      modelMappings: ['fable', 'opus', 'sonnet', 'haiku'].map((tier, index) => ({
        tier,
        providerModel: input.models[index],
      })),
    });
    const migrated = migrateKnownPresetDefaults(legacy);

    expect(migrated.baseUrl).toBe(expected.baseUrl);
    expect(migrated.authScheme).toBe(expected.authScheme);
    expect(migrated.modelMappings.map(({ providerModel }) => providerModel)).toEqual(expected.models);
  });

  it('migrates the untouched OpenAI-compatible Gemini preset to native v1beta without losing metadata', () => {
    const legacy = provider({
      preset: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      authScheme: 'bearer',
      modelMappings: [
        { tier: 'fable', providerModel: 'gemini-3.5-flash' },
        { tier: 'opus', providerModel: 'gemini-3.5-flash' },
        { tier: 'sonnet', providerModel: 'gemini-3.5-flash' },
        { tier: 'haiku', providerModel: 'gemini-3.1-flash-lite' },
      ],
    });

    expect(migrateKnownPresetDefaults(legacy)).toEqual({
      ...legacy,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiFormat: 'gemini',
      authScheme: 'x-goog-api-key',
      extraEnv: {},
      modelMappings: [
        { tier: 'fable', providerModel: 'gemini-3.1-pro-preview' },
        { tier: 'opus', providerModel: 'gemini-3.1-pro-preview' },
        { tier: 'sonnet', providerModel: 'gemini-3.5-flash' },
        { tier: 'haiku', providerModel: 'gemini-3.1-flash-lite' },
      ],
    });
  });

  it.each([
    {
      field: 'endpoint',
      patch: { baseUrl: 'https://relay.example.com/v1beta/openai' },
    },
    {
      field: 'model mapping',
      patch: {
        modelMappings: [
          { tier: 'fable', providerModel: 'gemini-3.5-flash' },
          { tier: 'opus', providerModel: 'my-private-gemini-route' },
          { tier: 'sonnet', providerModel: 'gemini-3.5-flash' },
          { tier: 'haiku', providerModel: 'gemini-3.1-flash-lite' },
        ],
      },
    },
    {
      field: 'extra environment',
      patch: { extraEnv: { GOOGLE_CLOUD_PROJECT: 'user-project' } },
    },
  ])('fully preserves a legacy Gemini OpenAI-compatible provider when its $field was customized', ({ patch }) => {
    const customized = provider({
      preset: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      authScheme: 'bearer',
      modelMappings: [
        { tier: 'fable', providerModel: 'gemini-3.5-flash' },
        { tier: 'opus', providerModel: 'gemini-3.5-flash' },
        { tier: 'sonnet', providerModel: 'gemini-3.5-flash' },
        { tier: 'haiku', providerModel: 'gemini-3.1-flash-lite' },
      ],
      ...patch,
    });

    expect(migrateKnownPresetDefaults(customized)).toBe(customized);
  });

  it('upgrades an untouched v0.14.1 Qwen preset and materializes Fable', () => {
    const legacy = provider({
      preset: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      authScheme: undefined,
      modelMappings: [
        { tier: 'opus', providerModel: 'qwen3-max' },
        { tier: 'sonnet', providerModel: 'qwen3.5-plus' },
        { tier: 'haiku', providerModel: 'qwen3.5-flash' },
      ],
    });

    expect(migrateKnownPresetDefaults(legacy)).toEqual({
      ...legacy,
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      authScheme: 'bearer',
      extraEnv: {},
      modelMappings: [
        { tier: 'fable', providerModel: 'qwen3.7-plus' },
        { tier: 'opus', providerModel: 'qwen3.7-plus' },
        { tier: 'sonnet', providerModel: 'qwen3.6-plus' },
        { tier: 'haiku', providerModel: 'qwen3.5-plus' },
      ],
    });
  });

  it('upgrades the development MiniMax snapshot without changing local credential metadata', () => {
    const legacy = provider({
      preset: 'minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      authScheme: 'bearer',
      modelMappings: [
        { tier: 'fable', providerModel: 'MiniMax-M2.7' },
        { tier: 'opus', providerModel: 'MiniMax-M2.7' },
        { tier: 'sonnet', providerModel: 'MiniMax-M2.5' },
        { tier: 'haiku', providerModel: 'MiniMax-M2.1' },
      ],
      extraEnv: {
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });
    const migrated = migrateKnownPresetDefaults(legacy);

    expect(migrated).toMatchObject({
      name: legacy.name,
      authScheme: 'x-api-key',
      modelMappings: [
        { tier: 'fable', providerModel: 'MiniMax-M3' },
        { tier: 'opus', providerModel: 'MiniMax-M3' },
        { tier: 'sonnet', providerModel: 'MiniMax-M2.7' },
        { tier: 'haiku', providerModel: 'MiniMax-M2.5' },
      ],
      extraEnv: {},
      credentialHint: legacy.credentialHint,
      credentialState: legacy.credentialState,
      proxyUrl: legacy.proxyUrl,
      revision: legacy.revision,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    });
  });

  it('upgrades the installed v0.14.1 Kimi preset including official runtime flags', () => {
    const legacy = provider({
      preset: 'kimi',
      baseUrl: 'https://api.moonshot.cn/anthropic/',
      authScheme: undefined,
      modelMappings: [
        { tier: 'opus', providerModel: 'kimi-k2.5' },
        { tier: 'sonnet', providerModel: 'kimi-k2' },
        { tier: 'haiku', providerModel: 'kimi-k2-turbo-preview' },
      ],
    });
    const migrated = migrateKnownPresetDefaults(legacy);

    expect(migrated.baseUrl).toBe('https://api.moonshot.cn/anthropic');
    expect(migrated.authScheme).toBe('bearer');
    expect(migrated.modelMappings.map(({ providerModel }) => providerModel)).toEqual([
      'kimi-k3[1m]',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.6',
    ]);
    expect(migrated.extraEnv).toEqual({
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
    });
  });

  it.each([
    {
      label: 'Gemini',
      preset: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiFormat: 'gemini' as const,
      authScheme: 'x-goog-api-key' as const,
      oldModels: [
        'gemini-3.5-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
      ],
      oldExtraEnv: {},
      expectedModels: [
        'gemini-3.1-pro-preview',
        'gemini-3.1-pro-preview',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
      ],
      expectedExtraEnv: {},
    },
    {
      label: 'MiniMax',
      preset: 'minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic' as const,
      authScheme: 'x-api-key' as const,
      oldModels: ['MiniMax-M3', 'MiniMax-M3', 'MiniMax-M3', 'MiniMax-M3'],
      oldExtraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
      expectedModels: ['MiniMax-M3', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
      expectedExtraEnv: {},
    },
    {
      label: 'Kimi',
      preset: 'kimi',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic' as const,
      authScheme: 'bearer' as const,
      oldModels: ['kimi-k2.7-code', 'kimi-k2.7-code', 'kimi-k2.7-code', 'kimi-k2.7-code'],
      oldExtraEnv: {
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
      },
      expectedModels: ['kimi-k3[1m]', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.6'],
      expectedExtraEnv: {
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
      },
    },
  ])('audits and migrates an untouched catalog-v2 $label preset', ({
    preset,
    baseUrl,
    apiFormat,
    authScheme,
    oldModels,
    oldExtraEnv,
    expectedModels,
    expectedExtraEnv,
  }) => {
    const legacy = provider({
      preset,
      baseUrl,
      apiFormat,
      authScheme,
      modelMappings: ['fable', 'opus', 'sonnet', 'haiku'].map((tier, index) => ({
        tier,
        providerModel: oldModels[index],
      })),
      extraEnv: oldExtraEnv as Record<string, string>,
    });

    const migrated = migrateKnownPresetDefaults(legacy);
    expect(migrated).not.toBe(legacy);
    expect(migrated.modelMappings.map(({ providerModel }) => providerModel)).toEqual(expectedModels);
    expect(migrated.extraEnv).toEqual(expectedExtraEnv);
    expect(migrateKnownPresetDefaults(migrated)).toBe(migrated);
  });

  it('preserves the whole provider when one model mapping was customized', () => {
    const customized = provider({
      preset: 'minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      authScheme: 'bearer',
      modelMappings: [
        { tier: 'fable', providerModel: 'MiniMax-M2.7' },
        { tier: 'opus', providerModel: 'my-private-minimax-route' },
        { tier: 'sonnet', providerModel: 'MiniMax-M2.5' },
        { tier: 'haiku', providerModel: 'MiniMax-M2.1' },
      ],
      extraEnv: {
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });

    expect(migrateKnownPresetDefaults(customized)).toBe(customized);
  });

  it('preserves the whole provider when its endpoint or environment was customized', () => {
    const customEndpoint = provider({
      preset: 'qwen',
      baseUrl: 'https://relay.example.com/apps/anthropic',
      authScheme: 'bearer',
      modelMappings: [
        { tier: 'fable', providerModel: 'qwen3.7-max' },
        { tier: 'opus', providerModel: 'qwen3.7-plus' },
        { tier: 'sonnet', providerModel: 'qwen3.6-plus' },
        { tier: 'haiku', providerModel: 'qwen3.6-flash' },
      ],
    });
    const customEnvironment = provider({
      preset: 'minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      authScheme: 'bearer',
      modelMappings: [
        { tier: 'fable', providerModel: 'MiniMax-M2.7' },
        { tier: 'opus', providerModel: 'MiniMax-M2.7' },
        { tier: 'sonnet', providerModel: 'MiniMax-M2.5' },
        { tier: 'haiku', providerModel: 'MiniMax-M2.1' },
      ],
      extraEnv: { API_TIMEOUT_MS: '9000000' },
    });

    expect(migrateKnownPresetDefaults(customEndpoint)).toBe(customEndpoint);
    expect(migrateKnownPresetDefaults(customEnvironment)).toBe(customEnvironment);
  });

  it('is idempotent for a current preset snapshot', () => {
    const current = provider({
      preset: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authScheme: 'x-api-key',
      modelMappings: [
        { tier: 'fable', providerModel: 'deepseek-v4-pro' },
        { tier: 'opus', providerModel: 'deepseek-v4-pro' },
        { tier: 'sonnet', providerModel: 'deepseek-v4-flash' },
        { tier: 'haiku', providerModel: 'deepseek-v4-flash' },
      ],
      extraEnv: {},
    });

    expect(migrateKnownPresetDefaults(current)).toBe(current);
  });
});
