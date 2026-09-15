import {
  isCliPlaceholder,
  sanitizeAssistantTextForDisplay,
} from './presentation-sanitizer';

export interface ContextDropUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ContextDropRecoveryCandidate {
  prompt?: string;
  response?: string;
  usage?: ContextDropUsage;
  subtype?: string;
  attempts?: number;
}

export const EMPTY_TERMINAL_RECOVERY_LIMIT = 3;
export const EMPTY_TERMINAL_RECOVERY_PROMPT = [
  'Continue the unfinished task from the current durable session.',
  'The previous turn returned without a user-visible final response.',
  'Do not repeat completed work. Inspect the latest tool results and durable receipts,',
  'finish the pending steps, and end with a concise user-visible result.',
].join(' ');

export type EmptyTerminalRecoveryAction =
  | 'none'
  | 'retry'
  | 'resume_after_compact'
  | 'fail';

export interface EmptyTerminalRecoveryCandidate {
  subtype?: string;
  activeTurnInput?: string;
  awaitingVisibleAssistantResponse?: boolean;
  resultAddsVisibleText?: boolean;
  attempts?: number;
  stdinAvailable?: boolean;
  pendingCommand?: boolean;
  recoveryCompactPending?: boolean;
}

const GENERIC_GREETING_RESPONSES = new Set([
  'hi how can i help you today',
  'hello how can i help you today',
  'hi there how can i help you today',
]);

const GREETING_ONLY_PROMPTS = /^(?:hi|hello|hey|你好|您好|嗨|哈喽|在吗|早上好|下午好|晚上好)[!！,.，。?\s]*$/iu;

function normalizeGreeting(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[’']/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function isGenericContextGreeting(value: string | undefined): boolean {
  if (!value) return false;
  return GENERIC_GREETING_RESPONSES.has(normalizeGreeting(value));
}

export function isGreetingOnlyPrompt(value: string | undefined): boolean {
  if (!value) return true;
  return GREETING_ONLY_PROMPTS.test(value.trim());
}

/**
 * A terminal turn is trustworthy only after the root assistant produced text
 * that survives presentation sanitization, or an interactive question that is
 * itself the user-visible response. Thinking and ordinary tool calls are
 * progress evidence, but they do not close the user's turn.
 */
export function assistantContentHasVisibleTerminalResponse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== 'object') return true;
    const candidate = block as { type?: unknown; text?: unknown; name?: unknown };
    if (candidate.type === 'text') {
      if (typeof candidate.text !== 'string' || isCliPlaceholder(candidate.text)) return false;
      return sanitizeAssistantTextForDisplay(candidate.text).trim().length > 0;
    }
    if (candidate.type === 'tool_use') {
      return candidate.name === 'AskUserQuestion';
    }
    if (candidate.type === 'thinking' || candidate.type === 'redacted_thinking') {
      return false;
    }
    // Unknown future block types fail closed: do not risk replaying a turn that
    // may already have produced a visible or interactive result.
    return true;
  });
}

/** Anthropic reports cached and uncached input separately; all three occupy context. */
export function effectiveContextInputTokens(usage: ContextDropUsage | undefined): number {
  return [
    usage?.input_tokens,
    usage?.cache_creation_input_tokens,
    usage?.cache_read_input_tokens,
  ].reduce((sum: number, value) => (
    sum + (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  ), 0);
}

/** Report occupancy separately from advice; 60% is not "nearly full". */
export function projectContextPressure(inputTokens: number, contextWindow: number) {
  const used = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 200_000;
  const ratio = used / window;
  return { used, window, percent: Math.round(ratio * 100), visible: ratio >= 0.6, high: ratio >= 0.8 };
}

/**
 * Decide one bounded recovery step for a successful CLI result that did not
 * close the user's turn with visible output.
 */
export function decideEmptyTerminalRecovery(
  candidate: EmptyTerminalRecoveryCandidate,
): EmptyTerminalRecoveryAction {
  if (candidate.recoveryCompactPending) {
    return candidate.subtype === 'success' && candidate.stdinAvailable
      ? 'resume_after_compact'
      : 'none';
  }
  if (
    candidate.subtype !== 'success'
    || !candidate.activeTurnInput?.trim()
    || !candidate.awaitingVisibleAssistantResponse
    || candidate.resultAddsVisibleText
    || candidate.pendingCommand
  ) {
    return 'none';
  }
  const attempts = candidate.attempts ?? 0;
  if (!candidate.stdinAvailable || attempts >= EMPTY_TERMINAL_RECOVERY_LIMIT) {
    return 'fail';
  }
  return 'retry';
}

/**
 * A resumed Claude turn occasionally reaches a provider with only the tiny
 * hook/preamble payload. The transcript still records the user's real prompt,
 * but the response is the fixed eight-token greeting and no cached context was
 * consumed. Retry only this narrow signature, once, so ordinary greetings and
 * legitimate short answers remain untouched.
 */
export function shouldRetryContextDrop(
  candidate: ContextDropRecoveryCandidate,
): boolean {
  const usage = candidate.usage;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;

  return candidate.subtype === 'success'
    && (candidate.attempts ?? 0) < 1
    && !isGreetingOnlyPrompt(candidate.prompt)
    && isGenericContextGreeting(candidate.response)
    && inputTokens > 0
    && inputTokens <= 32
    && outputTokens > 0
    && outputTokens <= 24
    && cacheCreationTokens === 0
    && cacheReadTokens === 0;
}

export function classifySessionSilence(input: { now: number; lastProgressAt?: number; alive?: boolean; waitingForUser?: boolean }) {
  if (input.alive === false) return 'dead' as const;
  if (input.waitingForUser) return 'waiting' as const;
  const silence = input.lastProgressAt ? Math.max(0, input.now - input.lastProgressAt) : 0;
  if (silence >= 300_000) return 'stalled' as const;
  if (silence >= 120_000) return 'slow' as const;
  return 'active' as const;
}
