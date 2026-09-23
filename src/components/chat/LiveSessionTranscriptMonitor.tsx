import { useEffect } from 'react';
import { bridge } from '../../lib/tauri-bridge';
import { liveTranscriptRevisionKey } from '../../lib/live-transcript';
import { reconcileDurableSessionTranscript } from '../../lib/live-transcript-sync';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';

const POLL_INTERVAL_MS = 1_250;

/**
 * Claude can persist a lead end-turn to JSONL before its stream-json process
 * yields that frame when an asynchronous Agent remains active. Keep the
 * selected live conversation attached to that durable transcript so the user
 * sees the reply immediately instead of an apparently frozen tool indicator.
 */
export function LiveSessionTranscriptMonitor() {
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let lastSessionId = '';
    let lastRevision = '';

    const poll = async () => {
      if (polling) return;
      const selectedSessionId = useSessionStore.getState().selectedSessionId;
      if (!selectedSessionId) return;
      const tab = useChatStore.getState().getTab(selectedSessionId);
      if (!tab || !['running', 'reconnecting'].includes(tab.sessionStatus)) return;
      const session = useSessionStore.getState().sessions.find((item) => item.id === selectedSessionId);
      if (!session?.path) return;

      polling = true;
      try {
        if (lastSessionId !== selectedSessionId) {
          lastSessionId = selectedSessionId;
          lastRevision = '';
        }
        const revision = await bridge.getSessionFileRevision(session.path);
        if (cancelled || useSessionStore.getState().selectedSessionId !== selectedSessionId) return;
        const revisionKey = liveTranscriptRevisionKey(revision);
        if (revisionKey === lastRevision) return;

        const result = await reconcileDurableSessionTranscript(selectedSessionId, revision);
        if (cancelled || useSessionStore.getState().selectedSessionId !== selectedSessionId) return;
        lastRevision = result?.revision ?? revisionKey;
      } catch {
        // The live stream remains authoritative. A transient JSONL read race
        // must not change task state or interrupt the active process.
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
