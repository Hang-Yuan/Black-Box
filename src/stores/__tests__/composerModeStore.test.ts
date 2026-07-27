import { beforeEach, describe, expect, it } from 'vitest';
import {
  getComposerModeTab,
  useComposerModeStore,
} from '../composerModeStore';

describe('composer mode store', () => {
  beforeEach(() => {
    useComposerModeStore.setState({ tabs: {} });
  });

  it('isolates task and busy-delivery choices by conversation', () => {
    const store = useComposerModeStore.getState();
    store.selectTaskMode('thread-a', 'goal');
    store.setBusyDelivery('thread-a', 'queue');
    store.selectTaskMode('thread-b', 'workflow');

    expect(getComposerModeTab('thread-a')).toMatchObject({
      taskMode: 'goal',
      busyDelivery: 'queue',
    });
    expect(getComposerModeTab('thread-b')).toMatchObject({
      taskMode: 'workflow',
      busyDelivery: 'steer',
    });
  });

  it('toggles the same mode off and switches directly between different modes', () => {
    const store = useComposerModeStore.getState();
    store.selectTaskMode('thread', 'goal');
    store.selectTaskMode('thread', 'workflow');
    expect(getComposerModeTab('thread').taskMode).toBe('workflow');
    store.selectTaskMode('thread', 'workflow');
    expect(getComposerModeTab('thread').taskMode).toBeNull();
  });

  it('clears only the active task mode and retains reusable options', () => {
    const store = useComposerModeStore.getState();
    store.selectTaskMode('thread', 'loop');
    store.setLoopInterval('thread', '15m');
    store.setWorkflowName('thread', 'audit');
    store.clearTaskMode('thread');

    expect(getComposerModeTab('thread')).toMatchObject({
      taskMode: null,
      loopInterval: '15m',
      workflowName: 'audit',
    });
  });

  it('returns fresh defaults for conversations with no state', () => {
    const first = getComposerModeTab('missing');
    first.loopInterval = 'changed';
    expect(getComposerModeTab('missing')).toMatchObject({
      taskMode: null,
      busyDelivery: 'steer',
      workflowName: '',
      loopInterval: '5m',
    });
  });
});
