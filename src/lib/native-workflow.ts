import type { ChatMessage } from '../stores/chatStore';

export const NATIVE_WORKFLOW_ARGS_MAX_LENGTH = 12_000;

export type NativeWorkflowRunStatus =
  | 'requested'
  | 'launching'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed';

export interface NativeWorkflowReceipt {
  status: NativeWorkflowRunStatus;
  taskId?: string;
  workflowName?: string;
  runId?: string;
  transcriptDir?: string;
  scriptPath?: string;
  summary?: string;
  error?: string;
}

function validWorkflowName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

export function buildNativeWorkflowCommand(name: string, args: string): string {
  const normalizedName = name.trim();
  if (!validWorkflowName(normalizedName)) {
    throw new Error('Invalid native workflow name');
  }
  const normalizedArgs = args.trim();
  if (normalizedArgs.length > NATIVE_WORKFLOW_ARGS_MAX_LENGTH) {
    throw new Error('Native workflow input is too long');
  }
  const input = normalizedArgs
    ? JSON.stringify({ name: normalizedName, args: normalizedArgs })
    : JSON.stringify({ name: normalizedName });
  return [
    `Run the saved native Claude Code workflow “${normalizedName}”.`,
    `Call the Workflow tool exactly once with this exact input: ${input}`,
    'Do not recreate the workflow inline and do not substitute Agent, Skill, Loop, or Scheduled.',
  ].join('\n');
}

function objectFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return objectFromUnknown(JSON.parse(trimmed));
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      return objectFromUnknown(JSON.parse(trimmed.slice(first, last + 1)));
    } catch {
      return null;
    }
  }
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function parseNativeWorkflowReceipt(raw: unknown): NativeWorkflowReceipt | null {
  const value = typeof raw === 'string'
    ? parseJsonObject(raw)
    : objectFromUnknown(raw);
  if (!value) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const text = raw.trim();
    const lowered = text.toLowerCase();
    if (/\b(error|failed|failure)\b/.test(lowered)) {
      return { status: 'failed', error: text };
    }
    if (/\bworkflow\b/.test(lowered) && /\b(launched|started|running)\b/.test(lowered)) {
      return {
        status: 'running',
        runId: text.match(/Run ID:\s*(wf_[a-z0-9_-]+)/i)?.[1]
          || text.match(/\bwf_[a-z0-9_-]+\b/i)?.[0],
        taskId: text.match(/Task ID:\s*([^\s]+)/i)?.[1],
        transcriptDir: text.match(/Transcript dir:\s*([^\n]+)/i)?.[1]?.trim(),
        scriptPath: text.match(/Script file:\s*([^\n]+)/i)?.[1]?.trim(),
        summary: text.match(/Summary:\s*([^\n]+)/i)?.[1]?.trim() || text,
      };
    }
    return null;
  }
  const nested = objectFromUnknown(value.result) || value;
  const workflowName = stringField(nested, 'workflowName', 'workflow_name', 'name');
  const runId = stringField(nested, 'runId', 'run_id');
  const taskId = stringField(nested, 'taskId', 'task_id');
  const transcriptDir = stringField(nested, 'transcriptDir', 'transcript_dir');
  const scriptPath = stringField(nested, 'scriptPath', 'script_path');
  const summary = stringField(nested, 'summary', 'message');
  const error = stringField(nested, 'error');
  const rawStatus = stringField(nested, 'status')?.toLowerCase();
  if (!workflowName && !runId && !taskId && !scriptPath && !rawStatus && !error) return null;
  let status: NativeWorkflowRunStatus = 'running';
  if (error || rawStatus?.includes('fail') || rawStatus === 'error') status = 'failed';
  else if (rawStatus?.includes('complete') || rawStatus === 'success' || rawStatus === 'done') status = 'completed';
  else if (rawStatus?.includes('launch') || rawStatus === 'running') status = 'running';
  return { status, taskId, workflowName, runId, transcriptDir, scriptPath, summary, error };
}

export interface DerivedWorkflowRun extends NativeWorkflowReceipt {
  toolUseId: string;
  requestedName: string;
  args?: unknown;
  startedAt: number;
  completedAt?: number;
}

export function deriveNativeWorkflowRuns(messages: ChatMessage[]): DerivedWorkflowRun[] {
  const runs = new Map<string, DerivedWorkflowRun>();
  for (const message of messages) {
    if (message.type !== 'tool_use' || !['Workflow', 'RunWorkflow'].includes(message.toolName || '')) continue;
    const input = objectFromUnknown(message.toolInput) || {};
    const requestedName = stringField(input, 'name') || 'dynamic-workflow';
    const receipt = parseNativeWorkflowReceipt(message.toolResultContent || message.toolResult);
    runs.set(message.id, {
      toolUseId: message.id,
      requestedName,
      args: input.args,
      startedAt: message.timestamp,
      ...(receipt || { status: message.toolCompleted ? 'failed' : 'launching' as const }),
      ...(message.toolCompleted ? { completedAt: message.timestamp } : {}),
    });
  }
  return Array.from(runs.values()).sort((left, right) => right.startedAt - left.startedAt);
}
