import { describe, expect, it } from 'vitest';
import { stripFinalInboxDirective } from '../automation-output';

describe('scheduled output presentation', () => {
  it('removes a final scheduler control directive from the visible report', () => {
    expect(stripFinalInboxDirective(
      '# Result\n\nEverything passed.\n::inbox-item{title="Done" summary="All checks passed"}',
    )).toBe('# Result\n\nEverything passed.');
  });

  it('keeps literal or incomplete directive examples in report content', () => {
    const middle = 'Example: ::inbox-item{title="x"}\nContinue reading.';
    expect(stripFinalInboxDirective(middle)).toBe(middle);
    const incomplete = 'Report\n::inbox-item{title="x"';
    expect(stripFinalInboxDirective(incomplete)).toBe(incomplete);
  });

  it('handles a directive-only result without leaving blank control syntax', () => {
    expect(stripFinalInboxDirective('::inbox-item{title="No findings"}')).toBe('');
  });
});
