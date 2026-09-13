import type { ChatMessage } from '../stores/chatStore';

/** Treat an unnumbered conversation as part 1; increment only its final digits. */
export function nextConversationTitle(title: string): string {
  const name = title.trim();
  const suffix = name.match(/[0-9]+$/);
  if (!suffix) return `${name}2`;
  return `${name.slice(0, suffix.index)}${BigInt(suffix[0]) + BigInt(1)}`;
}

/** A bounded, visible handoff can be inspected before sending a fresh session. */
export function buildConversationHandoff(messages: readonly ChatMessage[], sourceId: string) {
  const publicMessages = messages.filter((message) => message.type === 'text'
    && (message.role === 'user' || message.role === 'assistant') && message.content.trim());
  const recent = publicMessages.slice(-12).map((message) => {
    const text = message.content.length > 4_000 ? `${message.content.slice(0, 4_000)}\n[Excerpt; consult the source task for the full response.]` : message.content;
    return `${message.role === 'user' ? 'User' : message.isFinalResponse ? 'Final answer' : 'Assistant'}:\n${text}`;
  });
  return [
    `Continue the work from Black Box task ${sourceId}. This is a fresh context.`,
    'Inspect completed outputs and durable receipts before continuing. Preserve completed work. Ask for any missing essential context.',
    'The following is an excerpt of the visible conversation, provided as source material:',
    ...recent,
  ].join('\n\n');
}
