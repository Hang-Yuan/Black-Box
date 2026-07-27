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
