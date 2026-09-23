export const NATIVE_GOAL_PROMPT_MAX_LENGTH = 4_000;

export type NativeGoalStatus = 'active' | 'achieved' | 'cleared';

export interface NativeGoalState {
  status: NativeGoalStatus;
  condition: string;
  setAt: number;
  updatedAt: number;
  reason?: string;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
}

export interface NativeGoalAttachment {
  type?: string;
  met?: boolean;
  sentinel?: boolean;
  condition?: string;
  reason?: string;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
}

const GOAL_CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

function goalTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Parse a native `/goal` payload without claiming ownership of its lifecycle. */
export function parseNativeGoalCommand(command: string): {
  action: 'set' | 'clear';
  condition?: string;
} | null {
  const match = command.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const argument = (match[1] || '').trim();
  if (!argument) return null;
  if (GOAL_CLEAR_WORDS.has(argument.toLowerCase())) return { action: 'clear' };
  return { action: 'set', condition: argument };
}

/**
 * Apply Claude Code's transcript-owned `goal_status` attachment. `sentinel`
 * marks explicit set/clear boundaries; evaluator checks omit it and only a
 * `met: true` evaluator record completes the goal.
 */
export function applyNativeGoalAttachment(
  current: NativeGoalState | undefined,
  attachment: NativeGoalAttachment | undefined,
  timestamp?: unknown,
): NativeGoalState | undefined {
  if (attachment?.type !== 'goal_status' || typeof attachment.condition !== 'string') {
    return current;
  }
  const condition = attachment.condition.trim();
  if (!condition) return current;
  const updatedAt = goalTimestamp(timestamp, current?.updatedAt ?? Date.now());
  const status: NativeGoalStatus = attachment.met === true
    ? (attachment.sentinel === true ? 'cleared' : 'achieved')
    : 'active';
  const sameGoal = current?.condition === condition;
  return {
    status,
    condition,
    setAt: sameGoal ? current.setAt : updatedAt,
    updatedAt,
    ...(typeof attachment.reason === 'string' && attachment.reason.trim()
      ? { reason: attachment.reason.trim() }
      : sameGoal && current?.reason ? { reason: current.reason } : {}),
    ...(typeof attachment.iterations === 'number'
      ? { iterations: attachment.iterations }
      : sameGoal && current?.iterations !== undefined ? { iterations: current.iterations } : {}),
    ...(typeof attachment.durationMs === 'number'
      ? { durationMs: attachment.durationMs }
      : sameGoal && current?.durationMs !== undefined ? { durationMs: current.durationMs } : {}),
    ...(typeof attachment.tokens === 'number'
      ? { tokens: attachment.tokens }
      : sameGoal && current?.tokens !== undefined ? { tokens: current.tokens } : {}),
  };
}

/** Recover the latest authoritative Goal state from a Claude JSONL transcript. */
export function deriveNativeGoalState(rawMessages: any[]): NativeGoalState | undefined {
  let state: NativeGoalState | undefined;
  for (const message of rawMessages) {
    state = applyNativeGoalAttachment(state, message?.attachment, message?.timestamp);
  }
  return state;
}

export function beginNativeGoal(condition: string, now = Date.now()): NativeGoalState {
  return {
    status: 'active',
    condition: condition.trim(),
    setAt: now,
    updatedAt: now,
  };
}

export function settleNativeGoal(
  current: NativeGoalState | undefined,
  status: Extract<NativeGoalStatus, 'achieved' | 'cleared'>,
  now = Date.now(),
): NativeGoalState | undefined {
  if (!current) return undefined;
  return { ...current, status, updatedAt: now };
}

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
