export interface AsyncAgentLaunch {
  toolUseId?: string;
  taskId: string;
  description?: string;
  model?: string;
}

export interface AgentTaskNotification {
  toolUseId?: string;
  taskId?: string;
  status: string;
  resultText?: string;
}

/**
 * Claude can mirror subagent SDK frames into the lead process when
 * --forward-subagent-text is enabled. They are useful execution telemetry for
 * the Agent panel, but they are not lead-agent conversation messages.
 */
export function isForwardedSubagentEvent(message: any): boolean {
  const parentToolUseId = message?.parent_tool_use_id ?? message?.parentToolUseId;
  return message?.isSidechain === true
    || (typeof parentToolUseId === 'string' && parentToolUseId.trim().length > 0);
}

function firstToolUseId(message: any): string | undefined {
  const topLevel = message?.tool_use_id ?? message?.toolUseId;
  if (typeof topLevel === 'string' && topLevel.trim()) return topLevel.trim();
  const blocks = Array.isArray(message?.message?.content)
    ? message.message.content
    : Array.isArray(message?.content)
      ? message.content
      : [];
  const block = blocks.find((item: any) => (
    item?.type === 'tool_result'
    && typeof (item.tool_use_id ?? item.toolUseId) === 'string'
  ));
  const blockId = block?.tool_use_id ?? block?.toolUseId;
  return typeof blockId === 'string' && blockId.trim() ? blockId.trim() : undefined;
}

/** Parse Claude's immediate receipt for an asynchronously launched Agent. */
export function parseAsyncAgentLaunch(message: any): AsyncAgentLaunch | null {
  const payload = message?.toolUseResult ?? message?.tool_use_result;
  if (!payload || typeof payload !== 'object') return null;
  const status = String(payload.status ?? '').trim().toLowerCase();
  if (payload.isAsync !== true && payload.is_async !== true && status !== 'async_launched') {
    return null;
  }
  const rawTaskId = payload.agentId ?? payload.agent_id ?? payload.taskId ?? payload.task_id;
  if (typeof rawTaskId !== 'string' || !rawTaskId.trim()) return null;
  const description = typeof payload.description === 'string' && payload.description.trim()
    ? payload.description.trim()
    : undefined;
  const modelValue = payload.resolvedModel ?? payload.resolved_model ?? payload.model;
  const model = typeof modelValue === 'string' && modelValue.trim()
    ? modelValue.trim()
    : undefined;
  return {
    toolUseId: firstToolUseId(message),
    taskId: rawTaskId.trim(),
    description,
    model,
  };
}

function xmlValue(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\s*>([^<]+)</${tag}>`, 'i').exec(text);
  return match?.[1]?.trim() || undefined;
}

/** Parse durable XML notifications emitted both live and into Claude JSONL. */
export function parseAgentTaskNotification(text: unknown): AgentTaskNotification | null {
  if (typeof text !== 'string' || !/<task-notification\b/i.test(text)) return null;
  const taskId = xmlValue(text, 'task-id')
    ?? /<task-notification\b[^>]*\bid=["']([^"']+)["']/i.exec(text)?.[1]?.trim();
  const toolUseId = xmlValue(text, 'tool-use-id');
  const explicitStatus = xmlValue(text, 'status');
  const legacyStatus = /\b(completed|failed|error|cancelled|canceled)\b/i.exec(text)?.[1];
  const status = (explicitStatus ?? legacyStatus ?? '').trim().toLowerCase();
  if (!status || (!taskId && !toolUseId)) return null;
  const resultText = /<result\s*>([\s\S]*?)<\/result>/i.exec(text)?.[1]?.trim() || undefined;
  return { taskId, toolUseId, status, ...(resultText ? { resultText } : {}) };
}

export function messageTextContent(message: any): string {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (typeof block === 'string') return block;
    if (typeof block?.text === 'string') return block.text;
    if (typeof block?.content === 'string') return block.content;
    return '';
  }).join('');
}

export function isFailedAgentTaskStatus(status: unknown): boolean {
  return /^(failed|error|cancelled|canceled)$/i.test(String(status ?? '').trim());
}
