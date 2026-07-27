import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, reviewCoordinate } from '../unified-diff';

describe('unified diff review coordinates', () => {
  const patch = [
    'diff --git a/src/demo.ts b/src/demo.ts',
    'index 1111111..2222222 100644',
    '--- a/src/demo.ts',
    '+++ b/src/demo.ts',
    '@@ -10,3 +10,4 @@',
    ' const keep = true;',
    '-  const oldValue = 1;',
    '+  const newValue = 2;',
    '+  const extra = 3;',
    ' return keep;',
  ].join('\n');

  it('tracks old and new coordinates independently through a hunk', () => {
    const lines = parseUnifiedDiff(patch);
    expect(lines.find((line) => line.raw.includes('oldValue'))).toMatchObject({
      kind: 'remove', oldLine: 11, newLine: null, content: '  const oldValue = 1;',
    });
    expect(lines.find((line) => line.raw.includes('newValue'))).toMatchObject({
      kind: 'add', oldLine: null, newLine: 11, content: '  const newValue = 2;',
    });
    expect(lines.find((line) => line.raw.includes('extra'))).toMatchObject({ newLine: 12 });
    expect(lines.find((line) => line.raw.includes('return keep'))).toMatchObject({
      kind: 'context', oldLine: 12, newLine: 13,
    });
  });

  it('anchors removals to old and additions/context to new', () => {
    const lines = parseUnifiedDiff(patch);
    expect(reviewCoordinate(lines.find((line) => line.raw.includes('oldValue'))!))
      .toEqual({ side: 'old', line: 11 });
    expect(reviewCoordinate(lines.find((line) => line.raw.includes('newValue'))!))
      .toEqual({ side: 'new', line: 11 });
    expect(reviewCoordinate(lines[0])).toBeNull();
  });
});
