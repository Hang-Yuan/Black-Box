import { describe, expect, it } from 'vitest';
import {
  mergeDiscoveredClaudeMappings,
  selectHighestClaudeModels,
} from '../provider-model-discovery';

describe('provider model discovery', () => {
  it('selects the highest provider-visible model for every Claude family', () => {
    expect(selectHighestClaudeModels([
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
    ])).toEqual({
      fable: 'claude-fable-5-1',
      opus: 'claude-opus-5-5',
      sonnet: 'claude-sonnet-5',
      haiku: 'claude-haiku-4-5-20251001',
    });
  });

  it('understands dotted versions and provider namespaces', () => {
    expect(selectHighestClaudeModels([
      'models/claude-opus-5.4',
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.1',
    ])).toEqual({
      opus: 'anthropic/claude-opus-5.5',
      sonnet: 'anthropic/claude-sonnet-5.1',
    });
  });

  it('updates discovered tiers while preserving user extras and absent families', () => {
    expect(mergeDiscoveredClaudeMappings([
      { tier: 'fable', providerModel: 'manual-fable', contextWindowTokens: 20_000 },
      { tier: 'opus', providerModel: 'claude-opus-4-8', contextWindowTokens: 200_000 },
      { tier: 'sonnet', providerModel: 'manual-sonnet' },
      { tier: 'custom', providerModel: 'relay/custom' },
    ], {
      opus: 'claude-opus-5-5',
      haiku: 'claude-haiku-4-5-20251001',
    })).toEqual([
      { tier: 'fable', providerModel: 'manual-fable', contextWindowTokens: 20_000 },
      { tier: 'opus', providerModel: 'claude-opus-5-5' },
      { tier: 'sonnet', providerModel: 'manual-sonnet' },
      { tier: 'custom', providerModel: 'relay/custom' },
      { tier: 'haiku', providerModel: 'claude-haiku-4-5-20251001' },
    ]);
  });
});
