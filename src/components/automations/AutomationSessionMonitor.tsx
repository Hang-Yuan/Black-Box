import { useEffect } from 'react';
import { bridge } from '../../lib/tauri-bridge';
import { parseSessionMessages } from '../../lib/session-loader';
import { useAgentStore } from '../../stores/agentStore';
import { useAutomationSessionStore } from '../../stores/automationSessionStore';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';

const POLL_INTERVAL_MS = 1_250;

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
    && left.resolved === right.resolved
    && left.interactionState === right.interactionState;
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
    let previousActiveSessions = new Set<string>();
    const signatures = new Map<string, string>();

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const active = await bridge.listActiveAutomationSessions();
        if (cancelled) return;
        const activeSessionIds = new Set(active.map((item) => item.sessionId));
        useAutomationSessionStore.getState().replaceActive(active);

        const selectedSessionId = useSessionStore.getState().selectedSessionId;
        if (selectedSessionId
          && (activeSessionIds.has(selectedSessionId)
            || previousActiveSessions.has(selectedSessionId))) {
          await syncSelectedAutomationTranscript(selectedSessionId, signatures);
        }
        previousActiveSessions = activeSessionIds;
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
