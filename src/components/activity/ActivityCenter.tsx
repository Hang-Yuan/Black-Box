import { useMemo, useState } from 'react';
import {
  buildGlobalTaskActivity,
  type AutomationActivitySummary,
  type TaskActivityDetail,
  type TaskActivityDetailKind,
  type TaskActivityStatus,
  type ThreadActivitySource,
  type ThreadActivityRow,
} from '../../lib/global-task-activity';
import { isSessionBusy, useChatStore } from '../../stores/chatStore';
import { isAgentActive, useAgentStore } from '../../stores/agentStore';
import { useLoopStore } from '../../stores/loopStore';
import { usePlanStore } from '../../stores/planStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkflowStore } from '../../stores/workflowStore';

export interface ActivityCenterProps {
  automations?: readonly AutomationActivitySummary[];
  onOpenThread: (threadId: string) => void;
  onClose?: () => void;
}

const EMPTY_AUTOMATIONS: readonly AutomationActivitySummary[] = [];

const STATUS_LABEL: Readonly<Record<TaskActivityStatus, string>> = {
  waiting_user: '需处理',
  running: '运行中',
  queued: '排队中',
  failed: '失败',
  completed: '已完成',
  paused: '已暂停',
  resume_pending: '待恢复',
};

const STATUS_CLASS: Readonly<Record<TaskActivityStatus, string>> = {
  waiting_user: 'bg-warning/15 text-warning',
  running: 'bg-accent/15 text-accent',
  queued: 'bg-text-tertiary/15 text-text-muted',
  failed: 'bg-error/15 text-error',
  completed: 'bg-success/15 text-success',
  paused: 'bg-text-tertiary/15 text-text-tertiary',
  resume_pending: 'bg-warning/15 text-warning',
};

const DETAIL_LABEL: Readonly<Record<TaskActivityDetailKind, string>> = {
  plan: 'Plan',
  workflow: 'Workflow',
  loop: 'Loop',
};

const DETAIL_ORDER: readonly TaskActivityDetailKind[] = ['plan', 'workflow', 'loop'];

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function sessionTitle(
  session: { id: string; project: string },
  customPreviews: Readonly<Record<string, string>>,
): string {
  const custom = customPreviews[session.id]?.trim();
  const project = session.project.split(/[\\/]/).filter(Boolean).pop();
  const compactId = session.id.length > 12 ? `${session.id.slice(0, 8)}…` : session.id;
  return custom || (project ? `${project} · ${compactId}` : '');
}

function StatusBadge({ status }: { status: TaskActivityStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function DetailBody({ detail }: { detail: TaskActivityDetail }) {
  if (detail.kind === 'plan') {
    return (
      <div className="mt-1 text-[11px] leading-5 text-text-muted">
        <span>{detail.completed}/{detail.total} 已完成</span>
        {detail.currentStep && <p className="line-clamp-2 text-text-tertiary">{detail.currentStep}</p>}
      </div>
    );
  }
  if (detail.kind === 'workflow') {
    return (
      <div className="mt-1 text-[11px] leading-5 text-text-muted">
        {detail.totalPhases > 0 && <p>{detail.completedPhases}/{detail.totalPhases} 阶段完成</p>}
        {detail.summary && <p className="line-clamp-2 text-text-tertiary">{detail.summary}</p>}
        {detail.error && <p className="line-clamp-2 text-error">{detail.error}</p>}
      </div>
    );
  }
  return (
    <div className="mt-1 text-[11px] leading-5 text-text-muted">
      <span className="font-mono">{detail.cron}</span>
      <span className="ml-2 text-text-tertiary">#{detail.jobId}</span>
    </div>
  );
}

function ExpandedThreadDetails({ row }: { row: ThreadActivityRow }) {
  return (
    <div className="grid gap-2 border-t border-border-subtle/70 bg-bg-secondary/20 px-4 py-3 md:grid-cols-2">
      {DETAIL_ORDER.map((kind) => {
        const details = row.details.filter((detail) => detail.kind === kind);
        if (details.length === 0) return null;
        return (
          <section key={kind} data-activity-detail-kind={kind}
            className="rounded-lg border border-border-subtle/70 bg-bg-primary/55 p-3">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
              <span>{DETAIL_LABEL[kind]}</span>
              <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[9px]">{details.length}</span>
            </div>
            <div className="space-y-2">
              {details.map((detail) => (
                <div key={detail.id} className="rounded-md bg-bg-secondary/55 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
                      {detail.label}
                    </span>
                    <StatusBadge status={detail.status} />
                  </div>
                  <DetailBody detail={detail} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {row.details.length === 0 && (
        <div className="text-xs text-text-tertiary">会话正在运行，尚未产生结构化任务详情。</div>
      )}
    </div>
  );
}

export function ActivityCenter({
  automations = EMPTY_AUTOMATIONS,
  onOpenThread,
  onClose,
}: ActivityCenterProps) {
  const sessions = useSessionStore((state) => state.sessions);
  const customPreviews = useSessionStore((state) => state.customPreviews);
  const runningSessions = useSessionStore((state) => state.runningSessions);
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId);
  const tabs = useChatStore((state) => state.tabs);
  const visibleAgents = useAgentStore((state) => state.agents);
  const agentCache = useAgentStore((state) => state.agentCache);
  const plans = usePlanStore((state) => state.plans);
  const workflowRuns = useWorkflowStore((state) => state.liveRuns);
  const loopJobs = useLoopStore((state) => state.jobs);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(() => new Set());

  const threadSources = useMemo(() => {
    const threadsWithBackgroundAgents = new Set<string>();
    for (const [threadId, cachedAgents] of agentCache) {
      if (threadId === selectedSessionId) continue;
      if (Array.from(cachedAgents.values()).some((agent) => agent.background && isAgentActive(agent))) {
        threadsWithBackgroundAgents.add(threadId);
      }
    }
    if (
      selectedSessionId
      && Array.from(visibleAgents.values()).some((agent) => agent.background && isAgentActive(agent))
    ) {
      threadsWithBackgroundAgents.add(selectedSessionId);
    }
    const sources = new Map<string, ThreadActivitySource>(sessions.map((session) => [session.id, {
      threadId: session.id,
      title: sessionTitle(session, customPreviews),
      updatedAt: session.modifiedAt,
      running: runningSessions.has(session.id) || threadsWithBackgroundAgents.has(session.id),
      waitingFor: undefined,
    }]));
    for (const [threadId, tab] of tabs) {
      const existing = sources.get(threadId);
      sources.set(threadId, {
        threadId,
        title: existing?.title,
        updatedAt: Math.max(
          existing?.updatedAt || 0,
          tab.lastAccessedAt,
          tab.sessionMeta.lastProgressAt || 0,
        ),
        running: Boolean(
          existing?.running
          || isSessionBusy(tab.sessionStatus)
          || threadsWithBackgroundAgents.has(threadId)
        ),
        waitingFor: tab.waitingFor,
      });
    }
    return [...sources.values()];
  }, [agentCache, customPreviews, runningSessions, selectedSessionId, sessions, tabs, visibleAgents]);

  const snapshot = useMemo(() => buildGlobalTaskActivity({
    threads: threadSources,
    plans,
    workflowRuns,
    loopJobs,
    automations,
  }), [automations, loopJobs, plans, threadSources, workflowRuns]);

  const activeCount = snapshot.threads.filter((row) => (
    ['waiting_user', 'running', 'queued', 'resume_pending'].includes(row.status)
  )).length;
  const failedCount = snapshot.threads.filter((row) => row.status === 'failed').length;

  const toggleExpanded = (threadId: string) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-chat" data-testid="activity-center">
      <header className="flex flex-wrap items-start gap-4 border-b border-border-subtle px-7 py-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-text-primary">全局任务中心</h1>
          <p className="mt-1 text-xs leading-5 text-text-tertiary">
            每个会话只占一行；Plan、Workflow 与 Loop 在行内展开查看。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="rounded-lg bg-bg-secondary px-3 py-2">进行中 {activeCount}</span>
          <span className="rounded-lg bg-bg-secondary px-3 py-2">失败 {failedCount}</span>
          <span className="rounded-lg bg-bg-secondary px-3 py-2">自动化 {snapshot.automations.length}</span>
          {onClose && (
            <button type="button" onClick={onClose}
              className="rounded-lg border border-border-subtle px-3 py-2 hover:bg-bg-secondary"
              aria-label="关闭任务中心">
              关闭
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <section aria-labelledby="thread-activity-heading">
          <div className="mb-3 flex items-center gap-2">
            <h2 id="thread-activity-heading" className="text-sm font-semibold text-text-primary">会话任务</h2>
            <span className="text-xs text-text-tertiary">{snapshot.threads.length}</span>
          </div>
          <div className="space-y-2">
            {snapshot.threads.map((row) => {
              const expanded = expandedThreads.has(row.threadId);
              return (
                <article key={row.id} data-activity-thread-id={row.threadId}
                  className="overflow-hidden rounded-xl border border-border-subtle bg-bg-primary/55">
                  <div className="flex min-w-0 items-center gap-2 px-3 py-2">
                    <button type="button" onClick={() => onOpenThread(row.threadId)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-bg-secondary/70"
                      title="打开会话">
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${
                        row.status === 'running' ? 'bg-accent animate-pulse-soft'
                          : row.status === 'failed' ? 'bg-error'
                            : row.status === 'completed' ? 'bg-success'
                              : row.status === 'waiting_user' || row.status === 'resume_pending' ? 'bg-warning'
                                : 'bg-text-tertiary/50'
                      }`} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{row.title}</span>
                      <span className="hidden text-[10px] text-text-tertiary sm:inline">{formatTime(row.updatedAt)}</span>
                    </button>
                    <StatusBadge status={row.status} />
                    {row.paused && row.status !== 'paused' && <StatusBadge status="paused" />}
                    {row.resumePending && row.status !== 'resume_pending' && <StatusBadge status="resume_pending" />}
                    <button type="button" onClick={() => toggleExpanded(row.threadId)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? '收起' : '展开'} ${row.title} 的任务详情`}
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-tertiary hover:bg-bg-secondary hover:text-text-primary">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                        strokeWidth="1.5" className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
                        <path d="M3 5l4 4 4-4" />
                      </svg>
                    </button>
                  </div>
                  {expanded && <ExpandedThreadDetails row={row} />}
                </article>
              );
            })}
            {snapshot.threads.length === 0 && (
              <div className="rounded-xl border border-dashed border-border-subtle px-6 py-12 text-center text-sm text-text-tertiary">
                暂无 Plan、Workflow、Loop 或运行中的会话。
              </div>
            )}
          </div>
        </section>

        <section className="mt-8" aria-labelledby="automation-activity-heading">
          <div className="mb-3 flex items-center gap-2">
            <h2 id="automation-activity-heading" className="text-sm font-semibold text-text-primary">自动化</h2>
            <span className="text-xs text-text-tertiary">{snapshot.automations.length}</span>
          </div>
          <div className="space-y-2">
            {snapshot.automations.map((automation) => (
              <div key={automation.id} data-activity-automation-id={automation.automationId}
                className="flex min-w-0 items-center gap-3 rounded-xl border border-border-subtle bg-bg-primary/55 px-5 py-4">
                <span className="h-2 w-2 flex-shrink-0 rounded-full bg-text-tertiary/50" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary">{automation.title}</div>
                  <div className="mt-1 text-[10px] text-text-tertiary">
                    <span>{automation.scheduleKind}</span>
                    <span className="mx-1">·</span>
                    {automation.nextRunAt !== null
                      ? `下次 ${formatTime(automation.nextRunAt)}`
                      : automation.lastRunAt !== null
                        ? `上次 ${formatTime(automation.lastRunAt)}`
                        : '尚未运行'}
                    {automation.unreadRuns > 0 && (
                      <span className="ml-2 text-accent">{automation.unreadRuns} 条新结果</span>
                    )}
                  </div>
                </div>
                <StatusBadge status={automation.status} />
              </div>
            ))}
            {snapshot.automations.length === 0 && (
              <div className="rounded-xl border border-dashed border-border-subtle px-6 py-8 text-center text-sm text-text-tertiary">
                暂无已安排自动化。
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
