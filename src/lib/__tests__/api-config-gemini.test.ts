import { describe, expect, it } from 'vitest';
import { exportProvider, parseAndValidate } from '../api-config';
import type { ApiProvider } from '../../stores/providerStore';

describe('Gemini native provider config', () => {
  it('accepts and normalizes the native Gemini protocol and auth header', () => {
    const parsed = parseAndValidate(JSON.stringify({
      version: 2,
      provider: {
        name: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
        apiFormat: 'gemini',
        authScheme: 'x-goog-api-key',
        modelMappings: [
          { tier: 'fable', model: 'gemini-3.5-flash' },
          { tier: 'opus', model: 'gemini-3.5-flash' },
          { tier: 'sonnet', model: 'gemini-3.5-flash' },
          { tier: 'haiku', model: 'gemini-3.1-flash-lite' },
        ],
      },
    }));

    expect(parsed).toEqual({
      ok: true,
      provider: {
        name: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiFormat: 'gemini',
        authScheme: 'x-goog-api-key',
        modelMappings: [
          { tier: 'fable', providerModel: 'gemini-3.5-flash' },
          { tier: 'opus', providerModel: 'gemini-3.5-flash' },
          { tier: 'sonnet', providerModel: 'gemini-3.5-flash' },
          { tier: 'haiku', providerModel: 'gemini-3.1-flash-lite' },
        ],
      },
    });
  });

  it.each([
    ['gemini', 'bearer'],
    ['gemini', 'x-api-key'],
    ['openai', 'x-api-key'],
    ['openai', 'x-goog-api-key'],
    ['anthropic', 'x-goog-api-key'],
  ])('rejects the invalid %s + %s protocol/auth combination', (apiFormat, authScheme) => {
    const parsed = parseAndValidate(JSON.stringify({
      version: 2,
      provider: {
        name: 'Invalid transport',
        baseUrl: 'https://api.example.com',
        apiFormat,
        authScheme,
        modelMappings: [],
      },
    }));

    expect(parsed).toEqual({
      ok: false,
      error: `鉴权方式 ${authScheme} 不适用于 ${apiFormat} 协议`,
    });
  });

  it.each([
    ['anthropic', 'x-api-key'],
    ['anthropic', 'bearer'],
    ['openai', 'bearer'],
    ['gemini', 'x-goog-api-key'],
  ])('accepts the supported %s + %s protocol/auth combination', (apiFormat, authScheme) => {
    const parsed = parseAndValidate(JSON.stringify({
      version: 2,
      provider: {
        name: 'Valid transport',
        baseUrl: 'https://api.example.com',
        apiFormat,
        authScheme,
        modelMappings: [],
      },
    }));

    expect(parsed.ok).toBe(true);
  });

  it('exports the native transport without exposing an API key', () => {
    const provider: ApiProvider = {
      id: 'gemini',
      name: 'Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiFormat: 'gemini',
      authScheme: 'x-goog-api-key',
      apiKey: 'test-secret-must-not-export',
      modelMappings: [
        { tier: 'fable', providerModel: 'gemini-3.5-flash', contextWindowTokens: 1_000_000 },
        { tier: 'opus', providerModel: 'gemini-3.5-flash' },
        { tier: 'sonnet', providerModel: 'gemini-3.5-flash' },
        { tier: 'haiku', providerModel: 'gemini-3.1-flash-lite' },
      ],
      createdAt: 1,
      updatedAt: 2,
    };

    const exported = JSON.parse(exportProvider(provider));
    expect(exported.provider).toMatchObject({
      apiFormat: 'gemini',
      authScheme: 'x-goog-api-key',
    });
    expect(exported.provider.modelMappings[0]).toEqual({
      tier: 'fable',
      model: 'gemini-3.5-flash',
      contextWindowTokens: 1_000_000,
    });
    expect(exported.provider).not.toHaveProperty('apiKey');
  });

  it('imports a per-model context capacity and rejects invalid capacities', () => {
    const valid = parseAndValidate(JSON.stringify({
      version: 2,
      provider: {
        name: 'Relay',
        baseUrl: 'https://relay.example.com',
        apiFormat: 'anthropic',
        modelMappings: [
          { tier: 'fable', model: 'relay-large', contextWindowTokens: 1_000_000 },
          { tier: 'haiku', model: 'relay-small', contextWindowTokens: 20_000 },
        ],
      },
    }));

    expect(valid).toMatchObject({
      ok: true,
      provider: {
        modelMappings: [
          { tier: 'fable', providerModel: 'relay-large', contextWindowTokens: 1_000_000 },
          { tier: 'haiku', providerModel: 'relay-small', contextWindowTokens: 20_000 },
        ],
      },
    });

    const invalid = parseAndValidate(JSON.stringify({
      version: 2,
      provider: {
        name: 'Relay',
        baseUrl: 'https://relay.example.com',
        apiFormat: 'anthropic',
        modelMappings: [
          { tier: 'fable', model: 'relay-large', contextWindowTokens: 20_000.5 },
        ],
      },
    }));
    expect(invalid).toEqual({
      ok: false,
      error: '模型 fable 的 contextWindowTokens 应为 1024 到 10000000 之间的整数',
    });
  });
});
