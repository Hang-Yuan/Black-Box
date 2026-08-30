export interface ToolPresentationInput {
  toolName?: string;
  toolInput?: unknown;
}

const MAX_DESCRIPTION_LENGTH = 96;
const MAX_GROUP_DESCRIPTION_LENGTH = 48;

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '•••')
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 •••')
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password)(\s*[:=]\s*)[^\s,;]+/gi,
      '$1$2•••',
    );
}

function cleanDescription(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = redactSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength - 1).trimEnd()}…`
    : cleaned;
}

/**
 * Claude's Bash tool carries a short, human-authored `description` alongside
 * the exact command. Surface that description as the primary UI label while
 * keeping the raw Bash command available in the expandable detail view.
 */
export function getToolSemanticDescription(
  toolName: string | undefined,
  toolInput: unknown,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string | null {
  if (toolName !== 'Bash' || !toolInput || typeof toolInput !== 'object') return null;
  return cleanDescription((toolInput as { description?: unknown }).description, maxLength);
}

/** Compact semantic group summary with a deterministic raw-tool fallback. */
export function buildSemanticToolSummary(
  messages: ToolPresentationInput[],
  maxEntries = 3,
): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const semantic = getToolSemanticDescription(
      message.toolName,
      message.toolInput,
      MAX_GROUP_DESCRIPTION_LENGTH,
    );
    const label = semantic
      ? `${message.toolName || 'Tool'}：${semantic}`
      : message.toolName || 'Tool';
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  const entries = Array.from(counts.entries());
  const visible = entries.slice(0, Math.max(1, maxEntries));
  const labels = visible.map(([label, count]) => (
    count > 1 ? `${label} ×${count}` : label
  ));
  const hiddenCount = entries
    .slice(visible.length)
    .reduce((total, [, count]) => total + count, 0);
  if (hiddenCount > 0) labels.push(`+${hiddenCount}`);
  return labels.join(', ');
}
