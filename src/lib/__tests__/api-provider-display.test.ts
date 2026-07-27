import { describe, it, expect } from 'vitest';
import {
  getModelDisplayOptions,
  getSelectedModelOptionId,
  getProviderConnectionTestModel,
  getResolvedModelDisplayName,
  shouldUseProviderModelOptions,
} from '../api-provider';
import type { ApiProvider } from '../../stores/providerStore';

function provider(overrides: Partial<ApiProvider> = {}): ApiProvider {
  return {
    id: 'p1',
    name: 'Provider',
    baseUrl: 'https://api.example.com',
    apiFormat: 'anthropic',
    modelMappings: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('provider model display options', () => {
  it('shows exactly four logical tiers without exact model versions', () => {
    const options = getModelDisplayOptions(null);
    expect(options.map((option) => option.short)).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku']);
    expect(options.map((option) => option.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(JSON.stringify(options)).not.toMatch(/4[.-][0-9]|1M|glm|kimi/i);
  });

  it('shows each provider concrete model in the ordinary picker', () => {
    const p = provider({
      modelMappings: [
        { tier: 'fable', providerModel: 'glm-5-ultra' },
        { tier: 'opus', providerModel: 'glm-5' },
        { tier: 'sonnet', providerModel: 'glm-5-turbo' },
        { tier: 'haiku', providerModel: 'glm-4.7' },
      ],
    });

    expect(shouldUseProviderModelOptions(p)).toBe(true);
    expect(getModelDisplayOptions(p).map((option) => option.short)).toEqual([
      'GLM 5 Ultra', 'GLM 5', 'GLM 5 Turbo', 'GLM 4.7',
    ]);
  });

  it('keeps four selectable slots when a provider maps several tiers to one model', () => {
    const p = provider({
      modelMappings: [
        { tier: 'fable', providerModel: 'kimi-for-coding' },
        { tier: 'opus', providerModel: 'kimi-for-coding' },
        { tier: 'sonnet', providerModel: 'kimi-for-coding' },
        { tier: 'haiku', providerModel: 'kimi-for-coding' },
      ],
    });

    const options = getModelDisplayOptions(p);
    expect(options.map((option) => option.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(options.map((option) => option.providerModel)).toEqual([
      'kimi-for-coding',
      'kimi-for-coding',
      'kimi-for-coding',
      'kimi-for-coding',
    ]);
    expect(getSelectedModelOptionId('sonnet', options, p)).toBe('sonnet');
  });

  it.each([
    {
      name: 'Gemini',
      mappings: [
        'gemini-3.1-pro-preview',
        'gemini-3.1-pro-preview',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
      ],
      labels: [
        'Gemini 3.1 Pro Preview',
        'Gemini 3.1 Pro Preview',
        'Gemini 3.5 Flash',
        'Gemini 3.1 Flash Lite',
      ],
    },
    {
      name: 'MiniMax',
      mappings: ['MiniMax-M3', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
      labels: ['MiniMax M3', 'MiniMax M3', 'MiniMax M2.7', 'MiniMax M2.5'],
    },
    {
      name: 'Kimi',
      mappings: ['kimi-k3[1m]', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.6'],
      labels: ['Kimi K3 (1M)', 'Kimi K2.7 Code', 'Kimi K2.6', 'Kimi K2.6'],
    },
  ])('keeps four logical $name slots even when official model ids repeat', ({ mappings, labels }) => {
    const p = provider({
      modelMappings: ['fable', 'opus', 'sonnet', 'haiku'].map((tier, index) => ({
        tier,
        providerModel: mappings[index],
      })),
    });
    const options = getModelDisplayOptions(p);

    expect(options.map((option) => option.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(options.map((option) => option.providerModel)).toEqual(mappings);
    expect(options.map((option) => option.short)).toEqual(labels);
    expect(getSelectedModelOptionId('haiku', options, p)).toBe('haiku');
  });

  it('renders Claude concrete names without exposing storage slots', () => {
    const p = provider({
      modelMappings: [
        { tier: 'fable', providerModel: 'claude-fable-5' },
        { tier: 'opus', providerModel: 'claude-opus-4-8' },
        { tier: 'sonnet', providerModel: 'claude-sonnet-4-6' },
        { tier: 'haiku', providerModel: 'claude-haiku-4-5-20251001' },
      ],
    });

    expect(shouldUseProviderModelOptions(p)).toBe(true);
    expect(getModelDisplayOptions(p).map((option) => option.short)).toEqual([
      'Fable 5', 'Opus 4.8', 'Sonnet 4.6', 'Haiku 4.5',
    ]);
  });

  it('shows the four configured OpenAI gateway aliases directly', () => {
    const p = provider({
      modelMappings: [
        { tier: 'fable', providerModel: 'gpt-5.5' },
        { tier: 'opus', providerModel: 'gpt-5.6-sol' },
        { tier: 'sonnet', providerModel: 'gpt-5.6-terra' },
        { tier: 'haiku', providerModel: 'gpt-5.6-luna' },
      ],
    });
    expect(getModelDisplayOptions(p).map((option) => option.short)).toEqual([
      'GPT 5.5', 'GPT 5.6 Sol', 'GPT 5.6 Tera', 'GPT 5.6 Luna',
    ]);
  });

  it('normalizes legacy exact selections to separate logical tiers', () => {
    const options = getModelDisplayOptions();
    expect(getSelectedModelOptionId('claude-fable-5', options)).toBe('fable');
    expect(getSelectedModelOptionId('claude-opus-4-6', options)).toBe('opus');
    expect(getSelectedModelOptionId('claude-sonnet-4-6', options)).toBe('sonnet');
    expect(getSelectedModelOptionId('claude-haiku-4-5-20251001', options)).toBe('haiku');
  });

  it('uses Haiku then Sonnet for connection probes and never Opus/Fable', () => {
    expect(getProviderConnectionTestModel([
      { tier: 'fable', providerModel: 'expensive-fable' },
      { tier: 'opus', providerModel: 'expensive-opus' },
      { tier: 'sonnet', providerModel: 'balanced-sonnet' },
      { tier: 'haiku', providerModel: 'fast-haiku' },
    ])).toBe('fast-haiku');
    expect(getProviderConnectionTestModel([
      { tier: 'opus', providerModel: 'expensive-opus' },
      { tier: 'sonnet', providerModel: 'balanced-sonnet' },
    ])).toBe('balanced-sonnet');
    expect(getProviderConnectionTestModel([
      { tier: 'opus', providerModel: 'expensive-opus' },
    ])).toBe('');
  });

  it('shows the concrete runtime model without hiding custom relay mappings', () => {
    expect(getResolvedModelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(getResolvedModelDisplayName('claude-opus-4-8[1m]')).toBe('Opus 4.8 (1M)');
    expect(getResolvedModelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(getResolvedModelDisplayName('gpt-5.6-terra')).toBe('GPT 5.6 Tera');
    expect(getResolvedModelDisplayName('kimi-k3[1m]')).toBe('Kimi K3 (1M)');
    expect(getResolvedModelDisplayName('kimi-k2.7-code')).toBe('Kimi K2.7 Code');
    expect(getResolvedModelDisplayName('MiniMax-M2.7')).toBe('MiniMax M2.7');
    expect(getResolvedModelDisplayName('relay-sonnet-v5')).toBe('relay-sonnet-v5');
  });
});
