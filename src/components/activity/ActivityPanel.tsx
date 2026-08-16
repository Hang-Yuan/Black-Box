import { useEffect, useMemo, useRef, useState } from 'react';
import { getPlanProgress } from '../../lib/plan-contract';
import { bridge, type AutomationActivitySummary } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { useActiveTab } from '../../stores/chatStore';
import { isAgentActive, useAgentStore, type AgentNode } from '../../stores/agentStore';
import { usePlanStore } from '../../stores/planStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorkflowStore, type LiveWorkflowRun } from '../../stores/workflowStore';
import { useLoopStore } from '../../stores/loopStore';
import { sanitizeAssistantTextForDisplay } from '../../lib/presentation-sanitizer';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';

type Tone = 'active' | 'done' | 'waiting' | 'idle' | 'error';

const EMPTY_WORKFLOW_RUNS: LiveWorkflowRun[] = [];
const AUTOMATION_POLL_INTERVAL_MS = 2_500;
const RUNTIME_STALL_WARNING_MS = 120_000;

const TONE_CLASS: Record<Tone, string> = {
  active: 'bg-accent animate-pulse-soft',
  done: 'bg-success',
  waiting: 'bg-warning',
  idle: 'bg-text-tertiary/40',
  error: 'bg-error',
};

function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${TONE_CLASS[tone]}`} />;
}

function Section({
  title,
  count,
  active = false,
  children,
}: {
  title: string;
  count?: number;
  active?: boolean;
  children: React.ReactNode;
}) {
  const sectionRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (active && sectionRef.current) sectionRef.current.open = true;
  }, [active]);
  return (
    <details
      ref={sectionRef}
      className="group border-b border-border-subtle/70 last:border-b-0"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[10px]
        font-semibold uppercase tracking-[0.12em] text-text-tertiary hover:bg-bg-secondary/35">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
          strokeWidth="1.4" className="transition-transform group-open:rotate-90">
          <path d="M3.5 2l3 3-3 3" />
        </svg>
        <span>{title}</span>
        {typeof count === 'number' && count > 0 && (
          <span className="ml-auto rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-muted">
            {count}
          </span>
        )}
      </summary>
      <div className="space-y-2 px-3 pb-3">{children}</div>
    </details>
  );
}

function workflowTone(run: LiveWorkflowRun): Tone {
  if (run.status === 'failed' || run.status === 'interrupted') return 'error';
  if (run.status === 'completed') return 'done';
  if (run.status === 'requested' || run.status === 'launching') return 'waiting';
  return 'active';
}

function agentTone(agent: AgentNode): Tone {
  if (agent.phase === 'interrupted' || agent.phase === 'error') return 'error';
  if (agent.phase === 'completed') return 'done';
  if (agent.phase === 'idle' || agent.phase === 'spawning') return 'waiting';
  return 'active';
}

function formatLastActivity(
  now: number,
  lastProgressAt: number | undefined,
  t: (key: string) => string,
): string {
  if (!lastProgressAt) return t('input.activityUnknown');
  const elapsedSeconds = Math.max(0, Math.floor((now - lastProgressAt) / 1000));
  if (elapsedSeconds < 5) return t('input.activityNow');
  if (elapsedSeconds < 60) {
    return t('input.activitySecondsAgo').replace('{count}', String(elapsedSeconds));
  }
  return t('input.activityMinutesAgo').replace(
    '{count}',
    String(Math.floor(elapsedSeconds / 60)),
  );
}

export function ActivityPanel() {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const tabId = useSessionStore((state) => state.selectedSessionId);
  const allLoopJobs = useLoopStore((state) => state.jobs);
  const sessionStatus = useActiveTab((tab) => tab.sessionStatus);
  const activityStatus = useActiveTab((tab) => tab.activityStatus);
  const lastProgressAt = useActiveTab((tab) => tab.sessionMeta.lastProgressAt);
  const auxiliaryModel = useActiveTab((tab) => tab.sessionMeta.configSnapshot?.auxiliaryModel);
  const loopSessionLive = useActiveTab((tab) => Boolean(
    tab.sessionMeta.stdinId && tab.sessionMeta.stdinReady,
  ));
  const plan = usePlanStore((state) => tabId ? state.plans[tabId] : undefined);
  const workflowRuns = useWorkflowStore((state) => (
    tabId ? state.liveRuns[tabId] ?? EMPTY_WORKFLOW_RUNS : EMPTY_WORKFLOW_RUNS
  ));
  const applyRuntimeProgress = useWorkflowStore((state) => state.applyRuntimeProgress);
  const teamTasks = useAgentStore((state) => state.teamTasks);
  const agents = useAgentStore((state) => state.agents);
  const agentTeamsEnabled = useSettingsStore((state) => state.agentTeamsEnabled);
  const setAgentTeamsEnabled = useSettingsStore((state) => state.setAgentTeamsEnabled);
  const [automations, setAutomations] = useState<AutomationActivitySummary[]>([]);
  const [automationError, setAutomationError] = useState('');
  const [now, setNow] = useState(Date.now());

  const tasks = useMemo(
    () => Array.from(teamTasks.values()).filter((task) => task.status !== 'deleted'),
    [teamTasks],
  );
  const loopJobs = useMemo(
    () => allLoopJobs.filter((job) => job.threadId === tabId),
    [allLoopJobs, tabId],
  );
  const visibleAgents = useMemo(
    () => Array.from(agents.values())
      .filter((agent) => !agent.isMain)
      .sort((left, right) => right.startTime - left.startTime),
    [agents],
  );
  const activeAgents = useMemo(
    () => visibleAgents.filter(isAgentActive),
    [visibleAgents],
  );
  const orderedRuns = useMemo(
    () => [...workflowRuns].sort((left, right) => right.updatedAt - left.updatedAt),
    [workflowRuns],
  );
  const workflowProbeKey = useMemo(
    () => workflowRuns
      .filter((run) => run.managed
        && run.transcriptDir
        && run.runId
        && run.phases.length > 0
        && ['launching', 'running'].includes(run.status))
      .map((run) => `${run.localId}:${run.runId}:${run.transcriptDir}`)
      .join('|'),
    [workflowRuns],
  );
  const visibleAutomations = useMemo(
    () => automations.filter((automation) => (
      automation.definitionStatus.toUpperCase() === 'ACTIVE' || automation.running
    )),
    [automations],
  );
  const planProgress = plan ? getPlanProgress(plan.items) : undefined;
  const activeWorkflow = orderedRuns.some((run) => ['requested', 'launching', 'running'].includes(run.status));
  const activeLoop = loopSessionLive && loopJobs.some((job) => job.status === 'running');
  const activeTasks = tasks.filter((task) => task.status === 'in_progress').length;
  const automationRunning = automations.some((automation) => automation.running);
  const stalled = sessionStatus === 'running'
    && Boolean(lastProgressAt)
    && now - (lastProgressAt ?? now) > RUNTIME_STALL_WARNING_MS;
  const lastActivity = formatLastActivity(now, lastProgressAt, t);
  const backgroundActive = ['thinking', 'writing', 'tool', 'awaiting']
    .includes(activityStatus.phase);
  const busy = sessionStatus === 'running'
    || sessionStatus === 'stopping'
    || backgroundActive
    || activeWorkflow
    || activeLoop
    || activeTasks > 0
    || activeAgents.length > 0
    || automationRunning;
  const activityLabel = stalled
    ? t('input.backgroundWorkStalled')
    : automationRunning
    ? t('activity.scheduled')
    : activityStatus.phase === 'tool'
    ? `${t('chat.runningTool')}${activityStatus.toolName ? ` · ${activityStatus.toolName}` : ''}`
    : activityStatus.phase === 'writing'
      ? t('chat.writing')
      : activityStatus.phase === 'thinking'
        ? t('chat.thinking')
        : activityStatus.phase === 'awaiting'
          ? t('activity.waiting')
          : activeWorkflow
            ? t('activity.workflows')
            : activeLoop
              ? t('activity.loop')
            : activeTasks > 0
              ? t('activity.tasks')
              : activeAgents.length > 0
                ? t('activity.agents')
                : t('activity.currentTaskHint');

  const refreshAutomations = () => {
    setAutomationError('');
    void bridge.listAutomationActivitySummaries()
      .then(setAutomations)
      .catch((error) => setAutomationError(String(error)));
  };

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const focusAgentProcess = (event: Event) => {
      const agentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      if (!agentId) return;
      const card = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('[data-activity-agent-id]') ?? [],
      ).find((element) => element.dataset.activityAgentId === agentId);
      if (!card) return;
      let ancestor = card.parentElement;
      while (ancestor && ancestor !== panelRef.current) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      const process = card.querySelector<HTMLDetailsElement>(
        '[data-testid^="activity-panel-agent-process-"]',
      );
      if (process) process.open = true;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    window.addEventListener('blackbox:focus-agent-process', focusAgentProcess);
    return () => window.removeEventListener('blackbox:focus-agent-process', focusAgentProcess);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pollAutomations = async () => {
      try {
        const nextAutomations = await bridge.listAutomationActivitySummaries();
        if (!cancelled) {
          setAutomations(nextAutomations);
          setAutomationError('');
        }
      } catch {
        // Preserve the last trustworthy snapshot when the durable backend is
        // briefly unavailable. Manual refresh still exposes the error.
      }
    };
    void pollAutomations();
    const interval = window.setInterval(
      () => void pollAutomations(),
      AUTOMATION_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!tabId || !workflowProbeKey) return;
    let cancelled = false;
    const poll = async () => {
      const activeRuns = (useWorkflowStore.getState().liveRuns[tabId] || []).filter(
        (run) => run.managed
          && run.transcriptDir
          && run.runId
          && run.phases.length > 0
          && ['launching', 'running'].includes(run.status),
      );
      await Promise.all(activeRuns.map(async (run) => {
        try {
          const progress = await bridge.inspectWorkflowRuntimeProgress(
            run.transcriptDir as string,
            run.runId as string,
          );
          if (!cancelled) applyRuntimeProgress(tabId, run.localId, progress);
        } catch {
          // The native journal appears just after the Workflow launch receipt.
          // Keep the planned phase fallback visible until the next poll.
        }
      }));
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 600);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [applyRuntimeProgress, tabId, workflowProbeKey]);

  const openAutomations = () => {
    useSettingsStore.getState().setMainView('automations');
    if (useSettingsStore.getState().secondaryPanelOpen) {
      useSettingsStore.getState().toggleSecondaryPanel();
    }
  };

  const toggleAgentTeams = () => {
    if (sessionStatus === 'running' || sessionStatus === 'stopping') return;
    if (!agentTeamsEnabled && !window.confirm(t('agents.teams.confirm'))) return;
    setAgentTeamsEnabled(!agentTeamsEnabled);
  };

  return (
    <div ref={panelRef} data-testid="activity-panel" className="flex h-full flex-col bg-bg-chat">
      <div className="border-b border-border-subtle px-3 py-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={stalled ? 'error' : busy ? 'active' : 'idle'} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text-primary">
              {busy ? t('activity.running') : t('activity.idle')}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-text-tertiary">
              {busy ? activityLabel : t('activity.currentTaskHint')}
            </div>
            {busy && (
              <div className={`mt-0.5 text-[9px] ${stalled ? 'text-error' : 'text-text-tertiary'}`}>
                {t('input.lastActivity').replace('{time}', lastActivity)}
              </div>
            )}
          </div>
        </div>
        <div
          data-testid="activity-agent-teams-control"
          className="mt-2 flex items-center justify-between gap-3 rounded-md bg-bg-secondary/45 px-2 py-1.5"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-medium text-text-primary">{t('agents.teams.title')}</span>
              <span className="rounded bg-warning/10 px-1 py-0.5 text-[8px] uppercase text-warning">
                {t('agents.teams.experimental')}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[9px] text-text-tertiary">
              {agentTeamsEnabled ? t('agents.teams.enabledHint') : t('agents.teams.disabledHint')}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={agentTeamsEnabled}
            data-testid="agent-teams-toggle"
            disabled={sessionStatus === 'running' || sessionStatus === 'stopping'}
            onClick={toggleAgentTeams}
            className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors
              ${agentTeamsEnabled ? 'bg-accent' : 'bg-bg-tertiary'} disabled:opacity-40`}
          >
            <span
              className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
              style={{ transform: `translateX(${agentTeamsEnabled ? 16 : 0}px)` }}
            />
          </button>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5 text-center text-[9px] text-text-tertiary">
          <div className="rounded-md bg-bg-secondary/60 px-1 py-1.5">
            <div className="text-xs font-medium text-text-primary">{activeTasks}</div>{t('activity.tasks')}
          </div>
          <div className="rounded-md bg-bg-secondary/60 px-1 py-1.5">
            <div className="text-xs font-medium text-text-primary">{activeAgents.length}</div>{t('activity.agents')}
          </div>
          <div className="rounded-md bg-bg-secondary/60 px-1 py-1.5">
            <div className="text-xs font-medium text-text-primary">{activeWorkflow ? 1 : 0}</div>{t('activity.workflows')}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section title={t('activity.plan')} count={plan?.items.length || 0} active={Boolean(plan)}>
          {plan && planProgress ? (
            <>
              <div className="h-1 overflow-hidden rounded-full bg-bg-tertiary">
                <div className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${planProgress.total ? (planProgress.completed / planProgress.total) * 100 : 0}%` }} />
              </div>
              <div className="text-[9px] text-text-tertiary">
                {planProgress.completed}/{planProgress.total} {t('activity.completed')}
              </div>
              <div className="space-y-1">
                {plan.items.map((item, index) => (
                  <div key={`${index}-${item.step}`} className="flex items-start gap-2 rounded-md bg-bg-secondary/35 px-2 py-1.5">
                    <StatusDot tone={item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'active' : 'idle'} />
                    <span className="text-[10px] leading-4 text-text-muted">{item.activeForm || item.step}</span>
                  </div>
                ))}
              </div>
            </>
          ) : <div className="text-[10px] text-text-tertiary">{t('activity.none')}</div>}
        </Section>

        <Section title="Workflow" count={orderedRuns.length} active={activeWorkflow}>
          {orderedRuns.length > 0 ? orderedRuns.slice(0, 8).map((run) => (
            <div
              key={run.localId}
              data-activity-workflow-name={run.workflowName}
              data-activity-workflow-status={run.status}
              className="rounded-md bg-bg-secondary/35 px-2 py-2"
            >
              <div className="flex items-start gap-2">
                <StatusDot tone={workflowTone(run)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[10px] font-medium text-text-primary">{run.workflowName}</div>
                  <div className="mt-0.5 text-[9px] text-text-tertiary">{t(`workflow.status.${run.status}`)}</div>
                </div>
              </div>
              {run.phases.length > 0 && (
                <div className="mt-2 space-y-1 border-l border-border-subtle pl-2">
                  {run.phases.map((phase, index) => (
                    <div
                      key={`${index}-${phase.title}`}
                      data-activity-workflow-phase={phase.title}
                      data-activity-workflow-phase-state={phase.state || 'running'}
                      className="text-[9px] leading-4 text-text-muted"
                    >
                      <span className={phase.state === 'completed'
                        ? 'text-success'
                        : phase.state === 'failed'
                          ? 'text-error'
                          : phase.state === 'running'
                            ? 'text-accent'
                            : 'text-text-tertiary'}>●</span>
                      <span className="ml-1.5">{phase.title}</span>
                      {phase.detail && <div className="ml-3 text-text-tertiary">{phase.detail}</div>}
                    </div>
                  ))}
                </div>
              )}
              {run.summary && <div className="mt-1.5 line-clamp-3 text-[9px] leading-4 text-text-muted">{run.summary}</div>}
              {run.error && <div className="mt-1 text-[9px] text-error">{run.error}</div>}
            </div>
          )) : <div className="text-[10px] text-text-tertiary">{t('activity.none')}</div>}
        </Section>

        <Section title={t('activity.tasks')} count={tasks.length} active={activeTasks > 0}>
          {tasks.length > 0 ? tasks.map((task) => (
            <div
              key={task.id}
              data-activity-task-subject={task.subject}
              data-activity-task-status={task.status}
              className="flex items-start gap-2 rounded-md bg-bg-secondary/35 px-2 py-1.5"
            >
              <StatusDot tone={task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'active' : 'waiting'} />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] leading-4 text-text-primary">{task.activeForm || task.subject}</div>
                <div className="text-[9px] text-text-tertiary">#{task.id}{task.owner ? ` · ${task.owner}` : ''}</div>
              </div>
            </div>
          )) : <div className="text-[10px] text-text-tertiary">{t('activity.none')}</div>}
        </Section>

        <Section title={t('activity.agents')} count={visibleAgents.length} active={activeAgents.length > 0}>
          {visibleAgents.length > 0 ? visibleAgents.slice(0, 12).map((agent) => {
            const phaseKey = agent.phase === 'tool' ? 'agents.runningTool' : `agents.${agent.phase}`;
            const phaseLabel = agent.phase === 'tool' && agent.currentTool
              ? `${t(phaseKey)} · ${agent.currentTool}`
              : t(phaseKey);
            const agentIdentity = agent.kind === 'teammate'
              ? (agent.name || t('agents.teammate'))
              : (agent.name || t('agents.claudeSubAgent'));
            const modelLabel = agent.model || auxiliaryModel;
            const taskDescription = agent.description && agent.description !== agent.name
              ? agent.description
              : '';
            const agentActivity = (agent.activity ?? [])
              .map((entry) => entry.kind === 'text'
                ? { ...entry, content: sanitizeAssistantTextForDisplay(entry.content).trim() }
                : entry)
              .filter((entry) => entry.content.length > 0);
            return (
              <div
                key={agent.id}
                data-activity-agent-id={agent.id}
                data-activity-agent-name={agent.name || agent.description || ''}
                data-activity-agent-phase={agent.phase}
                className="flex items-start gap-2 rounded-md bg-bg-secondary/35 px-2 py-1.5"
              >
                <StatusDot tone={agentTone(agent)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[10px] leading-4 text-text-primary">
                    {agentIdentity}
                  </div>
                  {taskDescription && (
                    <div className="line-clamp-2 text-[9px] leading-4 text-text-muted">
                      {taskDescription}
                    </div>
                  )}
                  <div className="truncate text-[9px] text-text-tertiary">
                    {phaseLabel}{modelLabel ? ` · ${modelLabel}` : ''}
                  </div>
                  {agentActivity.length > 0 && (
                    <details
                      data-testid={`activity-panel-agent-process-${agent.id}`}
                      className="group/process mt-1 border-t border-border-subtle/50 pt-1"
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-[9px] text-text-tertiary select-none">
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="transition-transform group-open/process:rotate-90"
                        >
                          <path d="M3 2l4 3-4 3" />
                        </svg>
                        <span>{t('agents.activity').replace('{count}', String(agentActivity.length))}</span>
                        <span className="truncate text-text-tertiary/60">{t('agents.activityPrivate')}</span>
                      </summary>
                      <div className="mt-1 max-h-80 space-y-2 overflow-y-auto border-l border-border-subtle pl-2">
                        {agentActivity.map((entry) => entry.kind === 'tool' ? (
                          <div key={entry.id} className="flex items-center gap-1.5 text-[9px] text-text-tertiary">
                            <span className="h-1 w-1 rounded-full bg-blue-400" />
                            <span>{t('agents.activityTool')}{entry.toolName ? ` · ${entry.toolName}` : ''}</span>
                          </div>
                        ) : (
                          <div key={entry.id} className="text-[10px] leading-4 text-text-muted">
                            <MarkdownRenderer content={entry.content} />
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          }) : <div className="text-[10px] text-text-tertiary">{t('activity.none')}</div>}
        </Section>

        <Section title="Loop" count={loopJobs.length} active={loopJobs.length > 0}>
          {loopJobs.length > 0 ? loopJobs.map((job) => (
            <div
              key={job.jobId}
              data-activity-loop-id={job.jobId}
              data-activity-loop-state={activeLoop ? 'active' : 'resume-pending'}
              className="rounded-md bg-bg-secondary/35 px-2 py-1.5"
            >
              <div className="flex items-start gap-2"><StatusDot tone={activeLoop ? 'active' : 'waiting'} />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-text-primary">{job.cron || t('loop.dynamic')}</div>
                  <div className="mt-0.5 text-[9px] text-text-tertiary">
                    {activeLoop ? t('activity.loopLive') : t('activity.loopResumePending')}
                  </div>
                </div>
              </div>
            </div>
          )) : <div className="text-[10px] text-text-tertiary">{t('activity.none')}</div>}
        </Section>

        <Section title={t('activity.scheduled')} count={visibleAutomations.length} active={automationRunning}>
          {automationError && <div className="text-[9px] text-error">{automationError}</div>}
          {visibleAutomations.slice(0, 8).map((automation) => (
            <div
              key={automation.id}
              data-activity-automation-id={automation.id}
              data-activity-automation-running={automation.running ? 'true' : 'false'}
              className="flex items-start gap-2 rounded-md bg-bg-secondary/35 px-2 py-1.5"
            >
              <StatusDot tone={automation.running ? 'active' : 'idle'} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[10px] text-text-primary">{automation.title}</div>
                <div className="text-[9px] text-text-tertiary">
                  {automation.running ? t('activity.running') : automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : t('activity.noNextRun')}
                </div>
              </div>
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={refreshAutomations} className="text-[9px] text-text-tertiary hover:text-text-primary">
              {t('activity.refresh')}
            </button>
            <button type="button" onClick={openAutomations} className="text-[9px] text-accent hover:underline">
              {t('activity.manageScheduled')}
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}
