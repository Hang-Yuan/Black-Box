import { useMemo, useState, useEffect } from 'react';
import { useAgentStore, AgentNode, AgentPhase } from '../../stores/agentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useActiveTab } from '../../stores/chatStore';
import { useT } from '../../lib/i18n';

// --- Phase visual config ---

const phaseConfig: Record<AgentPhase, {
  color: string;
  pulseColor: string;
  pulse: boolean;
  labelKey: string;
}> = {
  spawning: {
    color: 'bg-text-tertiary',
    pulseColor: 'bg-text-tertiary/40',
    pulse: true,
    labelKey: 'agents.spawning',
  },
  thinking: {
    color: 'bg-amber-400',
    pulseColor: 'bg-amber-400/40',
    pulse: true,
    labelKey: 'agents.thinking',
  },
  writing: {
    color: 'bg-accent',
    pulseColor: 'bg-accent/40',
    pulse: true,
    labelKey: 'agents.writing',
  },
  tool: {
    color: 'bg-blue-400',
    pulseColor: 'bg-blue-400/40',
    pulse: true,
    labelKey: 'agents.runningTool',
  },
  idle: {
    color: 'bg-text-tertiary',
    pulseColor: '',
    pulse: false,
    labelKey: 'agents.idle',
  },
  completed: {
    color: 'bg-green-500',
    pulseColor: '',
    pulse: false,
    labelKey: 'agents.completed',
  },
  error: {
    color: 'bg-red-500',
    pulseColor: '',
    pulse: false,
    labelKey: 'agents.error',
  },
};

// --- Elapsed time display ---

function ElapsedTime({ startTime, endTime }: { startTime: number; endTime?: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (endTime) return; // no need to tick if already finished
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endTime]);

  const elapsed = Math.floor(((endTime || now) - startTime) / 1000);
  if (elapsed < 60) return <span>{elapsed}s</span>;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return <span>{mins}m {secs}s</span>;
}

// --- Status dot ---

function StatusDot({ phase }: { phase: AgentPhase }) {
  const config = phaseConfig[phase];
  return (
    <span className="relative flex-shrink-0 w-2 h-2">
      {config.pulse && (
        <span className={`absolute inset-0 rounded-full animate-ping ${config.pulseColor}`} />
      )}
      <span className={`relative block w-2 h-2 rounded-full ${config.color}`} />
    </span>
  );
}

// --- Agent tree node ---

function AgentTreeNode({
  agent,
  children,
  depth,
  auxiliaryModel,
}: {
  agent: AgentNode;
  children: AgentNode[];
  depth: number;
  auxiliaryModel?: string;
}) {
  const t = useT();
  const agents = useAgentStore((s) => s.agents);
  const config = phaseConfig[agent.phase];

  // Get children of this agent
  const childAgents = useMemo(
    () => children.filter((a) => a.parentId === agent.id),
    [children, agent.id],
  );

  // All agents for recursive rendering
  const allAgents = useMemo(() => Array.from(agents.values()), [agents]);

  const isFinished = agent.phase === 'completed' || agent.phase === 'error' || agent.phase === 'idle';
  const label = agent.isMain
    ? t('agents.main')
    : agent.kind === 'teammate'
      ? (agent.name || t('agents.teammate'))
      : (agent.name || t('agents.claudeSubAgent'));
  const taskDescription = !agent.isMain && agent.description && agent.description !== agent.name
    ? agent.description
    : '';
  const modelLabel = !agent.isMain ? (agent.model || auxiliaryModel) : undefined;

  // Phase status text
  const phaseText = agent.phase === 'tool' && agent.currentTool
    ? `${t(config.labelKey)}: ${agent.currentTool}`
    : t(config.labelKey);

  return (
    <div style={{ paddingLeft: `${depth * 16}px` }}>
      {/* Node content */}
      <div className={`group flex flex-col gap-0.5 py-1.5 px-2 rounded-lg
        transition-smooth
        ${isFinished ? 'opacity-70' : ''}
        hover:bg-bg-secondary/50`}>
        {/* Top line: dot + title + elapsed */}
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot phase={agent.phase} />
          <span className={`text-xs font-medium truncate flex-1 min-w-0
            ${isFinished ? 'text-text-muted' : 'text-text-primary'}`}>
            {label}
          </span>
          {!agent.isMain && (
            <span className={`text-[8px] uppercase tracking-wide px-1 py-0.5 rounded
              ${agent.kind === 'teammate' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-tertiary'}`}>
              {agent.kind === 'teammate' ? t('agents.teammate') : t('agents.subAgent')}
            </span>
          )}
          <span className="text-[10px] text-text-tertiary font-mono flex-shrink-0 tabular-nums">
            <ElapsedTime startTime={agent.startTime} endTime={agent.endTime} />
          </span>
        </div>
        {taskDescription && (
          <div className="line-clamp-2 pl-4 text-[10px] leading-4 text-text-muted">
            {taskDescription}
          </div>
        )}
        {/* Bottom line: phase and concrete auxiliary model */}
        <div className="flex items-center gap-2 pl-4">
          <span className={`text-[10px] truncate
            ${agent.phase === 'error' ? 'text-red-400' : 'text-text-tertiary'}`}>
            {phaseText}{modelLabel ? ` · ${modelLabel}` : ''}
          </span>
        </div>
      </div>

      {/* Children */}
      {childAgents.length > 0 && (
        <div className="relative">
          {/* Vertical connecting line */}
          <div className="absolute left-[11px] top-0 bottom-2 w-px bg-border-subtle" />
          {childAgents.map((child) => (
            <AgentTreeNode
              key={child.id}
              agent={child}
              children={allAgents}
              depth={depth + 1}
              auxiliaryModel={auxiliaryModel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main panel ---

export function AgentPanel() {
  const t = useT();
  const agents = useAgentStore((s) => s.agents);
  const teamTasks = useAgentStore((s) => s.teamTasks);
  const agentTeamsEnabled = useSettingsStore((s) => s.agentTeamsEnabled);
  const setAgentTeamsEnabled = useSettingsStore((s) => s.setAgentTeamsEnabled);
  const sessionStatus = useActiveTab((tab) => tab.sessionStatus);
  const auxiliaryModel = useActiveTab((tab) => tab.sessionMeta.configSnapshot?.auxiliaryModel);

  const agentList = useMemo(() => Array.from(agents.values()), [agents]);
  const mainAgent = useMemo(() => agentList.find((a) => a.isMain), [agentList]);
  const activeCount = useMemo(
    () => agentList.filter((a) => !['idle', 'completed', 'error'].includes(a.phase)).length,
    [agentList],
  );
  const totalCount = agentList.length;
  const tasks = useMemo(
    () => Array.from(teamTasks.values()).filter((task) => task.status !== 'deleted'),
    [teamTasks],
  );
  const teamToggleBusy = sessionStatus === 'running' || sessionStatus === 'stopping';

  const toggleTeams = () => {
    if (teamToggleBusy) return;
    if (!agentTeamsEnabled && !window.confirm(t('agents.teams.confirm'))) return;
    setAgentTeamsEnabled(!agentTeamsEnabled);
  };

  // Empty state
  if (totalCount === 0) {
    return (
      <div className="flex flex-col h-full">
        <TeamRuntimeControl
          enabled={agentTeamsEnabled}
          disabled={teamToggleBusy}
          onToggle={toggleTeams}
        />
        <div className="flex-1 flex flex-col items-center justify-center
          px-4 text-center">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none"
            stroke="currentColor" strokeWidth="1.2"
            className="text-text-tertiary/40 mb-3">
            <circle cx="16" cy="12" r="5" />
            <path d="M8 26a8 8 0 0116 0" />
            <circle cx="26" cy="10" r="3" />
            <path d="M22 20a5 5 0 0110 0" strokeDasharray="2 2" />
          </svg>
          <p className="text-xs text-text-tertiary leading-relaxed">
            {t('agents.empty')}
          </p>
        </div>
      </div>
    );
  }

  return (
      <div className="flex flex-col h-full">
      <TeamRuntimeControl
        enabled={agentTeamsEnabled}
        disabled={teamToggleBusy}
        onToggle={toggleTeams}
      />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2
        border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-text-tertiary
            uppercase tracking-wider">{t('agents.title')}</span>
          {activeCount > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full
              bg-accent/15 text-accent font-medium">
              {activeCount} {t('agents.active')}
            </span>
          )}
        </div>
        <span className="text-[10px] text-text-tertiary">
          {totalCount} {totalCount === 1 ? 'agent' : 'agents'}
        </span>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {mainAgent && (
          <AgentTreeNode
            agent={mainAgent}
            children={agentList}
            depth={0}
            auxiliaryModel={auxiliaryModel}
          />
        )}
        {/* Orphan agents (parentId doesn't match any known agent) — fallback */}
        {agentList
          .filter((a) => !a.isMain && a.parentId && !agents.has(a.parentId))
          .map((orphan) => (
            <AgentTreeNode
              key={orphan.id}
              agent={orphan}
              children={agentList}
              depth={0}
              auxiliaryModel={auxiliaryModel}
            />
          ))}
        {tasks.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border-subtle px-2 pb-2">
            <div className="text-[9px] uppercase tracking-wider text-text-tertiary mb-1.5">
              {t('agents.tasks')}
            </div>
            <div className="space-y-1">
              {tasks.map((task) => (
                <div key={task.id} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-bg-secondary/40">
                  <span className={`mt-1 h-1.5 w-1.5 rounded-full flex-shrink-0
                    ${task.status === 'completed'
                      ? 'bg-success'
                      : task.status === 'in_progress'
                        ? 'bg-amber-400 animate-pulse-soft'
                        : 'bg-text-tertiary/50'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] text-text-muted leading-4 break-words">{task.subject}</div>
                    <div className="text-[9px] text-text-tertiary">
                      #{task.id} · {task.owner || t(`agents.task.${task.status}`)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TeamRuntimeControl({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <div className="px-3 py-2.5 border-b border-border-subtle bg-bg-secondary/20">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-text-primary">{t('agents.teams.title')}</span>
            <span className="rounded bg-warning/10 px-1 py-0.5 text-[8px] uppercase text-warning">
              {t('agents.teams.experimental')}
            </span>
          </div>
          <p className="mt-0.5 text-[9px] leading-3.5 text-text-tertiary">
            {enabled ? t('agents.teams.enabledHint') : t('agents.teams.disabledHint')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="agent-teams-toggle"
          disabled={disabled}
          onClick={onToggle}
          className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors
            ${enabled ? 'bg-accent' : 'bg-bg-tertiary'} disabled:opacity-40`}>
          <span
            className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
            style={{ transform: `translateX(${enabled ? 16 : 0}px)` }}
          />
        </button>
      </div>
      {enabled && (
        <p className="mt-2 rounded-md bg-warning/5 px-2 py-1.5 text-[9px] leading-4 text-text-tertiary">
          {t('agents.teams.resumeWarning')}
        </p>
      )}
    </div>
  );
}
