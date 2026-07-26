export const NATIVE_GOAL_PROMPT_MAX_LENGTH = 12_000;

/**
 * Black Box does not implement Goal semantics. It only sends Claude Code's
 * runtime-owned slash command through the ordinary session transport.
 */
export function buildNativeGoalCommand(objective: string): string {
  const normalized = objective.trim();
  if (!normalized) throw new Error('Native Goal objective is required');
  if (normalized.length > NATIVE_GOAL_PROMPT_MAX_LENGTH) {
    throw new Error('Native Goal objective is too long');
  }
  return `/goal ${normalized}`;
}
