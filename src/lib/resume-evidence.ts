import type { ChatMessage } from '../stores/chatStore';

const STRUCTURED_ASSISTANT_EVIDENCE = new Set<ChatMessage['type']>([
  'tool_use',
  'question',
  'todo',
  'plan_review',
  'permission',
]);

/**
 * Decide whether the visible transcript proves that Claude already accepted
 * this thread. Tool-only turns count even though their display `content` is
 * intentionally empty; otherwise a reload silently starts a fresh thread for
 * code-heavy conversations that have not emitted prose yet.
 */
export function hasResumableConversationEvidence(messages: ChatMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'assistant') return false;
    if (STRUCTURED_ASSISTANT_EVIDENCE.has(message.type)) return true;
    return message.content.trim().length > 0;
  });
}

interface DurableResumeEvidence {
  messages: ChatMessage[];
  turnAcceptedForResume?: boolean;
  sessionPath?: string | null;
}

/**
 * A durable JSONL path is stronger evidence than the presentation layer. The
 * parser deliberately hides compact summaries and other CLI metadata, so a
 * compacted/legacy session can have little or no visible assistant prose while
 * still being a valid `--resume` target.
 */
export function shouldAttemptDurableResume(evidence: DurableResumeEvidence): boolean {
  return evidence.turnAcceptedForResume === true
    || Boolean(evidence.sessionPath?.trim())
    || hasResumableConversationEvidence(evidence.messages);
}
