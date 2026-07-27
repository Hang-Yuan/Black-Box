import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '../../stores/reviewStore';
import { formatReviewFeedback } from '../review-feedback';

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'comment_1',
    runId: 'run_1',
    baseCommit: 'abc123',
    path: 'src/demo.ts',
    displayPath: 'src/demo.ts',
    side: 'new',
    line: 12,
    lineText: '  const value = 1;',
    body: 'Handle the empty case.',
    resolved: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('review feedback draft', () => {
  it('includes unresolved coordinates and source indentation without auto-action syntax', () => {
    const draft = formatReviewFeedback([comment()], 'en');
    expect(draft).toContain('src/demo.ts — new line 12');
    expect(draft).toContain('>   const value = 1;');
    expect(draft).toContain('Comment: Handle the empty case.');
  });

  it('excludes resolved comments and returns no draft when all are resolved', () => {
    expect(formatReviewFeedback([comment({ resolved: true })], 'zh')).toBe('');
  });

  it('sorts comments by file and line for deterministic review', () => {
    const draft = formatReviewFeedback([
      comment({ id: 'b', displayPath: 'z.ts', path: 'z.ts', line: 20 }),
      comment({ id: 'a', displayPath: 'a.ts', path: 'a.ts', line: 2 }),
    ], 'zh');
    expect(draft.indexOf('a.ts')).toBeLessThan(draft.indexOf('z.ts'));
  });
});
