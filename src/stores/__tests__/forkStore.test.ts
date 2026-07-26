import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  loadForkLineage: vi.fn(async () => ({})),
  saveForkLineage: vi.fn(async () => undefined),
}));

vi.mock('../../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import { useForkStore } from '../forkStore';

const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';

describe('forkStore', () => {
  beforeEach(() => {
    bridgeMock.loadForkLineage.mockReset().mockResolvedValue({});
    bridgeMock.saveForkLineage.mockReset().mockResolvedValue(undefined);
    useForkStore.setState({ forks: {}, loaded: false, comparisonThreadId: undefined });
  });

  it('keeps pending lineage in memory until the CLI allocates a child UUID', () => {
    useForkStore.getState().createPendingFork('draft_test', parent, 'Parent', '/tmp/project');
    expect(useForkStore.getState().forks.draft_test).toMatchObject({
      parentThreadId: parent,
      forkPoint: 'tip',
    });
    expect(bridgeMock.saveForkLineage).not.toHaveBeenCalled();
  });

  it('moves and persists lineage when draft promotion receives the child UUID', async () => {
    useForkStore.getState().createPendingFork('draft_test', parent, 'Parent', '/tmp/project');
    useForkStore.getState().moveFork('draft_test', child);
    await Promise.resolve();
    await Promise.resolve();
    expect(useForkStore.getState().forks.draft_test).toBeUndefined();
    expect(useForkStore.getState().forks[child]).toMatchObject({
      childThreadId: child,
      parentThreadId: parent,
    });
    expect(bridgeMock.saveForkLineage).toHaveBeenCalled();
  });

  it('registers and persists a historical checkpoint fork', async () => {
    useForkStore.getState().registerFork({
      childThreadId: child,
      parentThreadId: parent,
      parentTitle: 'Parent',
      cwd: '/tmp/project',
      createdAt: 3,
      forkPoint: 'checkpoint',
      checkpointUuid: '33333333-3333-4333-8333-333333333333',
      checkpointTurnIndex: 4,
      checkpointPreview: 'Try a different approach',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(useForkStore.getState().forks[child]).toMatchObject({
      forkPoint: 'checkpoint',
      checkpointTurnIndex: 4,
      checkpointPreview: 'Try a different approach',
    });
    expect(bridgeMock.saveForkLineage).toHaveBeenCalled();
  });

  it('downgrades malformed checkpoint metadata to a tip lineage record', async () => {
    bridgeMock.loadForkLineage.mockResolvedValue({
      [child]: {
        childThreadId: child,
        parentThreadId: parent,
        parentTitle: 'Parent',
        cwd: '/tmp/project',
        createdAt: 2,
        forkPoint: 'checkpoint',
        checkpointUuid: 'not-a-uuid',
        checkpointTurnIndex: 0,
      },
    });
    await useForkStore.getState().loadForks();
    expect(useForkStore.getState().forks[child]).toMatchObject({ forkPoint: 'tip' });
  });

  it('loads only durable UUID-keyed records and drops stale draft entries', async () => {
    bridgeMock.loadForkLineage.mockResolvedValue({
      [child]: {
        childThreadId: 'stale-key', parentThreadId: parent, parentTitle: 'Parent',
        cwd: '/tmp/project', createdAt: 2, forkPoint: 'tip',
      },
      draft_stale: {
        childThreadId: 'draft_stale', parentThreadId: parent, parentTitle: 'Stale',
        cwd: '/tmp/project', createdAt: 1, forkPoint: 'tip',
      },
    });
    await useForkStore.getState().loadForks();
    expect(useForkStore.getState().forks[child]?.childThreadId).toBe(child);
    expect(useForkStore.getState().forks.draft_stale).toBeUndefined();
  });

  it('rejects a non-UUID source', () => {
    expect(() => useForkStore.getState().createPendingFork(
      'draft_test', 'not-a-session', 'Parent', '/tmp/project',
    )).toThrow(/valid Claude thread UUID/);
  });

  it('opens and closes a transient side-by-side comparison without persisting it', () => {
    useForkStore.getState().openComparison(parent);
    expect(useForkStore.getState().comparisonThreadId).toBe(parent);
    expect(bridgeMock.saveForkLineage).not.toHaveBeenCalled();
    useForkStore.getState().closeComparison();
    expect(useForkStore.getState().comparisonThreadId).toBeUndefined();
  });

  it('rejects an invalid comparison thread id', () => {
    expect(() => useForkStore.getState().openComparison('draft_invalid'))
      .toThrow(/valid Claude thread UUID/);
  });
});
