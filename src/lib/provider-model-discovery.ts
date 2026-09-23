import type { ModelMapping } from '../stores/providerStore';

export const CLAUDE_MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

export type ClaudeModelTier = typeof CLAUDE_MODEL_TIERS[number];
export type DiscoveredClaudeModels = Partial<Record<ClaudeModelTier, string>>;

type RankedClaudeModel = {
  id: string;
  tier: ClaudeModelTier;
  version: number[];
};

function normalizeProviderModelId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function parseClaudeModel(value: string): RankedClaudeModel | null {
  const id = normalizeProviderModelId(value);
  const match = id.toLowerCase().match(
    /(?:^|\/)claude-(fable|opus|sonnet|haiku)-(\d+(?:(?:[.-])\d+)*)(?:-|\[|$)/u,
  );
  if (!match) return null;
  return {
    id,
    tier: match[1] as ClaudeModelTier,
    version: match[2].split(/[.-]/u).map(Number),
  };
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function compareClaudeModels(left: RankedClaudeModel, right: RankedClaudeModel): number {
  const versionDelta = compareVersion(left.version, right.version);
  if (versionDelta !== 0) return versionDelta;

  // When aliases share a semantic version, prefer the explicit dated snapshot.
  // It is immutable and remains valid even if a provider later repoints an alias.
  const leftDate = left.id.match(/-(\d{8})(?:\[1m\])?$/u)?.[1] ?? '';
  const rightDate = right.id.match(/-(\d{8})(?:\[1m\])?$/u)?.[1] ?? '';
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);

  return left.id.localeCompare(right.id);
}

/** Select the highest concrete Claude model returned by the current API key for each tier. */
export function selectHighestClaudeModels(modelIds: readonly string[]): DiscoveredClaudeModels {
  const selected: DiscoveredClaudeModels = {};
  const ranked = new Map<ClaudeModelTier, RankedClaudeModel>();

  for (const modelId of modelIds) {
    const candidate = parseClaudeModel(modelId);
    if (!candidate) continue;
    const current = ranked.get(candidate.tier);
    if (!current || compareClaudeModels(candidate, current) > 0) {
      ranked.set(candidate.tier, candidate);
      selected[candidate.tier] = candidate.id;
    }
  }

  return selected;
}

/**
 * Replace only discovered Claude tiers. Extra models and tiers absent from the
 * provider response remain user-owned and unchanged.
 */
export function mergeDiscoveredClaudeMappings(
  mappings: readonly ModelMapping[],
  discovered: DiscoveredClaudeModels,
): ModelMapping[] {
  const next = mappings.map((mapping) => ({ ...mapping }));

  for (const tier of CLAUDE_MODEL_TIERS) {
    const providerModel = discovered[tier];
    if (!providerModel) continue;
    const index = next.findIndex((mapping) => mapping.tier === tier);
    const replacement: ModelMapping = { tier, providerModel };
    if (index >= 0) next[index] = replacement;
    else next.push(replacement);
  }

  return next;
}
