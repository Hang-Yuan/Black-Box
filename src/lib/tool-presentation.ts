export interface ToolPresentationInput {
  toolName?: string;
  toolInput?: unknown;
}

const MAX_DESCRIPTION_LENGTH = 96;
const MAX_GROUP_DESCRIPTION_LENGTH = 48;

const VERIFIED_CHINESE_ANNOTATIONS = new Map<string, string>([
  ['inspect one brain employee config fields', '查看单个脑员工的配置字段'],
  ['dump all nine brains config', '导出九个大脑的配置'],
  ['dump skillsets and meta per brain', '导出每个大脑的技能集和元数据'],
  ['list team skills and skillset details', '列出团队技能和技能集详情'],
  ['probe skill binding and org endpoints', '检查技能绑定和组织接口'],
  ['grep acceptance for skill endpoints', '搜索技能接口的验收条件'],
  ['get current time', '获取当前时间'],
]);

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

/**
 * Preserve the harness text as the authority and append Chinese only for an
 * exact, human-reviewed phrase. Unknown descriptions remain untouched.
 */
export function getToolBilingualDescription(
  toolName: string | undefined,
  toolInput: unknown,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string | null {
  const description = getToolSemanticDescription(toolName, toolInput, maxLength);
  if (!description) return null;
  const key = description.toLowerCase().replace(/[.!?]+$/g, '').trim();
  const chinese = VERIFIED_CHINESE_ANNOTATIONS.get(key);
  return chinese ? `${description}（${chinese}）` : description;
}

/** Compact semantic group summary with a deterministic raw-tool fallback. */
export function buildSemanticToolSummary(
  messages: ToolPresentationInput[],
  maxEntries = 3,
): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const semantic = getToolBilingualDescription(
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
