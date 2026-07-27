import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge } from '../tauri-bridge';
import {
  completePendingCommand,
  drainPendingQueueAfterSettlement,
} from '../../hooks/useStreamProcessor';
import { useChatStore } from '../../stores/chatStore';

describe('continuation queue serialization', () => {
  beforeEach(() => {
    useChatStore.setState({ tabs: new Map(), sessionCache: new Map() });
    vi.restoreAllMocks();
  });

  it('sends queued slash commands one at a time with independent cards', async () => {
    const store = useChatStore.getState();
    store.ensureTab('thread-1');
    store.setSessionMeta('thread-1', { stdinId: 'desk-1' });
    store.setSessionStatus('thread-1', 'completed');
    for (const [id, text] of [['command-1', '/compact'], ['command-2', '/compact']] as const) {
      store.addMessage('thread-1', {
        id,
        role: 'system',
        type: 'text',
        content: '',
        commandType: 'processing',
        commandData: { command: text, queued: true },
        timestamp: 1,
      });
      store.addPendingMessage('thread-1', text, {
        enqueueStdinId: 'desk-1',
        kind: 'command',
        commandMessageId: id,
      });
    }
    const send = vi.spyOn(bridge, 'sendStdin').mockResolvedValue(undefined);

    expect(drainPendingQueueAfterSettlement({
      tabId: 'thread-1',
      stdinId: 'desk-1',
      wasStopping: false,
    })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith('desk-1', '/compact');
    expect(useChatStore.getState().getTab('thread-1')?.pendingUserMessages).toHaveLength(1);
    expect(useChatStore.getState().getTab('thread-1')?.sessionMeta.pendingCommandMsgId)
      .toBe('command-1');

    completePendingCommand('thread-1');
    useChatStore.getState().setSessionStatus('thread-1', 'completed');
    expect(drainPendingQueueAfterSettlement({
      tabId: 'thread-1',
      stdinId: 'desk-1',
      wasStopping: false,
    })).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().getTab('thread-1')?.pendingUserMessages).toHaveLength(0);
    expect(useChatStore.getState().getTab('thread-1')?.sessionMeta.pendingCommandMsgId)
      .toBe('command-2');
  });

  it('sends each queued user follow-up as its own turn', () => {
    const store = useChatStore.getState();
    store.ensureTab('thread-2');
    store.setSessionMeta('thread-2', { stdinId: 'desk-2' });
    store.addPendingMessage('thread-2', 'first', { enqueueStdinId: 'desk-2' });
    store.addPendingMessage('thread-2', 'second', { enqueueStdinId: 'desk-2' });
    store.addPendingMessage('thread-2', '/compact', {
      enqueueStdinId: 'desk-2',
      kind: 'command',
      commandMessageId: 'later-command',
    });
    const send = vi.spyOn(bridge, 'sendStdin').mockResolvedValue(undefined);

    expect(drainPendingQueueAfterSettlement({
      tabId: 'thread-2',
      stdinId: 'desk-2',
      wasStopping: false,
    })).toBe(true);
    expect(send).toHaveBeenCalledWith('desk-2', 'first');
    expect(useChatStore.getState().getTab('thread-2')?.pendingUserMessages)
      .toMatchObject([
        { kind: 'user', text: 'second' },
        { kind: 'command', text: '/compact' },
      ]);
  });

  it('extracts only startup-gated steers for the matching stdin route', () => {
    const store = useChatStore.getState();
    store.ensureTab('thread-steer');
    store.addPendingMessage('thread-steer', 'guide current run', {
      enqueueStdinId: 'desk-live',
      kind: 'steer',
    });
    store.addPendingMessage('thread-steer', 'later follow-up', {
      enqueueStdinId: 'desk-live',
      kind: 'user',
    });
    store.addPendingMessage('thread-steer', 'other route steer', {
      enqueueStdinId: 'desk-other',
      kind: 'steer',
    });

    expect(store.takePendingSteers('thread-steer', 'desk-live')).toMatchObject([
      { text: 'guide current run', kind: 'steer', enqueueStdinId: 'desk-live' },
    ]);
    expect(useChatStore.getState().getTab('thread-steer')?.pendingUserMessages)
      .toMatchObject([
        { text: 'later follow-up', kind: 'user' },
        { text: 'other route steer', kind: 'steer', enqueueStdinId: 'desk-other' },
      ]);
  });
});
