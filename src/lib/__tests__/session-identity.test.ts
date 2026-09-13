import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  saveCustomPreviews: vi.fn(async () => undefined),
  savePlans: vi.fn(async () => undefined),
  saveForkLineage: vi.fn(async () => undefined),
  loadWorkflowRuns: vi.fn(async () => ({})),
  saveWorkflowRuns: vi.fn(async () => undefined),
}));

vi.mock('../tauri-bridge', () => ({ bridge: bridgeMock }));

import { adoptCliSessionIdentity } from '../session-identity';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAgentStore } from '../../stores/agentStore';
import { usePlanStore } from '../../stores/planStore';
import { useForkStore } from '../../stores/forkStore';
import { useGroupStore } from '../../stores/groupStore';
import { useWorkflowStore } from '../../stores/workflowStore';
import { useComposerModeStore } from '../../stores/composerModeStore';
import { useLoopStore } from '../../stores/loopStore';

const draftId = 'draft_background';
const realId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const stdinId = 'desk_background';

describe('CLI session identity adoption', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    useChatStore.setState({ tabs: new Map(), sessionCache: new Map() });
    useSessionStore.setState({
      sessions: [],
      selectedSessionId: null,
      previousSessionId: null,
      runningSessions: new Set(),
      stdinToTab: {},
      customPreviews: {},
    });
    useAgentStore.setState({
      agents: new Map(),
      teamTasks: new Map(),
      agentCache: new Map(),
      teamTaskCache: new Map(),
    });
    usePlanStore.setState({ plans: {}, loaded: true });
    useForkStore.setState({ forks: {}, loaded: true });
    useGroupStore.setState({ groups: [] });
    useWorkflowStore.setState({
      workflows: [], liveRuns: {}, pendingSubmissions: {}, loading: false, error: null,
      runsLoaded: false,
    });
    useComposerModeStore.setState({ tabs: {} });
    useLoopStore.setState({ jobs: [] });
  });

  it('atomically moves every draft-scoped authority to the durable CLI UUID', () => {
    useSessionStore.getState().addDraftSession(draftId, '/tmp/project');
    useSessionStore.getState().setCustomPreview(draftId, 'Project 2');
    useSessionStore.getState().registerStdinTab(stdinId, draftId);
    useChatStore.getState().ensureTab(draftId);
    useChatStore.getState().setSessionMeta(draftId, { stdinId });
    useChatStore.getState().addMessage(draftId, {
      id: 'user-1', role: 'user', type: 'text', content: 'keep me', timestamp: 1,
    });
    const groupId = useGroupStore.getState().createGroup('/tmp/project', 'Project');
    useGroupStore.getState().addToGroup(draftId, groupId);
    usePlanStore.getState().setPlan(draftId, [{ step: 'Keep plan', status: 'pending' }]);
    useForkStore.getState().createPendingFork(draftId, parentId, 'Parent', '/tmp/project');
    useAgentStore.setState({
      agentCache: new Map([[draftId, new Map([['agent-1', {
        id: 'agent-1', parentId: null, description: 'Keep agent', phase: 'idle',
        startTime: 1, isMain: true,
      }]])]]),
      teamTaskCache: new Map([[draftId, new Map()]]),
    });
    useWorkflowStore.getState().requestRun(draftId, {
      name: 'release-review',
      description: 'Keep workflow',
      phases: [],
      path: '/tmp/release-review.js',
      scope: 'project',
      valid: true,
      contentDigest: 'abc123',
      modifiedAt: 1,
      blackBoxManaged: true,
    });
    useWorkflowStore.getState().queueSubmission(draftId, 'release-review', 'Run native workflow');
    useComposerModeStore.getState().selectTaskMode(draftId, 'workflow');
    useComposerModeStore.getState().setBusyDelivery(draftId, 'queue');
    const now = Date.now();
    useLoopStore.getState().upsertJob({
      threadId: draftId,
      jobId: 'loop-1',
      cron: '*/5 * * * *',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });

    expect(adoptCliSessionIdentity(draftId, realId, stdinId)).toBe(realId);

    const sessions = useSessionStore.getState();
    expect(sessions.selectedSessionId).toBe(realId);
    expect(sessions.getTabForStdin(stdinId)).toBe(realId);
    expect(sessions.sessions.find((session) => session.id === realId)?.cliResumeId).toBe(realId);
    expect(sessions.sessions.some((session) => session.id === draftId)).toBe(false);
    expect(localStorage.getItem('blackbox_last_session')).toBe(realId);
    expect(sessions.customPreviews[realId]).toBe('Project 2');
    expect(sessions.customPreviews[draftId]).toBeUndefined();

    expect(useChatStore.getState().getTab(draftId)).toBeUndefined();
    expect(useChatStore.getState().getTab(realId)?.messages[0]?.content).toBe('keep me');
    expect(useChatStore.getState().getTab(realId)?.sessionMeta.sessionId).toBe(realId);
    expect(usePlanStore.getState().plans[realId]?.items[0]?.step).toBe('Keep plan');
    expect(useForkStore.getState().forks[realId]?.parentThreadId).toBe(parentId);
    expect(useAgentStore.getState().agentCache.get(realId)?.has('agent-1')).toBe(true);
    expect(useAgentStore.getState().agentCache.has(draftId)).toBe(false);
    expect(useWorkflowStore.getState().liveRuns[realId]?.[0]?.workflowName).toBe('release-review');
    expect(useWorkflowStore.getState().liveRuns[draftId]).toBeUndefined();
    expect(useWorkflowStore.getState().pendingSubmissions[realId]?.workflowName).toBe('release-review');
    expect(useComposerModeStore.getState().tabs[realId]).toMatchObject({
      taskMode: 'workflow',
      busyDelivery: 'queue',
    });
    expect(useComposerModeStore.getState().tabs[draftId]).toBeUndefined();
    expect(useLoopStore.getState().jobs[0]?.threadId).toBe(realId);
    expect(useGroupStore.getState().getGroupOfSession(realId)).toBeDefined();
  });

  it('is idempotent for an already durable task', () => {
    useSessionStore.setState({
      sessions: [{
        id: realId, path: '/tmp/thread.jsonl', project: '/tmp', projectDir: '-tmp',
        modifiedAt: 1, preview: 'thread', cliResumeId: realId,
      }],
      selectedSessionId: realId,
    });
    useChatStore.getState().ensureTab(realId);

    expect(adoptCliSessionIdentity(realId, realId, stdinId)).toBe(realId);
    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(useChatStore.getState().getTab(realId)?.sessionMeta.sessionId).toBe(realId);
  });
});
