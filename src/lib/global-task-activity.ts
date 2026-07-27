export type TaskActivityStatus =
  | 'waiting_user'
  | 'running'
  | 'queued'
  | 'failed'
  | 'completed'
  | 'paused'
  | 'resume_pending';

export type TaskActivityDetailKind = 'plan' | 'workflow' | 'loop';

export interface ThreadActivitySource {
  threadId: string;
  title?: string;
  updatedAt: number;
  running?: boolean;
  waitingFor?: 'question' | 'permission' | 'plan_review';
}

export interface PlanActivitySource {
  threadId: string;
  explanation?: string;
  items: readonly {
    step: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed';
  }[];
  updatedAt: number;
}

export interface WorkflowActivitySource {
  localId: string;
  tabId: string;
  workflowName: string;
  status: 'requested' | 'launching' | 'running' | 'interrupted' | 'completed' | 'failed';
  updatedAt: number;
  summary?: string;
  error?: string;
  phases: readonly { state?: string }[];
}

export interface LoopActivitySource {
  threadId: string;
  jobId: string;
  cron: string;
  status: TaskActivityStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Deliberately excludes prompts, cwd lists, credentials, provider config and
 * run output. The global task centre only needs a safe scheduling summary.
 */
export interface AutomationActivitySummary {
  id: string;
  title: string;
  definitionStatus: string;
  runStatus: string | null;
  scheduleKind: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  activeRunId: string | null;
  running: boolean;
  unreadRuns: number;
  updatedAt: number;
}

interface ActivityDetailBase {
  id: string;
  kind: TaskActivityDetailKind;
  label: string;
  status: TaskActivityStatus;
  updatedAt: number;
}

export interface PlanActivityDetail extends ActivityDetailBase {
  kind: 'plan';
  completed: number;
  total: number;
  currentStep?: string;
}

export interface WorkflowActivityDetail extends ActivityDetailBase {
  kind: 'workflow';
  summary?: string;
  error?: string;
  completedPhases: number;
  totalPhases: number;
}

export interface LoopActivityDetail extends ActivityDetailBase {
  kind: 'loop';
  jobId: string;
  cron: string;
}

export type TaskActivityDetail =
  | PlanActivityDetail
  | WorkflowActivityDetail
  | LoopActivityDetail;

export interface ThreadActivityRow {
  kind: 'thread';
  id: string;
  threadId: string;
  title: string;
  status: TaskActivityStatus;
  paused: boolean;
  resumePending: boolean;
  updatedAt: number;
  details: TaskActivityDetail[];
}

export interface AutomationActivityRow {
  kind: 'automation';
  id: string;
  automationId: string;
  title: string;
  status: TaskActivityStatus;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  scheduleKind: string;
  activeRunId: string | null;
  unreadRuns: number;
}

export interface GlobalTaskActivityInput {
  threads: readonly ThreadActivitySource[];
  plans: Readonly<Record<string, PlanActivitySource>>;
  workflowRuns: Readonly<Record<string, readonly WorkflowActivitySource[]>>;
  loopJobs: readonly LoopActivitySource[];
  automations: readonly AutomationActivitySummary[];
}

export interface GlobalTaskActivitySnapshot {
  threads: ThreadActivityRow[];
  automations: AutomationActivityRow[];
}

export interface TaskActivityStatusSummary {
  status: TaskActivityStatus;
  paused: boolean;
  resumePending: boolean;
}

const STATUS_PRIORITY: Readonly<Record<Exclude<TaskActivityStatus, 'paused' | 'resume_pending'>, number>> = {
  waiting_user: 5,
  running: 4,
  queued: 3,
  failed: 2,
  completed: 1,
};

const DETAIL_KIND_PRIORITY: Readonly<Record<TaskActivityDetailKind, number>> = {
  plan: 3,
  workflow: 2,
  loop: 1,
};

const ROW_STATUS_PRIORITY: Readonly<Record<TaskActivityStatus, number>> = {
  waiting_user: 7,
  running: 6,
  queued: 5,
  resume_pending: 4,
  paused: 3,
  failed: 2,
  completed: 1,
};

function isPrimaryStatus(
  status: TaskActivityStatus,
): status is Exclude<TaskActivityStatus, 'paused' | 'resume_pending'> {
  return status !== 'paused' && status !== 'resume_pending';
}

/**
 * paused and resume_pending are orthogonal flags. They never outrank live
 * work, but remain visible even when another detail supplies the row status.
 */
export function summarizeTaskActivityStatuses(
  statuses: readonly TaskActivityStatus[],
): TaskActivityStatusSummary {
  const paused = statuses.includes('paused');
  const resumePending = statuses.includes('resume_pending');
  const primary = statuses
    .filter(isPrimaryStatus)
    .sort((left, right) => STATUS_PRIORITY[right] - STATUS_PRIORITY[left])[0];

  return {
    status: primary || (resumePending ? 'resume_pending' : paused ? 'paused' : 'completed'),
    paused,
    resumePending,
  };
}

function planStatus(
  plan: PlanActivitySource,
  threadRunning: boolean,
): TaskActivityStatus {
  if (plan.items.some((item) => item.status === 'in_progress')) {
    return threadRunning ? 'running' : 'resume_pending';
  }
  if (plan.items.length > 0 && plan.items.every((item) => item.status === 'completed')) {
    return 'completed';
  }
  return 'queued';
}

function workflowStatus(workflow: WorkflowActivitySource): TaskActivityStatus {
  if (workflow.status === 'requested' || workflow.status === 'launching') return 'queued';
  if (workflow.status === 'interrupted') return 'resume_pending';
  return workflow.status;
}

function automationStatus(automation: AutomationActivitySummary): TaskActivityStatus {
  const runStatus = automation.runStatus?.toUpperCase();
  if (automation.running || runStatus === 'RUNNING') return 'running';
  if (runStatus === 'PENDING_REVIEW') return 'waiting_user';
  if (runStatus === 'FAILED') return 'failed';
  if (automation.definitionStatus.toUpperCase() === 'PAUSED') return 'paused';
  if (runStatus === 'CANCELLED' || runStatus === 'ARCHIVED') return 'completed';
  if (automation.nextRunAt !== null) return 'queued';
  return automation.lastRunAt !== null ? 'completed' : 'queued';
}

function fallbackThreadTitle(threadId: string): string {
  const compactId = threadId.length > 12 ? `${threadId.slice(0, 8)}…` : threadId;
  return `会话 ${compactId}`;
}

function normalizedTitle(title: string | undefined, threadId: string): string {
  const value = title?.replace(/\s+/g, ' ').trim();
  return value || fallbackThreadTitle(threadId);
}

interface MutableThreadRow {
  source?: ThreadActivitySource;
  details: TaskActivityDetail[];
  statuses: TaskActivityStatus[];
}

export function buildGlobalTaskActivity(
  input: GlobalTaskActivityInput,
): GlobalTaskActivitySnapshot {
  const sources = new Map(input.threads.map((thread) => [thread.threadId, thread]));
  const rows = new Map<string, MutableThreadRow>();
  const ensureRow = (threadId: string): MutableThreadRow => {
    const existing = rows.get(threadId);
    if (existing) return existing;
    const row: MutableThreadRow = {
      source: sources.get(threadId),
      details: [],
      statuses: [],
    };
    rows.set(threadId, row);
    return row;
  };

  for (const thread of input.threads) {
    if (thread.waitingFor) ensureRow(thread.threadId).statuses.push('waiting_user');
    if (thread.running) ensureRow(thread.threadId).statuses.push('running');
  }

  for (const [threadId, plan] of Object.entries(input.plans)) {
    const status = planStatus(plan, Boolean(sources.get(threadId)?.running));
    const completed = plan.items.filter((item) => item.status === 'completed').length;
    const current = plan.items.find((item) => item.status === 'in_progress');
    const row = ensureRow(threadId);
    row.statuses.push(status);
    row.details.push({
      id: `plan:${threadId}`,
      kind: 'plan',
      label: 'Plan',
      status,
      updatedAt: plan.updatedAt,
      completed,
      total: plan.items.length,
      ...(current ? { currentStep: current.activeForm || current.step } : {}),
    });
  }

  for (const [threadId, workflows] of Object.entries(input.workflowRuns)) {
    for (const workflow of workflows) {
      const status = workflowStatus(workflow);
      const row = ensureRow(threadId);
      row.statuses.push(status);
      row.details.push({
        id: `workflow:${workflow.localId}`,
        kind: 'workflow',
        label: workflow.workflowName || 'Workflow',
        status,
        updatedAt: workflow.updatedAt,
        summary: workflow.summary,
        error: workflow.error,
        completedPhases: workflow.phases.filter((phase) => phase.state === 'completed').length,
        totalPhases: workflow.phases.length,
      });
    }
  }

  for (const loop of input.loopJobs) {
    const status = loop.status === 'running' && !sources.get(loop.threadId)?.running
      ? 'resume_pending'
      : loop.status;
    const row = ensureRow(loop.threadId);
    row.statuses.push(status);
    row.details.push({
      id: `loop:${loop.threadId}:${loop.jobId}`,
      kind: 'loop',
      label: 'Loop',
      status,
      updatedAt: loop.updatedAt,
      jobId: loop.jobId,
      cron: loop.cron,
    });
  }

  const threadRows = [...rows.entries()].map<ThreadActivityRow>(([threadId, row]) => {
    const status = summarizeTaskActivityStatuses(row.statuses);
    const details = row.details.sort((left, right) => (
      DETAIL_KIND_PRIORITY[right.kind] - DETAIL_KIND_PRIORITY[left.kind]
      || right.updatedAt - left.updatedAt
    ));
    return {
      kind: 'thread',
      id: `thread:${threadId}`,
      threadId,
      title: normalizedTitle(row.source?.title, threadId),
      status: status.status,
      paused: status.paused,
      resumePending: status.resumePending,
      updatedAt: Math.max(
        row.source?.updatedAt || 0,
        ...details.map((detail) => detail.updatedAt),
      ),
      details,
    };
  }).sort((left, right) => (
    ROW_STATUS_PRIORITY[right.status] - ROW_STATUS_PRIORITY[left.status]
    || right.updatedAt - left.updatedAt
  ));

  const automationRows = input.automations.map<AutomationActivityRow>((automation) => ({
    kind: 'automation',
    id: `automation:${automation.id}`,
    automationId: automation.id,
    title: automation.title.replace(/\s+/g, ' ').trim() || '未命名自动化',
    status: automationStatus(automation),
    updatedAt: automation.updatedAt,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    scheduleKind: automation.scheduleKind,
    activeRunId: automation.activeRunId,
    unreadRuns: Math.max(0, automation.unreadRuns),
  })).sort((left, right) => right.updatedAt - left.updatedAt);

  return { threads: threadRows, automations: automationRows };
}
