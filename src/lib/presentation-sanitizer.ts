/** Claude CLI state-machine placeholders that never belong in user-visible prose. */
export const CLI_INTERNAL_PLACEHOLDERS: readonly string[] = [
  'No response requested.',
  'No response requested',
  '[Request interrupted by user]',
  '(no content)',
  'No content',
];

export function isCliPlaceholder(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return CLI_INTERNAL_PLACEHOLDERS.some((placeholder) => trimmed === placeholder);
}

/**
 * Remove Claude Code's private agent coordination metadata from anything that
 * can reach the visible conversation, exports, or a restored session.
 *
 * Raw task notifications belong to the Agent activity projection. The lead
 * agent may synthesize their useful result afterward, but the notification
 * envelope and its verbatim subagent report must never become chat prose.
 */
export function sanitizeAssistantTextForDisplay(value: unknown): string {
  if (typeof value !== 'string') return value == null ? '' : JSON.stringify(value);
  if (isCliPlaceholder(value)) return '';

  let text = value.replace(
    /<task-notification\b[^>]*>[\s\S]*?<\/task-notification>\s*/gi,
    '',
  );
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

  return isCliPlaceholder(text) ? '' : text;
}

export function sanitizeToolResultForDisplay(
  toolName: string | undefined,
  resultText: string,
): string {
  if (toolName === 'Agent' || toolName === 'Task' || toolName === 'SendMessage') return '';
  return sanitizeAssistantTextForDisplay(resultText);
}
