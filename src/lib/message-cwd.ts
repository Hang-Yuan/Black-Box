function cleanCwd(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

/** Keep the most specific working directory when duplicate stream snapshots
 * describe the same message. Claude can emit a broad session cwd after a
 * tool or final record has already supplied the directory that owns a file. */
export function preferMessageCwd(current?: string, candidate?: string): string | undefined {
  const existing = cleanCwd(current);
  const incoming = cleanCwd(candidate);
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (incoming === existing || incoming.startsWith(`${existing}/`)) return incoming;
  if (existing.startsWith(`${incoming}/`)) return existing;
  return incoming;
}

/** A real human prompt starts a new cwd observation window. Tool-result
 * records also use type=user, so inspect their content before resetting. */
export function isHumanPromptStreamEvent(msg: any): boolean {
  if (msg?.type !== 'user' && msg?.type !== 'human') return false;
  const content = msg?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) =>
    typeof block === 'string'
    || (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0));
}
