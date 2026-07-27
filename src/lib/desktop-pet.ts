export type DesktopPetPhase = 'idle' | 'thinking' | 'tool' | 'running' | 'waiting' | 'error';

export interface DesktopPetState {
  phase: DesktopPetPhase;
  source: 'app' | 'session' | 'agent' | 'workflow';
  detail?: string;
  updatedAt: number;
}

export interface DesktopPetTabSnapshot {
  id: string;
  selected: boolean;
  sessionStatus: string;
  activityPhase: string;
  toolName?: string;
}

export interface DesktopPetAgentSnapshot {
  id: string;
  phase: string;
  currentTool?: string;
  isMain?: boolean;
}

export interface DesktopPetWorkflowSnapshot {
  tabId: string;
  workflowName: string;
  status: string;
}

export interface DesktopPetSnapshot {
  tabs: DesktopPetTabSnapshot[];
  agents: DesktopPetAgentSnapshot[];
  workflows: DesktopPetWorkflowSnapshot[];
}

type DerivedDesktopPetState = Omit<DesktopPetState, 'updatedAt'>;

const IDLE: DerivedDesktopPetState = { phase: 'idle', source: 'app' };

function tabPhase(tab: DesktopPetTabSnapshot): DerivedDesktopPetState {
  if (tab.sessionStatus === 'error' || tab.activityPhase === 'error') {
    return { phase: 'error', source: 'session' };
  }
  if (tab.activityPhase === 'awaiting') {
    return { phase: 'waiting', source: 'session' };
  }
  if (tab.activityPhase === 'tool') {
    return { phase: 'tool', source: 'session', detail: tab.toolName };
  }
  if (tab.activityPhase === 'thinking') {
    return { phase: 'thinking', source: 'session' };
  }
  if (
    tab.activityPhase === 'writing'
    || tab.activityPhase === 'reconnecting'
    || tab.sessionStatus === 'running'
    || tab.sessionStatus === 'reconnecting'
    || tab.sessionStatus === 'stopping'
  ) {
    return { phase: 'running', source: 'session' };
  }
  return IDLE;
}

function activeAgentState(agents: DesktopPetAgentSnapshot[]): DerivedDesktopPetState | null {
  const tool = agents.find((agent) => agent.phase === 'tool');
  if (tool) return { phase: 'tool', source: 'agent', detail: tool.currentTool };

  if (agents.some((agent) => agent.phase === 'thinking')) {
    return { phase: 'thinking', source: 'agent' };
  }
  if (agents.some((agent) => agent.phase === 'spawning' || agent.phase === 'writing')) {
    return { phase: 'running', source: 'agent' };
  }
  if (agents.some((agent) => agent.isMain && agent.phase === 'error')) {
    return { phase: 'error', source: 'agent' };
  }
  return null;
}

function activeWorkflowState(
  workflows: DesktopPetWorkflowSnapshot[],
): DerivedDesktopPetState | null {
  const active = workflows.find((workflow) => (
    workflow.status === 'requested'
    || workflow.status === 'launching'
    || workflow.status === 'running'
  ));
  return active
    ? { phase: 'running', source: 'workflow', detail: active.workflowName }
    : null;
}

/**
 * Maps the stores' existing runtime evidence onto the compact companion state.
 * The selected task wins first; background work is considered only when that
 * task is idle, so an old background error cannot pin the companion forever.
 */
export function deriveDesktopPetState(snapshot: DesktopPetSnapshot): DerivedDesktopPetState {
  const selected = snapshot.tabs.find((tab) => tab.selected);
  if (selected) {
    const selectedState = tabPhase(selected);
    if (selectedState.phase !== 'idle') return selectedState;
  }

  const agentState = activeAgentState(snapshot.agents);
  if (agentState) return agentState;

  const workflowState = activeWorkflowState(snapshot.workflows);
  if (workflowState) return workflowState;

  const backgroundStates = snapshot.tabs
    .filter((tab) => !tab.selected)
    .map(tabPhase);
  for (const phase of ['tool', 'thinking', 'running', 'waiting'] as const) {
    const match = backgroundStates.find((state) => state.phase === phase);
    if (match) return match;
  }

  return IDLE;
}

export const DESKTOP_PET_STATE_EVENT = 'blackbox://desktop-pet-state';
export const DESKTOP_PET_STATE_REQUEST_EVENT = 'blackbox://desktop-pet-state-request';
export const DESKTOP_PET_ENABLED_EVENT = 'blackbox://desktop-pet-enabled';

export const DEFAULT_DESKTOP_PET_STATE: DesktopPetState = {
  ...IDLE,
  updatedAt: 0,
};
