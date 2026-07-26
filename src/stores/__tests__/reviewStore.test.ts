import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  loadReviewComments: vi.fn(async () => ({})),
  saveReviewComments: vi.fn(async () => undefined),
}));

vi.mock('../../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import { useReviewStore } from '../reviewStore';

const validInput = {
  runId: 'run_1',
  baseCommit: 'abc123',
  path: 'src/demo.ts',
  displayPath: 'src/demo.ts',
  side: 'new' as const,
  line: 12,
  lineText: '  const value = 1;',
  body: 'Handle the empty case.',
};

describe('reviewStore', () => {
  beforeEach(() => {
    bridgeMock.loadReviewComments.mockReset().mockResolvedValue({});
    bridgeMock.saveReviewComments.mockReset().mockResolvedValue(undefined);
    useReviewStore.setState({ comments: {}, loaded: false });
  });

  it('preserves source indentation and persists a bounded comment', async () => {
    const created = useReviewStore.getState().addComment(validInput);
    expect(created.lineText).toBe('  const value = 1;');
    expect(created.resolved).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(bridgeMock.saveReviewComments).toHaveBeenCalled();
  });

  it('rejects absolute and traversal paths', () => {
    expect(() => useReviewStore.getState().addComment({ ...validInput, path: '/tmp/demo.ts' }))
      .toThrow(/invalid/i);
    expect(() => useReviewStore.getState().addComment({ ...validInput, path: '../demo.ts' }))
      .toThrow(/invalid/i);
  });

  it('persists resolve, reopen, and delete transitions', () => {
    const created = useReviewStore.getState().addComment(validInput);
    useReviewStore.getState().setResolved(created.id, true);
    expect(useReviewStore.getState().comments[created.id].resolved).toBe(true);
    useReviewStore.getState().setResolved(created.id, false);
    expect(useReviewStore.getState().comments[created.id].resolved).toBe(false);
    useReviewStore.getState().removeComment(created.id);
    expect(useReviewStore.getState().comments[created.id]).toBeUndefined();
  });

  it('drops malformed records during load', async () => {
    bridgeMock.loadReviewComments.mockResolvedValue({
      bad: { ...validInput, id: 'bad', path: '../../escape', createdAt: 1, updatedAt: 1 },
      good: { ...validInput, id: 'good', resolved: false, createdAt: 1, updatedAt: 1 },
    });
    await useReviewStore.getState().loadComments();
    expect(Object.keys(useReviewStore.getState().comments)).toEqual(['good']);
  });
});
