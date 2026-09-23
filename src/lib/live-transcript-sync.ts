import { resolveAgentEventId, useAgentStore } from '../stores/agentStore';
import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { bridge } from './tauri-bridge';
import {
  findTranscriptMessageMatch,
  liveTranscriptRevisionKey,
  sameTranscriptMessage,
} from './live-transcript';
import { preferMessageCwd } from './message-cwd';
import { parseSessionMessages } from './session-loader';

export interface TranscriptReconciliationResult {
  revision: string;
  changed: boolean;
}

/**
 * Project the authoritative JSONL transcript into an existing chat tab.
 *
 * This is deliberately callable after a turn has reached a terminal state.
 * Claude can flush the final assistant record, including its precise cwd, at
 * the same time as the stream emits `result`; a monitor limited to `running`
 * sessions can otherwise miss that last durable revision forever.
 */
export async function reconcileDurableSessionTranscript(
  sessionId: string,
  knownRevision?: { bytes: number; modifiedMs: number },
): Promise<TranscriptReconciliationResult | null> {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session?.path) return null;

  const revision = knownRevision ?? await bridge.getSessionFileRevision(session.path);
  const rawMessages = await bridge.loadSession(session.path);
  const parsed = parseSessionMessages(rawMessages);
  const chat = useChatStore.getState();
  const currentMessages = [...(chat.getTab(sessionId)?.messages ?? [])];
  const existing = new Map(currentMessages.map((message) => [message.id, message]));
  const claimedMessageIds = new Set<string>();
  let changed = false;

  for (const message of parsed.messages) {
    const current = existing.get(message.id)
      ?? findTranscriptMessageMatch(currentMessages, message, claimedMessageIds);
    if (!current) {
      const { toolResultContent, ...baseMessage } = message;
      chat.addMessage(sessionId, baseMessage);
      if (toolResultContent !== undefined) {
        useChatStore.getState().updateMessage(sessionId, message.id, { toolResultContent });
      }
      currentMessages.push(message);
      existing.set(message.id, message);
      changed = true;
    } else if (
      !sameTranscriptMessage(current, message)
      || (message.role === 'user' && current.id !== message.id
        && (current.checkpointUuid !== message.id || current.awaitingPersistence !== false))
    ) {
      // Durable transcript fields win, while live-only telemetry survives.
      // cwd is special: broad session-root snapshots must never overwrite a
      // deeper directory that already owns relative file references.
      chat.updateMessage(sessionId, current.id, {
        type: message.type,
        role: message.role,
        content: message.content,
        toolResultContent: message.toolResultContent,
        toolCompleted: message.toolCompleted,
        isFinalResponse: message.isFinalResponse,
        isApiErrorMessage: message.isApiErrorMessage,
        resolved: message.resolved,
        interactionState: message.interactionState,
        cwd: preferMessageCwd(current.cwd, message.cwd),
        timestamp: message.timestamp || current.timestamp,
        subAgentDepth: message.subAgentDepth ?? current.subAgentDepth,
        checkpointUuid: message.role === 'user' && current.id !== message.id
          ? message.id
          : message.checkpointUuid ?? current.checkpointUuid,
        isSteer: message.isSteer,
        steerState: message.isSteer ? 'sent' : undefined,
        awaitingPersistence: false,
      });
      changed = true;
    }
    if (current) {
      if (message.role === 'user') claimedMessageIds.add(current.id);
      if (current.id !== message.id) existing.set(message.id, current);
    }
  }

  const agentState = useAgentStore.getState();
  for (const durableAgent of parsed.agents) {
    if (
      !durableAgent.background
      || !['completed', 'idle', 'error'].includes(durableAgent.phase)
    ) continue;
    const currentAgentId = resolveAgentEventId(
      durableAgent.toolUseIds?.[durableAgent.toolUseIds.length - 1],
      durableAgent.taskId,
      agentState.agents,
    );
    if (currentAgentId) agentState.completeAgent(currentAgentId, durableAgent.phase);
  }

  chat.setSessionMeta(sessionId, {
    contextInputTokens: parsed.contextInputTokens,
    contextOutputTokens: parsed.contextOutputTokens,
  });
  return { revision: liveTranscriptRevisionKey(revision), changed };
}

const terminalSyncTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

/**
 * Run an immediate terminal reconciliation plus two bounded retries. The
 * retries cover filesystem flush ordering without leaving completed sessions
 * on a permanent polling loop.
 */
export function scheduleTerminalTranscriptReconciliation(sessionId: string): void {
  const previous = terminalSyncTimers.get(sessionId);
  if (previous) {
    for (const timer of previous) clearTimeout(timer);
  }

  const timers = new Set<ReturnType<typeof setTimeout>>();
  terminalSyncTimers.set(sessionId, timers);
  for (const delay of [0, 250, 1_250]) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void reconcileDurableSessionTranscript(sessionId).catch(() => {
        // The stream already delivered the turn. A transient read race should
        // not change task state; the remaining bounded retry can still repair it.
      }).finally(() => {
        if (timers.size === 0 && terminalSyncTimers.get(sessionId) === timers) {
          terminalSyncTimers.delete(sessionId);
        }
      });
    }, delay);
    timers.add(timer);
  }
}
