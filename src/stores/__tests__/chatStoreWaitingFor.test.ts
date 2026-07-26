import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sessionStore', () => {
  const store = {
    selectedSessionId: null as string | null,
    sessions: [] as any[],
    setSessionRunning: vi.fn(),
    getTabForStdin: vi.fn(() => undefined as string | undefined),
  };
  return {
    useSessionStore: {
      getState: () => store,
      __mock: store,
    },
  };
});

import { useChatStore, type ChatMessage } from '../chatStore';
import { useSessionStore } from '../sessionStore';

function interactiveMessage(
  id: string,
  type: 'question' | 'permission' | 'plan_review',
  content = 'sensitive interaction body',
): ChatMessage {
  return {
    id,
    role: 'assistant',
    type,
    content,
    resolved: false,
    interactionState: type === 'plan_review' ? undefined : 'pending',
    timestamp: Date.now(),
  };
}

function beginTab(tabId: string): void {
  const store = useChatStore.getState();
  store.ensureTab(tabId);
  store.setSessionStatus(tabId, 'running');
}

describe('chatStore · metadata-only waitingFor', () => {
  beforeEach(() => {
    useChatStore.setState({ tabs: new Map(), sessionCache: new Map() });
    const mock = (useSessionStore as any).__mock;
    mock.selectedSessionId = null;
    mock.sessions = [];
    mock.setSessionRunning.mockClear();
    mock.getTabForStdin.mockReset();
    mock.getTabForStdin.mockReturnValue(undefined);
  });

  it.each([
    ['question', 'question'],
    ['permission', 'permission'],
    ['plan_review', 'plan_review'],
  ] as const)('sets %s from a live pending card', (messageType, expected) => {
    beginTab(`tab-${messageType}`);

    useChatStore.getState().addMessage(
      `tab-${messageType}`,
      interactiveMessage(`msg-${messageType}`, messageType),
    );

    expect(useChatStore.getState().getTab(`tab-${messageType}`)?.waitingFor).toBe(expected);
  });

  it('clears a question as soon as the response starts sending', () => {
    beginTab('question-response');
    const store = useChatStore.getState();
    store.addMessage('question-response', interactiveMessage('q1', 'question'));

    store.setInteractionState('question-response', 'q1', 'sending');

    expect(useChatStore.getState().getTab('question-response')?.waitingFor).toBeUndefined();
  });

  it('clears a cancelled permission and restores it only on an explicit retry', () => {
    beginTab('permission-cancel');
    const store = useChatStore.getState();
    store.addMessage('permission-cancel', interactiveMessage('p1', 'permission'));

    store.updateMessage('permission-cancel', 'p1', {
      interactionState: 'expired',
      resolved: true,
    });
    expect(useChatStore.getState().getTab('permission-cancel')?.waitingFor).toBeUndefined();

    store.setInteractionState('permission-cancel', 'p1', 'pending');
    expect(useChatStore.getState().getTab('permission-cancel')?.waitingFor).toBe('permission');
  });

  it('clears PlanReview when it is approved', () => {
    beginTab('plan-approve');
    const store = useChatStore.getState();
    store.addMessage('plan-approve', interactiveMessage('plan_review_current', 'plan_review'));

    store.updateMessage('plan-approve', 'plan_review_current', {
      resolved: true,
      interactionState: 'resolved',
    });

    expect(useChatStore.getState().getTab('plan-approve')?.waitingFor).toBeUndefined();
  });

  it.each(['stopping', 'stopped', 'completed', 'error', 'idle'] as const)(
    'clears waitingFor when the session becomes %s',
    (status) => {
      beginTab(`terminal-${status}`);
      const store = useChatStore.getState();
      store.addMessage(`terminal-${status}`, interactiveMessage('q1', 'question'));

      store.setSessionStatus(`terminal-${status}`, status);

      expect(useChatStore.getState().getTab(`terminal-${status}`)?.waitingFor).toBeUndefined();
    },
  );

  it('isolates simultaneous waiting kinds across tabs', () => {
    beginTab('tab-a');
    beginTab('tab-b');
    const store = useChatStore.getState();
    store.addMessage('tab-a', interactiveMessage('q1', 'question'));
    store.addMessage('tab-b', interactiveMessage('p1', 'permission'));

    store.setInteractionState('tab-a', 'q1', 'resolved');

    expect(useChatStore.getState().getTab('tab-a')?.waitingFor).toBeUndefined();
    expect(useChatStore.getState().getTab('tab-b')?.waitingFor).toBe('permission');
  });

  it('does not revive a pending historical card until the tab is live', () => {
    const store = useChatStore.getState();
    store.ensureTab('hydrated');
    store.addMessage('hydrated', interactiveMessage('historical-q', 'question'));
    expect(useChatStore.getState().getTab('hydrated')?.waitingFor).toBeUndefined();

    store.setSessionStatus('hydrated', 'running');
    expect(useChatStore.getState().getTab('hydrated')?.waitingFor).toBe('question');
  });

  it('clears stale waiting metadata on restore without a live stdin owner', () => {
    beginTab('stale-restore');
    const store = useChatStore.getState();
    store.addMessage('stale-restore', interactiveMessage('q1', 'question'));

    store.restoreFromCache('stale-restore');

    expect(useChatStore.getState().getTab('stale-restore')?.waitingFor).toBeUndefined();
  });

  it('preserves waiting metadata on an in-process tab switch with live ownership', () => {
    beginTab('live-restore');
    const store = useChatStore.getState();
    store.setSessionMeta('live-restore', { stdinId: 'stdin-live' });
    store.addMessage('live-restore', interactiveMessage('q1', 'question'));
    (useSessionStore as any).__mock.getTabForStdin.mockImplementation(
      (stdinId: string) => stdinId === 'stdin-live' ? 'live-restore' : undefined,
    );

    store.restoreFromCache('live-restore');

    expect(useChatStore.getState().getTab('live-restore')?.waitingFor).toBe('question');
  });

  it('stores only the interaction kind in waitingFor metadata', () => {
    const sensitiveBody = 'What is the confidential launch date?';
    beginTab('privacy');
    useChatStore.getState().addMessage(
      'privacy',
      interactiveMessage('q-private', 'question', sensitiveBody),
    );

    const waitingFor = useChatStore.getState().getTab('privacy')?.waitingFor;
    expect(waitingFor).toBe('question');
    expect(JSON.stringify(waitingFor)).not.toContain(sensitiveBody);
    expect(typeof waitingFor).toBe('string');
  });
});
