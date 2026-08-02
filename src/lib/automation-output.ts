const INBOX_DIRECTIVE = '::inbox-item{';
const FAILURE_DIRECTIVE = '::automation-failed{';

/**
 * The final inbox directive is a control record consumed by the scheduler, not
 * part of the user-facing report. Only strip a complete final directive so a
 * literal example in the middle of an answer remains visible.
 */
export function stripFinalInboxDirective(output: string): string {
  const markers = [INBOX_DIRECTIVE, FAILURE_DIRECTIVE];
  const candidates = markers.map((marker) => {
    const lineMarker = output.lastIndexOf(`\n${marker}`);
    return lineMarker >= 0 ? lineMarker + 1 : output.startsWith(marker) ? 0 : -1;
  });
  const start = Math.max(...candidates);
  if (start < 0) return output;

  const suffix = output.slice(start).trim();
  if (!markers.some((marker) => suffix.startsWith(marker)) || !suffix.endsWith('}')) return output;
  return output.slice(0, start).trimEnd();
}
