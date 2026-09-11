import { useEffect } from 'react';
import { bridge, type ActiveAutomationSession } from '../../lib/tauri-bridge';
import { parseSessionMessages } from '../../lib/session-loader';
import { useAgentStore } from '../../stores/agentStore';
import { useAutomationSessionStore } from '../../stores/automationSessionStore';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';

const POLL_INTERVAL_MS = 1_250;
const TERMINAL_SETTLE_POLLS = 6;

function messageSignature(messages: readonly ChatMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return '0';
  return [
    messages.length,
    last.id,
    last.type,
    last.content?.length || 0,
    last.toolResultContent?.length || 0,
    last.timestamp || 0,
  ].join(':');
}

function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  return left.type === right.type
    && left.role === right.role
    && left.content === right.content
    && left.toolResultContent === right.toolResultContent
    && left.isFinalResponse === right.isFinalResponse
    && left.resolved === right.resolved
    && left.interactionState === right.interactionState;
}

function terminalChatStatus(status: string): 'completed' | 'error' {
  return ['FAILED', 'CANCELLED'].includes(status.toUpperCase()) ? 'error' : 'completed';
}

async function syncSelectedAutomationTranscript(
  sessionId: string,
  signatures: Map<string, string>,
): Promise<void> {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session?.path) {
    await useSessionStore.getState().fetchSessions();
    return;
  }

  const rawMessages = await bridge.loadSession(session.path);
  if (useSessionStore.getState().selectedSessionId !== sessionId) return;

  const parsed = parseSessionMessages(rawMessages);
  const signature = messageSignature(parsed.messages);
  const chat = useChatStore.getState();
  chat.ensureTab(sessionId);

  if (signatures.get(sessionId) !== signature) {
    const existing = new Map(
      (chat.getTab(sessionId)?.messages || []).map((message) => [message.id, message]),
    );
    for (const message of parsed.messages) {
      const current = existing.get(message.id);
      if (!current) {
        const { toolResultContent, ...baseMessage } = message;
        chat.addMessage(sessionId, baseMessage);
        if (toolResultContent !== undefined) {
          useChatStore.getState().updateMessage(sessionId, message.id, { toolResultContent });
        }
      } else if (!sameMessage(current, message)) {
        chat.updateMessage(sessionId, message.id, message);
      }
    }
    const agents = useAgentStore.getState();
    for (const agent of parsed.agents) agents.upsertAgent(agent);
    signatures.set(sessionId, signature);
  }

  const latestEventAt = parsed.messages.reduce<number | null>((latest, message) => {
    if (!Number.isFinite(message.timestamp) || message.timestamp <= 0) return latest;
    return latest === null ? message.timestamp : Math.max(latest, message.timestamp);
  }, null);
  useAutomationSessionStore.getState().recordTranscriptSync(sessionId, {
    syncedAt: Date.now(),
    latestEventAt,
    messageCount: parsed.messages.length,
  });
}

/**
 * Keeps the durable conversation surface attached to independent scheduled
 * runs. The automation process remains backend-owned; the UI follows its
 * JSONL and blocks a second --resume process from racing the same session.
 */
export function AutomationSessionMonitor() {
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let previousActiveSessions = new Map<string, ActiveAutomationSession>();
    const terminalSettles = new Map<string, {
      run: ActiveAutomationSession;
      pollsRemaining: number;
      statusApplied: boolean;
    }>();
    const signatures = new Map<string, string>();

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const active = await bridge.listActiveAutomationSessions();
        if (cancelled) return;
        const activeBySession = new Map(active.map((item) => [item.sessionId, item]));
        const activeSessionIds = new Set(activeBySession.keys());
        useAutomationSessionStore.getState().replaceActive(active);

        for (const [sessionId, previous] of previousActiveSessions) {
          if (!activeSessionIds.has(sessionId) && !terminalSettles.has(sessionId)) {
            terminalSettles.set(sessionId, {
              run: previous,
              pollsRemaining: TERMINAL_SETTLE_POLLS,
              statusApplied: false,
            });
          }
        }
        for (const sessionId of activeSessionIds) terminalSettles.delete(sessionId);

        const selectedSessionId = useSessionStore.getState().selectedSessionId;
        if (selectedSessionId
          && (activeSessionIds.has(selectedSessionId)
            || previousActiveSessions.has(selectedSessionId)
            || terminalSettles.has(selectedSessionId))) {
          await syncSelectedAutomationTranscript(selectedSessionId, signatures);

          const settling = terminalSettles.get(selectedSessionId);
          if (settling && !settling.statusApplied) {
            const runs = await bridge.listAutomationRuns(settling.run.automationId, 20);
            const finished = runs.find((run) => run.runId === settling.run.runId);
            if (finished && finished.status !== 'RUNNING') {
              useChatStore.getState().setSessionStatus(
                selectedSessionId,
                terminalChatStatus(finished.status),
              );
              settling.statusApplied = true;
            }
          }
        }
        for (const [sessionId, settling] of terminalSettles) {
          settling.pollsRemaining -= 1;
          if (settling.pollsRemaining <= 0) terminalSettles.delete(sessionId);
        }
        previousActiveSessions = activeBySession;
      } catch {
        // Preserve the last trustworthy activity snapshot. A transient SQLite
        // or filesystem read failure must not hide an in-flight scheduled run.
      } finally {
        polling = false;
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
