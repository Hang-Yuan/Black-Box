export interface HandoffSummary {
  goal: string;
  constraints: string[];
  completed: string[];
  pending: string[];
  pendingDecisions: string[];
  references: { location: string; purpose: string }[];
  nextStep: string;
}

export interface GeneratedHandoff {
  summary: HandoffSummary;
  sourceDigest: string;
  sourcePath: string;
  sourceCwd: string;
  generationInputTokens: number;
}

export function validateHandoffSummary(summary: HandoffSummary): boolean {
  if (!summary || typeof summary.goal !== 'string' || !summary.goal.trim()
    || typeof summary.nextStep !== 'string' || !summary.nextStep.trim()) return false;
  const lists = [summary.constraints, summary.completed, summary.pending, summary.pendingDecisions];
  if (lists.some((list) => !Array.isArray(list) || list.length > 8
    || list.some((item) => typeof item !== 'string' || !item.trim()))) return false;
  if (!Array.isArray(summary.references) || summary.references.length > 8
    || summary.references.some((ref) => !ref || typeof ref.location !== 'string' || !ref.location.trim()
      || typeof ref.purpose !== 'string' || !ref.purpose.trim())) return false;
  const serialized = JSON.stringify(summary);
  return [...serialized].length <= 3_000 && new TextEncoder().encode(serialized).length <= 8_000;
}

/** Treat an unnumbered conversation as part 1; increment only its final digits. */
export function nextConversationTitle(title: string): string {
  const name = title.trim();
  const suffix = name.match(/[0-9]+$/);
  if (!suffix) return `${name}2`;
  return `${name.slice(0, suffix.index)}${BigInt(suffix[0]) + BigInt(1)}`;
}

export function formatHandoffSummary(summary: HandoffSummary, locale: string): string {
  if (!validateHandoffSummary(summary)) throw new Error('HANDOFF_INVALID_SUMMARY');
  const labels = locale === 'zh'
    ? ['当前目标', '有效约束', '已完成', '未完成', '待用户决定', '文件与证据入口', '下一步']
    : ['Current goal', 'Constraints', 'Completed', 'Pending', 'User decisions needed', 'References', 'Next step'];
  const list = (label: string, items: string[]) => items.length ? `## ${label}\n${items.map((s) => `- ${s}`).join('\n')}` : '';
  return [`## ${labels[0]}\n${summary.goal}`, list(labels[1], summary.constraints),
    list(labels[2], summary.completed), list(labels[3], summary.pending),
    list(labels[4], summary.pendingDecisions), list(labels[5], summary.references.map((ref) => `${ref.location}：${ref.purpose}`)),
    `## ${labels[6]}\n${summary.nextStep}`].filter(Boolean).join('\n\n');
}

/** Only the validated task-state summary enters a fresh conversation. */
export function buildConversationHandoff(handoff: GeneratedHandoff, title: string, locale: string): string {
  const { summary } = handoff;
  const heading = locale === 'zh'
    ? `接续「${title}」的当前任务。以下为原会话生成的交接摘要。`
    : `Continue the current task from “${title}”. The original context prepared this handoff.`;
  const guidance = summary.pendingDecisions.length ? (locale === 'zh'
    ? '当前正在等待用户决定。本轮只用简短文字提出下面的待决问题，然后等待答复；等待期间不调用工具。用户作出选择后，再开展对应工作。下面的摘要用于保留任务状态。'
    : 'The task is awaiting a user decision. This turn only asks the pending questions in brief plain text and waits for an answer, without calling tools while waiting. Continue the corresponding work after the user chooses. The summary below preserves the task state.')
    : locale === 'zh'
    ? '沿用已完成结论，接上当前断点。只有具体信息缺失或证据冲突时，才按列出的文件和段落局部补读；不要为恢复上下文全量重读历史或重跑已完成验证。'
    : 'Use completed conclusions and resume the current task state. Read specific referenced sections only for a concrete gap or contradiction; do not reload the full history or repeat completed verification merely to reconstruct context.';
  const decision = summary.pendingDecisions.length
    ? locale === 'zh' ? '当前有待用户决定的事项：先提出待决问题，得到答复后再执行相应工作。'
      : 'User decisions are pending: ask those questions and wait for answers before executing the corresponding work.'
    : locale === 'zh' ? '只继续已获授权且尚未完成的下一步。' : 'Continue only the next authorized, unfinished step.';
  return [heading, guidance, decision, formatHandoffSummary(summary, locale),
    locale === 'zh' ? `原始记录（仅供必要时局部定位）：${handoff.sourcePath}`
      : `Original record (targeted lookup only if needed): ${handoff.sourcePath}`].join('\n\n');
}
