export interface ConversationTurnMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  checkpointUuid?: string;
}

export type ComparisonAlignment =
  | { mode: 'exact'; turnKey: string }
  | { mode: 'last-shared'; turnKey: string }
  | { mode: 'bottom' };

function userTurnKey(message: ConversationTurnMessage): string | undefined {
  if (message.role !== 'user') return undefined;
  const checkpoint = message.checkpointUuid?.trim();
  if (checkpoint) return checkpoint;
  const id = message.id.trim();
  return id || undefined;
}

/**
 * Assign every rendered message to the user turn that owns it. Assistant,
 * thinking, and tool messages inherit the most recent user message key.
 */
export function buildConversationTurnKeys(
  messages: ConversationTurnMessage[],
): Array<string | undefined> {
  let activeTurn: string | undefined;
  return messages.map((message) => {
    activeTurn = userTurnKey(message) ?? activeTurn;
    return activeTurn;
  });
}

/**
 * Resolve the one-time position used when a comparison pane opens. Prefer the
 * primary pane's currently visible turn. When the branch has advanced beyond
 * the shared history, use the final shared turn as the fork-boundary anchor.
 */
export function resolveComparisonAlignment(
  visibleTurnKey: string | undefined,
  primaryTurnKeys: Array<string | undefined>,
  comparisonTurnKeys: Array<string | undefined>,
): ComparisonAlignment {
  const comparisonKeys = new Set(comparisonTurnKeys.filter((key): key is string => !!key));
  if (visibleTurnKey && comparisonKeys.has(visibleTurnKey)) {
    return { mode: 'exact', turnKey: visibleTurnKey };
  }

  for (let index = primaryTurnKeys.length - 1; index >= 0; index -= 1) {
    const key = primaryTurnKeys[index];
    if (key && comparisonKeys.has(key)) {
      return { mode: 'last-shared', turnKey: key };
    }
  }

  return { mode: 'bottom' };
}
