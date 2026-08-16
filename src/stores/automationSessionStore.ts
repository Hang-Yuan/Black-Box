import { create } from 'zustand';
import type { ActiveAutomationSession } from '../lib/tauri-bridge';

interface AutomationTranscriptSync {
  syncedAt: number;
  latestEventAt: number | null;
  messageCount: number;
}

interface AutomationSessionState {
  activeBySession: Map<string, ActiveAutomationSession>;
  transcriptSyncBySession: Map<string, AutomationTranscriptSync>;
  replaceActive: (sessions: readonly ActiveAutomationSession[]) => void;
  recordTranscriptSync: (
    sessionId: string,
    sync: AutomationTranscriptSync,
  ) => void;
}

export const useAutomationSessionStore = create<AutomationSessionState>()((set) => ({
  activeBySession: new Map(),
  transcriptSyncBySession: new Map(),

  replaceActive: (sessions) => set((state) => {
    const next = new Map(sessions.map((session) => [session.sessionId, session]));
    const unchanged = next.size === state.activeBySession.size
      && [...next].every(([sessionId, session]) => {
        const current = state.activeBySession.get(sessionId);
        return current?.runId === session.runId
          && current.automationId === session.automationId
          && current.title === session.title
          && current.startedAt === session.startedAt;
      });
    return unchanged ? state : { activeBySession: next };
  }),

  recordTranscriptSync: (sessionId, sync) => set((state) => {
    const current = state.transcriptSyncBySession.get(sessionId);
    if (current?.messageCount === sync.messageCount
      && current.latestEventAt === sync.latestEventAt
      && current.syncedAt === sync.syncedAt) {
      return state;
    }
    const next = new Map(state.transcriptSyncBySession);
    next.set(sessionId, sync);
    return { transcriptSyncBySession: next };
  }),
}));
