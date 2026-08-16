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

  it('removes a final failure control directive while preserving the report', () => {
    expect(stripFinalInboxDirective(
      'The required lock could not be created.\n::automation-failed{summary="Lock denied"}',
    )).toBe('The required lock could not be created.');
  });

  it('removes a final needs-attention control directive while preserving the report', () => {
    expect(stripFinalInboxDirective(
      'The report is ready.\n::automation-needs-attention{title="Choose release" summary="Approve one candidate"}',
    )).toBe('The report is ready.');
  });

  it('strips only the final control directive when earlier examples are present', () => {
    const output = 'Example\n::inbox-item{title="Done"}\n::automation-needs-attention{title="Review"}';
    expect(stripFinalInboxDirective(output)).toBe('Example\n::inbox-item{title="Done"}');
  });
});
