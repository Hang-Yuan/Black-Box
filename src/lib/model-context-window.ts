export const CLAUDE_STANDARD_CONTEXT_WINDOW = 200_000;
export const CLAUDE_EXTENDED_CONTEXT_WINDOW = 1_000_000;

function normalizedModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * Return the largest context window officially available for a recognized
 * Claude model. Provider mappings often omit Claude Code's optional `[1m]`
 * marker even when that concrete model supports the extended window, so the
 * capability must come from the model id rather than a per-provider setting.
 */
export function getOfficialClaudeContextWindow(modelId: string): number | undefined {
  const model = normalizedModelId(modelId);
  if (!model) return undefined;

  if (model.includes('[1m]') || model.endsWith('-1m')) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }

  // Claude 5 frontier models use a 1M context window. Accept dated and minor
  // aliases such as claude-fable-5-1 without requiring provider-specific data.
  if (/^claude-(?:fable|opus|sonnet)-5(?:(?:-|\.)\d+)?(?:-|$)/u.test(model)) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }

  // These Claude 4.x releases expose an official 1M window. Black Box always
  // selects the largest official capacity instead of retaining a 200K tier.
  if (/^claude-opus-4-(?:6|7|8)(?:-|$)/u.test(model)
    || /^claude-sonnet-4-6(?:-|$)/u.test(model)) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }

  // Haiku 4.5 and older recognized Claude releases top out at 200K.
  if (/^claude-(?:fable|opus|sonnet|haiku)(?:-|$)/u.test(model)) {
    return CLAUDE_STANDARD_CONTEXT_WINDOW;
  }

  return undefined;
}

/** Resolve the active model's capacity, keeping manual values for unknown proxies. */
export function resolveModelContextWindow(
  modelId: string,
  configuredWindow?: number,
): number {
  const officialWindow = getOfficialClaudeContextWindow(modelId);
  if (officialWindow !== undefined) return officialWindow;

  if (
    typeof configuredWindow === 'number'
    && Number.isInteger(configuredWindow)
    && configuredWindow >= 1_024
  ) {
    return configuredWindow;
  }

  const normalized = normalizedModelId(modelId);
  if (normalized.includes('[1m]') || normalized.endsWith('-1m')) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }
  return CLAUDE_STANDARD_CONTEXT_WINDOW;
}
