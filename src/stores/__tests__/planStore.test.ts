import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  loadPlans: vi.fn(async () => ({})),
  savePlans: vi.fn(async () => undefined),
}));

vi.mock('../../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import { usePlanStore } from '../planStore';

describe('planStore', () => {
  beforeEach(() => {
    bridgeMock.loadPlans.mockReset().mockResolvedValue({});
    bridgeMock.savePlans.mockReset().mockResolvedValue(undefined);
    usePlanStore.setState({ plans: {}, loaded: false });
  });

  it('persists thread-scoped progress and increments revisions', () => {
    const first = usePlanStore.getState().setPlan('thread-1', [
      { content: 'Inspect', activeForm: 'Inspecting', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
    ]);
    expect(first.revision).toBe(1);
    expect(first.items[0]).toMatchObject({ step: 'Inspect', activeForm: 'Inspecting' });

    const second = usePlanStore.getState().setPlan('thread-1', [
      { step: 'Inspect', status: 'completed' },
      { step: 'Verify', status: 'in_progress' },
    ]);
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(usePlanStore.getState().setPlan('thread-1', second.items).revision).toBe(2);
  });

  it('accepts Claude native Task state as the Plan source', () => {
    const plan = usePlanStore.getState().setPlan(
      'thread-1',
      [{ step: 'Use the real tool', status: 'in_progress' }],
      undefined,
      'native_tasks',
    );
    expect(plan).toMatchObject({ source: 'native_tasks' });
  });

  it('moves a draft Plan to the real CLI thread id', () => {
    usePlanStore.getState().setPlan('draft-1', [{ step: 'Keep state', status: 'pending' }]);
    usePlanStore.getState().movePlan('draft-1', 'real-1');
    expect(usePlanStore.getState().plans['draft-1']).toBeUndefined();
    expect(usePlanStore.getState().plans['real-1']).toMatchObject({ threadId: 'real-1', revision: 2 });
  });

  it('keeps the newer target Plan when draft migration meets existing real state', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(10).mockReturnValueOnce(20).mockReturnValueOnce(30);
    usePlanStore.getState().setPlan('draft-1', [{ step: 'Old draft', status: 'pending' }]);
    usePlanStore.getState().setPlan('real-1', [{ step: 'New real state', status: 'in_progress' }]);
    usePlanStore.getState().movePlan('draft-1', 'real-1');
    expect(usePlanStore.getState().plans['draft-1']).toBeUndefined();
    expect(usePlanStore.getState().plans['real-1']?.items[0].step).toBe('New real state');
  });

  it('loads only valid bounded records', async () => {
    bridgeMock.loadPlans.mockResolvedValue({
      good: {
        threadId: 'stale-key', source: 'todo', revision: 2,
        items: [{ step: 'Valid', status: 'in_progress' }],
        createdAt: 1, updatedAt: 2,
      },
      bad: {
        threadId: 'bad', source: 'todo', revision: 1,
        items: [{ step: 'one', status: 'unknown' }],
        createdAt: 1, updatedAt: 2,
      },
    });
    await usePlanStore.getState().loadPlans();
    expect(usePlanStore.getState().plans.good?.threadId).toBe('good');
    expect(usePlanStore.getState().plans.bad).toBeUndefined();
  });

  it('does not accept an invalid model-authored update', () => {
    expect(() => usePlanStore.getState().setPlan('thread-1', [
      { step: 'one', status: 'unknown' },
    ])).toThrow(RangeError);
    expect(usePlanStore.getState().plans['thread-1']).toBeUndefined();
  });
});
