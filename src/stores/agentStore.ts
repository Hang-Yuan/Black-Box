import { create } from 'zustand';

// --- Types ---

export type AgentPhase = 'spawning' | 'thinking' | 'writing' | 'tool' | 'idle' | 'completed' | 'error';
export type AgentKind = 'main' | 'subagent' | 'teammate';

export interface AgentNode {
  id: string;
  parentId: string | null;
  description: string;
  phase: AgentPhase;
  currentTool?: string;
  startTime: number;
  endTime?: number;
  isMain: boolean;
  kind?: AgentKind;
  /** Stable user-facing teammate name. Never expose Claude's internal agent id. */
  name?: string;
  /** User-facing subagent model/type metadata advertised by the Agent tool. */
  model?: string;
  /** Claude background task id, retained only for event correlation. */
  taskId?: string;
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TeamTask {
  id: string;
  toolUseId?: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  status: TeamTaskStatus;
  createdAt: number;
  updatedAt: number;
}

interface AgentState {
  agents: Map<string, AgentNode>;
  teamTasks: Map<string, TeamTask>;
  /** Per-session agent cache for tab switching */
  agentCache: Map<string, Map<string, AgentNode>>;
  teamTaskCache: Map<string, Map<string, TeamTask>>;

  upsertAgent: (node: Partial<AgentNode> & { id: string }) => void;
  updatePhase: (id: string, phase: AgentPhase, currentTool?: string) => void;
  completeAgent: (id: string, phase?: AgentPhase) => void;
  completeAll: (phase?: AgentPhase, preserveTeammates?: boolean) => void;
  setAgentIdle: (id: string) => void;
  resetForTurn: (description: string, preserveTeammates: boolean) => void;
  registerTeamTask: (toolUseId: string, input: Record<string, unknown>) => void;
  resolveTeamTask: (toolUseId: string, resultText: string) => void;
  updateTeamTask: (input: Record<string, unknown>) => void;
  clearAgents: () => void;
  /** Save current agents to cache for a tab */
  saveToCache: (tabId: string) => void;
  /** Restore agents from cache for a tab (returns true if found) */
  restoreFromCache: (tabId: string) => boolean;
  /** Drop per-tab cache entry (call when the session is deleted) — fixes #B9 ghost-agent on delete+recreate with same ID */
  clearCacheForTab: (tabId: string) => void;
  /** Move cached Agent/Team state when a draft tab adopts its real Claude UUID. */
  moveCache: (oldTabId: string, newTabId: string) => void;
}

// --- Store ---

export const useAgentStore = create<AgentState>()((set, get) => ({
  agents: new Map(),
  teamTasks: new Map(),
  agentCache: new Map(),
  teamTaskCache: new Map(),

  upsertAgent: (node) => {
    const next = new Map(get().agents);
    const existing = next.get(node.id);
    const merged = { ...existing, ...node } as AgentNode;
    if (node.phase && !['idle', 'completed', 'error'].includes(node.phase)) {
      merged.endTime = undefined;
    }
    next.set(node.id, merged);
    set({ agents: next });
  },

  updatePhase: (id, phase, currentTool) => {
    const next = new Map(get().agents);
    const agent = next.get(id);
    if (agent && agent.phase !== 'completed' && agent.phase !== 'error') {
      if (agent.phase === 'writing' && phase === 'thinking') {
        return;
      }
      next.set(id, { ...agent, phase, currentTool, endTime: undefined });
      set({ agents: next });
    }
  },

  completeAgent: (id, phase = 'completed') => {
    const next = new Map(get().agents);
    const agent = next.get(id);
    if (agent && agent.phase !== 'completed' && agent.phase !== 'error') {
      next.set(id, { ...agent, phase, endTime: Date.now(), currentTool: undefined });
      set({ agents: next });
    }
  },

  completeAll: (phase = 'completed', preserveTeammates = false) => {
    const next = new Map(get().agents);
    let changed = false;
    for (const [id, agent] of next) {
      if (agent.phase !== 'completed' && agent.phase !== 'error') {
        const nextPhase = preserveTeammates && agent.kind === 'teammate' && phase === 'completed'
          ? 'idle'
          : phase;
        next.set(id, { ...agent, phase: nextPhase, endTime: Date.now(), currentTool: undefined });
        changed = true;
      }
    }
    if (changed) set({ agents: next });
  },

  setAgentIdle: (id) => {
    const next = new Map(get().agents);
    const agent = next.get(id);
    if (!agent || agent.phase === 'error') return;
    next.set(id, {
      ...agent,
      phase: agent.kind === 'teammate' ? 'idle' : 'completed',
      endTime: Date.now(),
      currentTool: undefined,
    });
    set({ agents: next });
  },

  resetForTurn: (description, preserveTeammates) => {
    const agents = new Map<string, AgentNode>();
    if (preserveTeammates) {
      for (const [id, agent] of get().agents) {
        if (agent.kind === 'teammate') agents.set(id, { ...agent });
      }
    }
    agents.set('main', {
      id: 'main',
      parentId: null,
      description,
      phase: 'spawning',
      startTime: Date.now(),
      isMain: true,
      kind: 'main',
    });
    set({
      agents,
      teamTasks: preserveTeammates ? new Map(get().teamTasks) : new Map(),
    });
  },

  registerTeamTask: (toolUseId, input) => {
    const now = Date.now();
    const id = `pending:${toolUseId}`;
    const next = new Map(get().teamTasks);
    next.set(id, {
      id,
      toolUseId,
      subject: String(input.subject || input.description || 'Team task'),
      description: typeof input.description === 'string' ? input.description : undefined,
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
      owner: typeof input.owner === 'string' ? input.owner : undefined,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    set({ teamTasks: next });
  },

  resolveTeamTask: (toolUseId, resultText) => {
    const next = new Map(get().teamTasks);
    const entry = Array.from(next.values()).find((task) => task.toolUseId === toolUseId);
    if (!entry) return;
    const parsedId = /Task\s+#(\d+)/i.exec(resultText)?.[1];
    if (!parsedId || parsedId === entry.id) return;
    next.delete(entry.id);
    next.set(parsedId, { ...entry, id: parsedId, updatedAt: Date.now() });
    set({ teamTasks: next });
  },

  updateTeamTask: (input) => {
    const id = String(input.taskId || input.task_id || '').trim();
    if (!id) return;
    const now = Date.now();
    const next = new Map(get().teamTasks);
    const existing = next.get(id);
    const requestedStatus = String(input.status || '').toLowerCase();
    const status: TeamTaskStatus = requestedStatus === 'in_progress'
      ? 'in_progress'
      : requestedStatus === 'completed'
        ? 'completed'
        : requestedStatus === 'deleted'
          ? 'deleted'
          : existing?.status ?? 'pending';
    next.set(id, {
      id,
      toolUseId: existing?.toolUseId,
      subject: typeof input.subject === 'string'
        ? input.subject
        : existing?.subject ?? `Task #${id}`,
      description: typeof input.description === 'string'
        ? input.description
        : existing?.description,
      activeForm: existing?.activeForm,
      owner: typeof input.owner === 'string' ? input.owner : existing?.owner,
      status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    set({ teamTasks: next });
  },

  clearAgents: () => set({ agents: new Map(), teamTasks: new Map() }),

  saveToCache: (tabId) => {
    const next = new Map(get().agentCache);
    next.set(tabId, new Map(get().agents));
    const nextTasks = new Map(get().teamTaskCache);
    nextTasks.set(tabId, new Map(get().teamTasks));
    set({ agentCache: next, teamTaskCache: nextTasks });
  },

  restoreFromCache: (tabId) => {
    const cached = get().agentCache.get(tabId);
    if (!cached) {
      set({ agents: new Map(), teamTasks: new Map() });
      return false;
    }
    set({
      agents: new Map(cached),
      teamTasks: new Map(get().teamTaskCache.get(tabId) ?? []),
    });
    return true;
  },

  clearCacheForTab: (tabId) => {
    const currentAgents = get().agentCache;
    const currentTasks = get().teamTaskCache;
    if (!currentAgents.has(tabId) && !currentTasks.has(tabId)) return;
    const next = new Map(currentAgents);
    next.delete(tabId);
    const nextTasks = new Map(currentTasks);
    nextTasks.delete(tabId);
    set({ agentCache: next, teamTaskCache: nextTasks });
  },

  moveCache: (oldTabId, newTabId) => {
    if (oldTabId === newTabId) return;
    const currentAgents = get().agentCache;
    const currentTasks = get().teamTaskCache;
    if (!currentAgents.has(oldTabId) && !currentTasks.has(oldTabId)) return;

    const nextAgents = new Map(currentAgents);
    const oldAgents = nextAgents.get(oldTabId);
    if (oldAgents) {
      nextAgents.set(newTabId, new Map([
        ...(nextAgents.get(newTabId) ?? new Map()),
        ...oldAgents,
      ]));
      nextAgents.delete(oldTabId);
    }

    const nextTasks = new Map(currentTasks);
    const oldTasks = nextTasks.get(oldTabId);
    if (oldTasks) {
      nextTasks.set(newTabId, new Map([
        ...(nextTasks.get(newTabId) ?? new Map()),
        ...oldTasks,
      ]));
      nextTasks.delete(oldTabId);
    }
    set({ agentCache: nextAgents, teamTaskCache: nextTasks });
  },
}));

// --- Helpers ---

/** Resolve which agent a stream event belongs to based on parent_tool_use_id */
export function resolveAgentId(
  parentToolUseId: string | null | undefined,
  agents: Map<string, AgentNode>,
): string {
  if (!parentToolUseId) return 'main';
  if (agents.has(parentToolUseId)) return parentToolUseId;
  return 'main';
}

/** Compute nesting depth of an agent (main = 0, direct sub-agent = 1, etc.) */
export function getAgentDepth(
  agentId: string,
  agents: Map<string, AgentNode>,
): number {
  let depth = 0;
  let current = agents.get(agentId);
  while (current && !current.isMain && current.parentId) {
    depth++;
    current = agents.get(current.parentId);
    if (depth > 10) break; // safety guard against cycles
  }
  return depth;
}

/** Update a background tab's cached agent tree without contaminating the
 * currently visible tab. Background CLI streams continue while users switch
 * conversations, so the cache is an authority rather than a static snapshot. */
export function upsertCachedAgent(
  tabId: string,
  node: Partial<AgentNode> & { id: string },
): void {
  useAgentStore.setState((state) => {
    const caches = new Map(state.agentCache);
    const agents = new Map(caches.get(tabId) ?? []);
    const existing = agents.get(node.id);
    const merged = { ...existing, ...node } as AgentNode;
    if (node.phase && !['idle', 'completed', 'error'].includes(node.phase)) {
      merged.endTime = undefined;
    }
    agents.set(node.id, merged);
    caches.set(tabId, agents);
    return { agentCache: caches };
  });
}

export function updateCachedAgentPhase(
  tabId: string,
  id: string,
  phase: AgentPhase,
  currentTool?: string,
): void {
  useAgentStore.setState((state) => {
    const caches = new Map(state.agentCache);
    const agents = new Map(caches.get(tabId) ?? []);
    const agent = agents.get(id);
    if (!agent || agent.phase === 'completed' || agent.phase === 'error') return state;
    if (agent.phase === 'writing' && phase === 'thinking') return state;
    agents.set(id, { ...agent, phase, currentTool, endTime: undefined });
    caches.set(tabId, agents);
    return { agentCache: caches };
  });
}

export function settleCachedAgent(
  tabId: string,
  id: string,
  failed = false,
): void {
  useAgentStore.setState((state) => {
    const caches = new Map(state.agentCache);
    const agents = new Map(caches.get(tabId) ?? []);
    const agent = agents.get(id);
    if (!agent) return state;
    const phase: AgentPhase = failed
      ? 'error'
      : agent.kind === 'teammate'
        ? 'idle'
        : 'completed';
    agents.set(id, { ...agent, phase, currentTool: undefined, endTime: Date.now() });
    caches.set(tabId, agents);
    return { agentCache: caches };
  });
}

export function settleCachedTurn(tabId: string, failed: boolean, preserveTeammates: boolean): void {
  useAgentStore.setState((state) => {
    const caches = new Map(state.agentCache);
    const agents = new Map(caches.get(tabId) ?? []);
    for (const [id, agent] of agents) {
      if (agent.phase === 'completed' || agent.phase === 'error') continue;
      const phase: AgentPhase = failed
        ? 'error'
        : preserveTeammates && agent.kind === 'teammate'
          ? 'idle'
          : 'completed';
      agents.set(id, { ...agent, phase, currentTool: undefined, endTime: Date.now() });
    }
    caches.set(tabId, agents);
    return { agentCache: caches };
  });
}

export function resetCachedTurn(tabId: string, description: string, preserveTeammates: boolean): void {
  useAgentStore.setState((state) => {
    const caches = new Map(state.agentCache);
    const previous = caches.get(tabId) ?? new Map<string, AgentNode>();
    const agents = new Map<string, AgentNode>();
    if (preserveTeammates) {
      for (const [id, agent] of previous) {
        if (agent.kind === 'teammate') agents.set(id, { ...agent });
      }
    }
    agents.set('main', {
      id: 'main',
      parentId: null,
      description,
      phase: 'spawning',
      startTime: Date.now(),
      isMain: true,
      kind: 'main',
    });
    caches.set(tabId, agents);
    const taskCaches = new Map(state.teamTaskCache);
    if (!preserveTeammates) taskCaches.set(tabId, new Map());
    return { agentCache: caches, teamTaskCache: taskCaches };
  });
}

export function registerCachedTeamTask(
  tabId: string,
  toolUseId: string,
  input: Record<string, unknown>,
): void {
  useAgentStore.setState((state) => {
    const caches = new Map(state.teamTaskCache);
    const tasks = new Map(caches.get(tabId) ?? []);
    const now = Date.now();
    const id = `pending:${toolUseId}`;
    tasks.set(id, {
      id,
      toolUseId,
      subject: String(input.subject || input.description || 'Team task'),
      description: typeof input.description === 'string' ? input.description : undefined,
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
      owner: typeof input.owner === 'string' ? input.owner : undefined,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    caches.set(tabId, tasks);
    return { teamTaskCache: caches };
  });
}

export function resolveCachedTeamTask(tabId: string, toolUseId: string, resultText: string): void {
  useAgentStore.setState((state) => {
    const caches = new Map(state.teamTaskCache);
    const tasks = new Map(caches.get(tabId) ?? []);
    const entry = Array.from(tasks.values()).find((task) => task.toolUseId === toolUseId);
    const parsedId = /Task\s+#(\d+)/i.exec(resultText)?.[1];
    if (!entry || !parsedId || parsedId === entry.id) return state;
    tasks.delete(entry.id);
    tasks.set(parsedId, { ...entry, id: parsedId, updatedAt: Date.now() });
    caches.set(tabId, tasks);
    return { teamTaskCache: caches };
  });
}

export function updateCachedTeamTask(
  tabId: string,
  input: Record<string, unknown>,
): void {
  useAgentStore.setState((state) => {
    const id = String(input.taskId || input.task_id || '').trim();
    if (!id) return state;
    const caches = new Map(state.teamTaskCache);
    const tasks = new Map(caches.get(tabId) ?? []);
    const existing = tasks.get(id);
    const requested = String(input.status || '').toLowerCase();
    const status: TeamTaskStatus = requested === 'in_progress'
      ? 'in_progress'
      : requested === 'completed'
        ? 'completed'
        : requested === 'deleted'
          ? 'deleted'
          : existing?.status ?? 'pending';
    const now = Date.now();
    tasks.set(id, {
      id,
      toolUseId: existing?.toolUseId,
      subject: typeof input.subject === 'string' ? input.subject : existing?.subject ?? `Task #${id}`,
      description: typeof input.description === 'string' ? input.description : existing?.description,
      activeForm: existing?.activeForm,
      owner: typeof input.owner === 'string' ? input.owner : existing?.owner,
      status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    caches.set(tabId, tasks);
    return { teamTaskCache: caches };
  });
}
