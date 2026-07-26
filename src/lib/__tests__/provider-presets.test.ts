import { describe, expect, it } from 'vitest';
import {
  FIXED_PROVIDER_IDS,
  PROVIDER_PRESETS,
  inferProviderAuthScheme,
} from '../provider-presets';

describe('fixed Black Box provider catalog', () => {
  it('contains exactly the nine approved providers in user-facing order', () => {
    expect(FIXED_PROVIDER_IDS).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'deepseek',
      'zhipu',
      'doubao',
      'qwen',
      'minimax',
      'kimi',
    ]);
    expect(PROVIDER_PRESETS.map((preset) => preset.name)).toEqual([
      'Claude',
      'OpenAI',
      'Gemini',
      'DeepSeek',
      'GLM',
      '豆包',
      '千问',
      'MiniMax',
      'Kimi',
    ]);
  });

  it('gives every preset a usable endpoint, auth scheme, key page and four-tier mapping', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl).toMatch(/^https:\/\//);
      expect(['anthropic', 'openai', 'gemini']).toContain(preset.apiFormat);
      expect(['x-api-key', 'bearer', 'x-goog-api-key']).toContain(preset.authScheme);
      expect(preset.keyUrl).toMatch(/^https:\/\//);
      for (const tier of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
        expect(preset.defaultModels?.[tier] || preset.defaultModel).toBeTruthy();
      }
    }
  });

  it('uses bearer for OpenAI-compatible providers and preserves old custom Anthropic relays', () => {
    expect(inferProviderAuthScheme({ apiFormat: 'openai' })).toBe('bearer');
    expect(inferProviderAuthScheme({ apiFormat: 'gemini' })).toBe('x-goog-api-key');
    expect(inferProviderAuthScheme({ apiFormat: 'gemini', preset: 'gemini' })).toBe('x-goog-api-key');
    expect(inferProviderAuthScheme({ apiFormat: 'anthropic', preset: 'gemini' })).toBe('x-api-key');
    expect(inferProviderAuthScheme({ apiFormat: 'anthropic', preset: 'qwen' })).toBe('bearer');
    expect(inferProviderAuthScheme({ apiFormat: 'anthropic', preset: 'deepseek' })).toBe('x-api-key');
    expect(inferProviderAuthScheme({ apiFormat: 'anthropic', preset: 'zhipu' })).toBe('x-api-key');
    expect(inferProviderAuthScheme({ apiFormat: 'anthropic', preset: 'minimax' })).toBe('x-api-key');
    expect(inferProviderAuthScheme({ apiFormat: 'anthropic', preset: 'anthropic' })).toBe('x-api-key');
    expect(inferProviderAuthScheme({ apiFormat: 'anthropic' })).toBe('x-api-key');
  });

  it('pins each provider to the current official compatibility endpoint and four-tier mapping', () => {
    const snapshot = Object.fromEntries(PROVIDER_PRESETS.map((preset) => [preset.id, {
      baseUrl: preset.baseUrl,
      apiFormat: preset.apiFormat,
      authScheme: preset.authScheme,
      models: preset.defaultModels,
    }]));
    expect(snapshot).toEqual({
      anthropic: {
        baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', authScheme: 'x-api-key',
        models: { fable: 'claude-fable-5', opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001' },
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai', authScheme: 'bearer',
        models: { fable: 'gpt-5.5', opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.6-luna' },
      },
      gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiFormat: 'gemini', authScheme: 'x-goog-api-key',
        models: { fable: 'gemini-3.1-pro-preview', opus: 'gemini-3.1-pro-preview', sonnet: 'gemini-3.5-flash', haiku: 'gemini-3.1-flash-lite' },
      },
      deepseek: {
        baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic', authScheme: 'x-api-key',
        models: { fable: 'deepseek-v4-pro', opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-flash', haiku: 'deepseek-v4-flash' },
      },
      zhipu: {
        baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiFormat: 'anthropic', authScheme: 'x-api-key',
        models: { fable: 'glm-5.2', opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-4.7' },
      },
      doubao: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', apiFormat: 'anthropic', authScheme: 'bearer',
        models: { fable: 'doubao-seed-2.0-pro', opus: 'doubao-seed-2.0-code', sonnet: 'doubao-seed-2.0-lite', haiku: 'doubao-seed-2.0-lite' },
      },
      qwen: {
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', apiFormat: 'anthropic', authScheme: 'bearer',
        models: { fable: 'qwen3.7-plus', opus: 'qwen3.7-plus', sonnet: 'qwen3.6-plus', haiku: 'qwen3.5-plus' },
      },
      minimax: {
        baseUrl: 'https://api.minimaxi.com/anthropic', apiFormat: 'anthropic', authScheme: 'x-api-key',
        models: { fable: 'MiniMax-M3', opus: 'MiniMax-M3', sonnet: 'MiniMax-M2.7', haiku: 'MiniMax-M2.5' },
      },
      kimi: {
        baseUrl: 'https://api.moonshot.cn/anthropic', apiFormat: 'anthropic', authScheme: 'bearer',
        models: { fable: 'kimi-k3[1m]', opus: 'kimi-k2.7-code', sonnet: 'kimi-k2.6', haiku: 'kimi-k2.6' },
      },
    });
  });

  it('keeps official compatibility environment overrides on the provider transport field', () => {
    const minimax = PROVIDER_PRESETS.find((preset) => preset.id === 'minimax');
    expect(minimax?.extraEnv).toEqual({});
    const kimi = PROVIDER_PRESETS.find((preset) => preset.id === 'kimi');
    expect(kimi?.extraEnv).toEqual({
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
    });
  });
});
