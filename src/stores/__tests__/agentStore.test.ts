import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendCachedAgentActivity,
  isAgentActive,
  registerCachedTeamTask,
  resetCachedTurn,
  resolveAgentEventId,
  resolveCachedTeamTask,
  settleCachedAgent,
  settleCachedTurn,
  updateCachedTeamTask,
  useAgentStore,
} from '../agentStore';
import type { AgentNode, TeamTask } from '../agentStore';

function resetAgents() {
  useAgentStore.setState({
    agents: new Map(),
    teamTasks: new Map(),
    agentCache: new Map(),
    teamTaskCache: new Map(),
  });
}

describe('agentStore', () => {
  beforeEach(() => {
    resetAgents();
  });

  it('uses one terminal-phase contract for every agent activity surface', () => {
    for (const phase of ['spawning', 'thinking', 'writing', 'tool'] as const) {
      expect(isAgentActive({ phase })).toBe(true);
    }
    for (const phase of ['idle', 'completed', 'interrupted', 'error'] as const) {
      expect(isAgentActive({ phase })).toBe(false);
    }
  });

  describe('completeAll is idempotent', () => {
    it('running agents move to completed; second call is a no-op', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'a1',
        parentId: null,
        description: 'main',
        phase: 'thinking',
        startTime: 1,
        isMain: true,
      });
      s.upsertAgent({
        id: 'a2',
        parentId: 'a1',
        description: 'sub',
        phase: 'writing',
        startTime: 2,
        isMain: false,
      });

      useAgentStore.getState().completeAll();
      const afterFirst = useAgentStore.getState().agents;
      expect(afterFirst.get('a1')?.phase).toBe('completed');
      expect(afterFirst.get('a2')?.phase).toBe('completed');
      const snapshotRef = afterFirst;

      useAgentStore.getState().completeAll();
      const afterSecond = useAgentStore.getState().agents;
      expect(afterSecond).toBe(snapshotRef);
    });

    it('does not re-stamp endTime on already-completed agents', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'done',
        parentId: null,
        description: 'main',
        phase: 'completed',
        startTime: 1,
        endTime: 100,
        isMain: true,
      });
      useAgentStore.getState().completeAll();
      expect(useAgentStore.getState().agents.get('done')?.endTime).toBe(100);
    });

    it('error-phase agents are preserved', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'err',
        parentId: null,
        description: 'main',
        phase: 'error',
        startTime: 1,
        isMain: true,
      });
      useAgentStore.getState().completeAll();
      expect(useAgentStore.getState().agents.get('err')?.phase).toBe('error');
    });

    it('interrupted historical agents stay terminal', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'interrupted',
        parentId: 'main',
        description: 'historical background task',
        phase: 'interrupted',
        startTime: 1,
        endTime: 100,
        isMain: false,
        background: true,
      });
      useAgentStore.getState().completeAll();
      expect(useAgentStore.getState().agents.get('interrupted')).toMatchObject({
        phase: 'interrupted',
        endTime: 100,
      });
    });

    it('settles the main turn while preserving an asynchronously launched Agent', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'main', parentId: null, description: 'main', phase: 'writing',
        startTime: 1, isMain: true, kind: 'main',
      });
      s.upsertAgent({
        id: 'agent-tool', parentId: 'main', description: 'background', phase: 'thinking',
        startTime: 2, isMain: false, kind: 'subagent', taskId: 'task-7', background: true,
      });

      useAgentStore.getState().completeAll('completed', false, true);

      expect(useAgentStore.getState().agents.get('main')?.phase).toBe('completed');
      expect(useAgentStore.getState().agents.get('agent-tool')).toMatchObject({
        phase: 'thinking', taskId: 'task-7', background: true,
      });
    });
  });

  describe('clearCacheForTab (#B9)', () => {
    it('drops cache entry for the target tab without touching others', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'a',
        parentId: null,
        description: 'A',
        phase: 'thinking',
        startTime: 1,
        isMain: true,
      });
      s.saveToCache('tab-a');
      s.clearAgents();
      s.upsertAgent({
        id: 'b',
        parentId: null,
        description: 'B',
        phase: 'thinking',
        startTime: 2,
        isMain: true,
      });
      s.saveToCache('tab-b');

      useAgentStore.getState().clearCacheForTab('tab-a');
      const cache = useAgentStore.getState().agentCache;
      expect(cache.has('tab-a')).toBe(false);
      expect(cache.has('tab-b')).toBe(true);
    });

    it('no-op when tab has no cache entry', () => {
      const before = useAgentStore.getState().agentCache;
      useAgentStore.getState().clearCacheForTab('never-existed');
      expect(useAgentStore.getState().agentCache).toBe(before);
    });

    it('fixes ghost-agent: delete+recreate with same tab id sees empty state', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'ghost',
        parentId: null,
        description: 'stale',
        phase: 'thinking',
        startTime: 1,
        isMain: true,
      });
      s.saveToCache('tab-x');

      useAgentStore.getState().clearCacheForTab('tab-x');

      const restored = useAgentStore.getState().restoreFromCache('tab-x');
      expect(restored).toBe(false);
      expect(useAgentStore.getState().agents.size).toBe(0);
    });
  });

  describe('moveCache', () => {
    it('moves draft Agent and Team caches without dropping an existing durable cache', () => {
      useAgentStore.setState({
        agentCache: new Map<string, Map<string, AgentNode>>([
          ['draft-1', new Map([['draft-agent', {
            id: 'draft-agent', parentId: null, description: 'draft', phase: 'idle',
            startTime: 1, isMain: true,
          }]])],
          ['real-1', new Map([['real-agent', {
            id: 'real-agent', parentId: null, description: 'real', phase: 'completed',
            startTime: 2, isMain: true,
          }]])],
        ]),
        teamTaskCache: new Map<string, Map<string, TeamTask>>([
          ['draft-1', new Map([['1', {
            id: '1', subject: 'Keep task', status: 'pending', createdAt: 1, updatedAt: 1,
          }]])],
        ]),
      });

      useAgentStore.getState().moveCache('draft-1', 'real-1');

      const state = useAgentStore.getState();
      expect(state.agentCache.has('draft-1')).toBe(false);
      expect(state.agentCache.get('real-1')?.has('draft-agent')).toBe(true);
      expect(state.agentCache.get('real-1')?.has('real-agent')).toBe(true);
      expect(state.teamTaskCache.has('draft-1')).toBe(false);
      expect(state.teamTaskCache.get('real-1')?.get('1')?.subject).toBe('Keep task');
    });
  });

  describe('phase monotonicity', () => {
    it('does not regress an agent from writing back to thinking', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'writer',
        parentId: null,
        description: 'main',
        phase: 'writing',
        startTime: 1,
        isMain: true,
      });

      useAgentStore.getState().updatePhase('writer', 'thinking');

      expect(useAgentStore.getState().agents.get('writer')?.phase).toBe('writing');
    });
  });

  describe('optional subagent process projection', () => {
    it('coalesces streamed text and keeps it off the main agent', () => {
      const store = useAgentStore.getState();
      store.upsertAgent({
        id: 'main', parentId: null, description: 'lead', phase: 'thinking',
        startTime: 1, isMain: true, kind: 'main',
      });
      store.upsertAgent({
        id: 'sub', parentId: 'main', description: 'reader', phase: 'thinking',
        startTime: 2, isMain: false, kind: 'subagent',
      });

      useAgentStore.getState().appendActivity('main', { kind: 'text', content: 'hidden' });
      useAgentStore.getState().appendActivity('sub', { kind: 'text', content: 'Checking ', append: true });
      useAgentStore.getState().appendActivity('sub', { kind: 'text', content: 'files', append: true });
      useAgentStore.getState().appendActivity('sub', { kind: 'tool', content: 'Read', toolName: 'Read' });

      expect(useAgentStore.getState().agents.get('main')?.activity).toBeUndefined();
      expect(useAgentStore.getState().agents.get('sub')?.activity?.map((entry) => entry.content)).toEqual([
        'Checking files',
        'Read',
      ]);
    });

    it('updates the background tab cache without contaminating the foreground tree', () => {
      useAgentStore.setState({
        agentCache: new Map([['tab-bg', new Map([['sub', {
          id: 'sub', parentId: 'main', description: 'reader', phase: 'thinking',
          startTime: 1, isMain: false, kind: 'subagent' as const,
        }]])]]),
      });

      appendCachedAgentActivity('tab-bg', 'sub', { kind: 'text', content: 'Background detail' });

      expect(useAgentStore.getState().agentCache.get('tab-bg')?.get('sub')?.activity?.[0].content)
        .toBe('Background detail');
      expect(useAgentStore.getState().agents.size).toBe(0);
    });
  });

  describe('Agent Teams lifecycle', () => {
    it('settles the lead and ordinary subagents while keeping teammates reusable', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'main', parentId: null, description: 'lead', phase: 'thinking',
        startTime: 1, isMain: true, kind: 'main',
      });
      s.upsertAgent({
        id: 'subagent', parentId: 'main', description: 'one shot', phase: 'tool',
        startTime: 2, isMain: false, kind: 'subagent',
      });
      s.upsertAgent({
        id: 'teammate', parentId: 'main', description: 'reader', phase: 'writing',
        startTime: 3, isMain: false, kind: 'teammate', name: 'reader',
      });

      useAgentStore.getState().completeAll('completed', true);

      expect(useAgentStore.getState().agents.get('main')?.phase).toBe('completed');
      expect(useAgentStore.getState().agents.get('subagent')?.phase).toBe('completed');
      expect(useAgentStore.getState().agents.get('teammate')?.phase).toBe('idle');
    });

    it('starts the next turn with the same teammates and shared tasks but no stale subagents', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'subagent', parentId: 'main', description: 'one shot', phase: 'completed',
        startTime: 1, isMain: false, kind: 'subagent',
      });
      s.upsertAgent({
        id: 'teammate', parentId: 'main', description: 'reader', phase: 'idle',
        startTime: 2, isMain: false, kind: 'teammate', name: 'reader',
      });
      s.registerTeamTask('task-create', { subject: 'Inspect A' });
      s.resolveTeamTask('task-create', 'Task #1 created successfully: Inspect A');

      useAgentStore.getState().resetForTurn('follow-up', true);

      const state = useAgentStore.getState();
      expect(state.agents.has('subagent')).toBe(false);
      expect(state.agents.get('teammate')).toMatchObject({ kind: 'teammate', name: 'reader' });
      expect(state.agents.get('main')).toMatchObject({ kind: 'main', phase: 'spawning' });
      expect(state.teamTasks.get('1')?.subject).toBe('Inspect A');
    });

    it('keeps an active background Agent when the user starts another turn', () => {
      const s = useAgentStore.getState();
      s.upsertAgent({
        id: 'agent-tool', parentId: 'main', description: 'background', phase: 'thinking',
        startTime: 1, isMain: false, kind: 'subagent', taskId: 'task-9', background: true,
      });

      useAgentStore.getState().resetForTurn('follow-up', false);

      expect(useAgentStore.getState().agents.get('agent-tool')).toMatchObject({
        phase: 'thinking', taskId: 'task-9', background: true,
      });
      expect(useAgentStore.getState().agents.get('main')?.description).toBe('follow-up');
    });

    it('correlates resumed task events through taskId when tool-use ids differ', () => {
      const agents = new Map<string, AgentNode>([['initial-tool', {
        id: 'initial-tool', parentId: 'main', description: 'background', phase: 'thinking',
        startTime: 1, isMain: false, kind: 'subagent', taskId: 'stable-task', background: true,
      }]]);

      expect(resolveAgentEventId('resumed-tool', 'stable-task', agents)).toBe('initial-tool');
    });

    it('correlates TaskCreate results and later TaskUpdate changes', () => {
      const s = useAgentStore.getState();
      s.registerTeamTask('create-7', {
        subject: 'Read alpha',
        description: 'Inspect alpha.txt',
        activeForm: 'Reading alpha',
      });
      s.resolveTeamTask('create-7', 'Task #7 created successfully: Read alpha');
      s.updateTeamTask({ taskId: '7', status: 'in_progress', owner: 'reader-alpha' });

      expect(useAgentStore.getState().teamTasks.get('7')).toMatchObject({
        subject: 'Read alpha',
        status: 'in_progress',
        owner: 'reader-alpha',
      });

      useAgentStore.getState().updateTeamTask({ task_id: '7', status: 'completed' });
      expect(useAgentStore.getState().teamTasks.get('7')?.status).toBe('completed');
    });

    it('updates background team state without contaminating the foreground maps', () => {
      registerCachedTeamTask('tab-bg', 'create-2', { subject: 'Read beta' });
      resolveCachedTeamTask('tab-bg', 'create-2', 'Task #2 created successfully: Read beta');
      updateCachedTeamTask('tab-bg', { taskId: '2', status: 'in_progress', owner: 'reader-beta' });
      useAgentStore.setState((state) => ({
        agentCache: new Map(state.agentCache).set('tab-bg', new Map([
          ['reader-tool', {
            id: 'reader-tool', parentId: 'main', description: 'reader-beta', phase: 'thinking',
            startTime: 1, isMain: false, kind: 'teammate', name: 'reader-beta',
          }],
        ])),
      }));
      settleCachedAgent('tab-bg', 'reader-tool');

      const state = useAgentStore.getState();
      expect(state.agents.size).toBe(0);
      expect(state.teamTasks.size).toBe(0);
      expect(state.teamTaskCache.get('tab-bg')?.get('2')).toMatchObject({
        status: 'in_progress', owner: 'reader-beta',
      });
      expect(state.agentCache.get('tab-bg')?.get('reader-tool')?.phase).toBe('idle');
    });

    it('clears a task-only cache entry when its tab is deleted', () => {
      registerCachedTeamTask('task-only-tab', 'create-9', { subject: 'Orphan task' });

      useAgentStore.getState().clearCacheForTab('task-only-tab');

      expect(useAgentStore.getState().teamTaskCache.has('task-only-tab')).toBe(false);
    });

    it('preserves cached background work across turn settlement and reset', () => {
      useAgentStore.setState({
        agentCache: new Map([['tab-bg', new Map<string, AgentNode>([
          ['main', {
            id: 'main', parentId: null, description: 'main', phase: 'writing',
            startTime: 1, isMain: true, kind: 'main',
          }],
          ['agent-tool', {
            id: 'agent-tool', parentId: 'main', description: 'background', phase: 'thinking',
            startTime: 2, isMain: false, kind: 'subagent', taskId: 'task-bg', background: true,
          }],
        ])]]),
      });

      settleCachedTurn('tab-bg', false, false, true);
      expect(useAgentStore.getState().agentCache.get('tab-bg')?.get('main')?.phase).toBe('completed');
      expect(useAgentStore.getState().agentCache.get('tab-bg')?.get('agent-tool')?.phase).toBe('thinking');

      resetCachedTurn('tab-bg', 'next', false);
      expect(useAgentStore.getState().agentCache.get('tab-bg')?.get('agent-tool')?.phase).toBe('thinking');
    });
  });
});
