import type { ChatMessage, SessionStatus } from '../stores/chatStore';

export type ConversationDisplayItem =
  | { kind: 'message'; msg: ChatMessage; idx: number }
  | { kind: 'process_group'; msgs: ChatMessage[]; startIdx: number; active: boolean }
  | { kind: 'tool_group'; msgs: ChatMessage[]; startIdx: number };

interface IndexedMessage {
  msg: ChatMessage;
  idx: number;
}

/**
 * Build the calm primary-conversation projection.
 *
 * - Forwarded subagent frames remain available to Agent state but never enter
 *   the lead transcript.
 * - Repeated lead-agent progress is summarized in one expandable row with a
 *   live preview. The final answer remains an ordinary visible message.
 * - Consecutive tool calls still collapse into one expandable row; this keeps
 *   mechanical detail optional without making the conversation noisy.
 */
export function buildConversationDisplayItems(
  messages: readonly ChatMessage[],
  sessionStatus: SessionStatus,
): ConversationDisplayItem[] {
  const visible: IndexedMessage[] = messages
    .map((msg, idx) => ({ msg, idx }))
    .filter(({ msg }) => (msg.subAgentDepth ?? 0) === 0);

  const activeTurn = sessionStatus === 'running'
    || sessionStatus === 'reconnecting'
    || sessionStatus === 'stopping';
  const groupedTextIds = new Set<string>();
  const processGroups = new Map<string, {
    entries: IndexedMessage[];
    active: boolean;
  }>();

  let segmentStart = 0;
  while (segmentStart < visible.length) {
    let segmentEnd = segmentStart + 1;
    while (segmentEnd < visible.length && visible[segmentEnd].msg.role !== 'user') {
      segmentEnd += 1;
    }
    const textEntries = visible
      .slice(segmentStart, segmentEnd)
      .filter(({ msg }) => msg.role === 'assistant' && msg.type === 'text');
    const isCurrentSegment = segmentEnd === visible.length;
    const hasNativeFinalBoundary = textEntries.some(({ msg }) => msg.isFinalResponse);
    const progressEntries = hasNativeFinalBoundary
      ? textEntries.filter(({ msg }) => !msg.isFinalResponse)
      : isCurrentSegment && activeTurn
        ? textEntries
        : textEntries.slice(0, -1);

    if (progressEntries.length >= 2) {
      const firstId = progressEntries[0].msg.id;
      processGroups.set(firstId, {
        entries: progressEntries,
        active: isCurrentSegment && activeTurn,
      });
      progressEntries.forEach(({ msg }) => groupedTextIds.add(msg.id));
    }
    segmentStart = segmentEnd;
  }

  type ProjectedEntry =
    | { kind: 'message'; entry: IndexedMessage }
    | { kind: 'process_group'; entries: IndexedMessage[]; active: boolean };
  const projected: ProjectedEntry[] = [];
  for (const entry of visible) {
    const processGroup = processGroups.get(entry.msg.id);
    if (processGroup) {
      projected.push({ kind: 'process_group', ...processGroup });
      continue;
    }
    if (!groupedTextIds.has(entry.msg.id)) {
      projected.push({ kind: 'message', entry });
    }
  }

  const items: ConversationDisplayItem[] = [];
  let cursor = 0;
  while (cursor < projected.length) {
    const item = projected[cursor];
    if (item.kind === 'process_group') {
      items.push({
        kind: 'process_group',
        msgs: item.entries.map(({ msg }) => msg),
        startIdx: item.entries[0].idx,
        active: item.active,
      });
      cursor += 1;
      continue;
    }

    const entry = item.entry;
    if (entry.msg.type === 'tool_use') {
      const run: IndexedMessage[] = [];
      let lookahead = cursor;
      while (lookahead < projected.length) {
        const candidate = projected[lookahead];
        if (candidate.kind !== 'message' || candidate.entry.msg.type !== 'tool_use') break;
        run.push(candidate.entry);
        lookahead += 1;
      }
      if (run.length >= 3) {
        items.push({
          kind: 'tool_group',
          msgs: run.map(({ msg }) => msg),
          startIdx: run[0].idx,
        });
        cursor = lookahead;
        continue;
      }
    }

    items.push({ kind: 'message', msg: entry.msg, idx: entry.idx });
    cursor += 1;
  }

  return items;
}

export function processUpdatePreview(value: string, maxLength = 120): string {
  const line = value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean) ?? '';
  const plain = line
    .replace(/^[-#>*\s]+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
}

/** Process groups deliberately have no avatar. Group assistant prose against
 * the visible projection so hidden progress text cannot consume the one avatar
 * that should introduce the final lead-agent answer. */
export function isFirstVisibleAssistantTextInTurn(
  items: readonly ConversationDisplayItem[],
  itemIndex: number,
): boolean {
  const current = items[itemIndex];
  if (
    !current
    || current.kind !== 'message'
    || current.msg.role !== 'assistant'
    || current.msg.type !== 'text'
  ) return true;

  for (let index = itemIndex - 1; index >= 0; index -= 1) {
    const previous = items[index];
    if (previous.kind !== 'message') continue;
    if (previous.msg.role === 'user') return true;
    if (previous.msg.role === 'assistant' && previous.msg.type === 'text') return false;
  }
  return true;
}
