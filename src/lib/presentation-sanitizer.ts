/**
 * Remove Claude Code's private agent coordination metadata from anything that
 * can reach the visible conversation, exports, or a restored session.
 *
 * Stable teammate names and useful status/result prose are preserved. Internal
 * agent ids and private JSONL output paths are implementation details and must
 * never become product UI.
 */
export function sanitizeAssistantTextForDisplay(value: unknown): string {
  if (typeof value !== 'string') return value == null ? '' : JSON.stringify(value);

  let text = value;
  for (const tag of ['task-id', 'tool-use-id', 'output-file', 'usage', 'note']) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>\\s*`, 'gi'), '');
  }

  text = text
    .replace(/<task-notification\b[^>]*>/gi, '')
    .replace(/<\/task-notification>/gi, '')
    .replace(/<result>/gi, '')
    .replace(/<\/result>/gi, '')
    .replace(
      /(\b[\w.-]{1,64})\s+\([a-f0-9]{12,64}\)(?=:\s*(?:completed|failed|running|stopped|idle)\b)/gi,
      '$1',
    )
    .replace(/^.*\bagentId\s*:\s*[^\n]*\n?/gim, '')
    .replace(/^.*\boutput[_-]?file\s*:\s*\/private\/tmp\/claude-[^\n]*\n?/gim, '')
    .replace(/\/private\/tmp\/claude-[^\s<>'"`]+/gi, '[internal agent output hidden]')
    .replace(/\n{3,}/g, '\n\n');

  return text;
}

export function sanitizeToolResultForDisplay(
  toolName: string | undefined,
  resultText: string,
): string {
  if (toolName === 'Agent' || toolName === 'Task' || toolName === 'SendMessage') return '';
  return sanitizeAssistantTextForDisplay(resultText);
}
