const INBOX_DIRECTIVE = '::inbox-item{';

/**
 * The final inbox directive is a control record consumed by the scheduler, not
 * part of the user-facing report. Only strip a complete final directive so a
 * literal example in the middle of an answer remains visible.
 */
export function stripFinalInboxDirective(output: string): string {
  const lineMarker = output.lastIndexOf(`\n${INBOX_DIRECTIVE}`);
  const start = lineMarker >= 0
    ? lineMarker + 1
    : output.startsWith(INBOX_DIRECTIVE) ? 0 : -1;
  if (start < 0) return output;

  const suffix = output.slice(start).trim();
  if (!suffix.startsWith(INBOX_DIRECTIVE) || !suffix.endsWith('}')) return output;
  return output.slice(0, start).trimEnd();
}
