import { beforeEach, describe, expect, it } from 'vitest';
import { useAutomationSessionStore } from '../automationSessionStore';

describe('automationSessionStore', () => {
  beforeEach(() => {
    useAutomationSessionStore.setState({
      activeBySession: new Map(),
      transcriptSyncBySession: new Map(),
    });
  });

  it('indexes only the currently active scheduled conversations', () => {
    useAutomationSessionStore.getState().replaceActive([{
      runId: 'run-1',
      automationId: 'daily-dream',
      sessionId: 'session-1',
      title: 'daily-dream',
      startedAt: 1_000,
    }]);

    expect(useAutomationSessionStore.getState().activeBySession.get('session-1')?.runId)
      .toBe('run-1');

    useAutomationSessionStore.getState().replaceActive([]);
    expect(useAutomationSessionStore.getState().activeBySession.size).toBe(0);
  });

  it('keeps transcript freshness separate from run metadata', () => {
    useAutomationSessionStore.getState().recordTranscriptSync('session-1', {
      syncedAt: 2_000,
      latestEventAt: 1_900,
      messageCount: 12,
    });

    expect(useAutomationSessionStore.getState().transcriptSyncBySession.get('session-1'))
      .toEqual({ syncedAt: 2_000, latestEventAt: 1_900, messageCount: 12 });
    expect(useAutomationSessionStore.getState().activeBySession.size).toBe(0);
  });
});
