const INTERRUPTED_CONTINUATION_PREFIX =
  '系统注记：你上一条回复在用户手动停止前，已经输出了下面这段未完成正文。';
const INTERRUPTED_CONTINUATION_NEXT_USER_LABEL =
  '用户接下来的消息是基于这段已输出内容的后续指令：';

/** Build the runtime-only recovery envelope sent to Claude after an explicit Stop. */
export function buildInterruptedContinuationPrompt(
  interruptedAssistantText: string,
  nextUserText: string,
): string {
  const cleanInterrupted = interruptedAssistantText.trim();
  const cleanNext = nextUserText.trim();
  if (!cleanInterrupted) return cleanNext;
  return [
    INTERRUPTED_CONTINUATION_PREFIX,
    '请把它视为本会话里你刚刚已经写出的内容，在此基础上继续，不要声称之前没有写过这些内容。',
    '已输出正文：',
    cleanInterrupted,
    INTERRUPTED_CONTINUATION_NEXT_USER_LABEL,
    cleanNext,
  ].join('\n\n');
}

/**
 * Recover the user-authored text from a runtime continuation envelope.
 *
 * Claude persists the outbound runtime payload in JSONL. Disk hydration must
 * project the original user message, not the private recovery instructions or
 * the already-visible interrupted assistant text embedded in that payload.
 */
export function unwrapInterruptedContinuationPrompt(value: string): string {
  const text = value.trim();
  if (!text.startsWith(INTERRUPTED_CONTINUATION_PREFIX)) return value;

  const marker = `\n\n${INTERRUPTED_CONTINUATION_NEXT_USER_LABEL}\n\n`;
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return value;
  return text.slice(markerIndex + marker.length).trim();
}
