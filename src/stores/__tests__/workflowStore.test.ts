import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  listWorkflows: vi.fn(async () => []),
  saveWorkflow: vi.fn(),
  loadWorkflowRuns: vi.fn(async () => ({})),
  saveWorkflowRuns: vi.fn(async () => undefined),
}));

vi.mock('../../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import { useWorkflowStore } from '../workflowStore';
import type { WorkflowRecord } from '../../lib/tauri-bridge';

const workflow: WorkflowRecord = {
  name: 'blackbox-ui-smoke',
  title: 'Black Box UI Smoke',
  description: 'Verify a real Workflow',
  phases: [
    { title: 'Collect', detail: 'Reading inputs', prompt: 'Read inputs' },
    { title: 'Synthesize', detail: 'Writing result', prompt: 'Return OK' },
  ],
  path: '/tmp/.claude/workflows/blackbox-ui-smoke.js',
  scope: 'project',
  valid: true,
  contentDigest: 'abc123',
  modifiedAt: 1,
  blackBoxManaged: true,
};

describe('native workflow runtime ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMock.loadWorkflowRuns.mockResolvedValue({});
    useWorkflowStore.setState({
      workflows: [],
      loading: false,
      error: null,
      liveRuns: {},
      pendingSubmissions: {},
      runsLoaded: false,
    });
  });

  it('binds partial and complete streamed tool input to one requested run', () => {
    const store = useWorkflowStore.getState();
    const localId = store.requestRun('draft_1', workflow);
    store.bindToolUse('draft_1', 'toolu_1', {});
    store.bindToolUse('draft_1', 'toolu_1', { name: 'blackbox-ui-smoke' });

    const runs = useWorkflowStore.getState().liveRuns.draft_1;
    expect(runs).toHaveLength(1);
    expect(runs[0].localId).toBe(localId);
    expect(runs[0].workflowName).toBe('blackbox-ui-smoke');
    expect(runs[0].toolUseId).toBe('toolu_1');
    expect(runs[0].status).toBe('launching');
    expect(runs[0].phases).toMatchObject([
      { index: 1, title: 'Collect', state: 'pending' },
      { index: 2, title: 'Synthesize', state: 'pending' },
    ]);
  });

  it('records the real launch receipt and native task completion', () => {
    const store = useWorkflowStore.getState();
    store.requestRun('thread_1', workflow);
    store.bindToolUse('thread_1', 'toolu_1', { name: 'blackbox-ui-smoke' });
    store.applyToolResult('thread_1', 'toolu_1', [
      'Workflow launched in background. Task ID: task-native-1',
      'Summary: Verify a real Workflow',
      'Transcript dir: /tmp/wf/transcript',
      'Script file: /tmp/wf/script.js',
      'Run ID: wf_native-1',
    ].join('\n'));
    store.applyStreamEvent('thread_1', {
      type: 'system',
      subtype: 'task_started',
      tool_use_id: 'toolu_1',
      task_id: 'task-native-1',
    });
    let [run] = useWorkflowStore.getState().liveRuns.thread_1;
    expect(run.phases).toMatchObject([
      { title: 'Collect', state: 'running' },
      { title: 'Synthesize', state: 'pending' },
    ]);
    store.applyStreamEvent('thread_1', {
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'toolu_1',
      task_id: 'task-native-1',
      status: 'completed',
      summary: 'Native Workflow completed',
    });

    [run] = useWorkflowStore.getState().liveRuns.thread_1;
    expect(run.status).toBe('completed');
    expect(run.taskId).toBe('task-native-1');
    expect(run.runId).toBe('wf_native-1');
    expect(run.scriptPath).toBe('/tmp/wf/script.js');
    expect(run.summary).toBe('Native Workflow completed');
    expect(run.phases.every((phase) => phase.state === 'completed')).toBe(true);
  });

  it('advances phase markers and settles them with the native task', () => {
    const store = useWorkflowStore.getState();
    store.requestRun('thread_phases', workflow);
    store.bindToolUse('thread_phases', 'toolu_phases', { name: 'blackbox-ui-smoke' });
    store.applyToolResult('thread_phases', 'toolu_phases', [
      'Workflow launched in background. Task ID: task-phases',
      'Run ID: wf_phases',
    ].join('\n'));
    store.applyStreamEvent('thread_phases', {
      data: { type: 'workflow_phase', index: 1, title: 'Collect', detail: 'Reading inputs' },
      tool_use_id: 'toolu_phases',
    });
    store.applyStreamEvent('thread_phases', {
      data: { type: 'workflow_phase', index: 2, title: 'Synthesize', detail: 'Writing result' },
      tool_use_id: 'toolu_phases',
    });

    let [run] = useWorkflowStore.getState().liveRuns.thread_phases;
    expect(run.phases).toMatchObject([
      { title: 'Collect', state: 'completed' },
      { title: 'Synthesize', state: 'running' },
    ]);

    store.applyStreamEvent('thread_phases', {
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'toolu_phases',
      task_id: 'task-phases',
      status: 'completed',
      summary: 'All phases complete',
    });
    [run] = useWorkflowStore.getState().liveRuns.thread_phases;
    expect(run.status).toBe('completed');
    expect(run.phases.every((phase) => phase.state === 'completed')).toBe(true);
  });

  it('uses the managed native journal counts to advance the visible current phase', () => {
    const store = useWorkflowStore.getState();
    const localId = store.requestRun('thread_runtime', workflow);
    store.bindToolUse('thread_runtime', 'toolu_runtime', { name: 'blackbox-ui-smoke' });
    store.applyToolResult('thread_runtime', 'toolu_runtime', [
      'Workflow launched in background. Task ID: task-runtime',
      'Transcript dir: /tmp/wf/runtime',
      'Run ID: wf_runtime',
    ].join('\n'));
    store.applyRuntimeProgress('thread_runtime', localId, {
      available: true,
      started: 2,
      completed: 1,
      failed: 0,
      journalUpdatedAt: 10,
    });

    const [run] = useWorkflowStore.getState().liveRuns.thread_runtime;
    expect(run.status).toBe('running');
    expect(run.phases).toMatchObject([
      { title: 'Collect', state: 'completed' },
      { title: 'Synthesize', state: 'running' },
    ]);
  });

  it('marks the active phase failed without claiming future phases completed', () => {
    const store = useWorkflowStore.getState();
    store.requestRun('thread_failed', workflow);
    store.bindToolUse('thread_failed', 'toolu_failed', { name: 'blackbox-ui-smoke' });
    store.applyToolResult('thread_failed', 'toolu_failed', [
      'Workflow launched in background. Task ID: task-failed',
      'Run ID: wf_failed',
    ].join('\n'));
    store.applyStreamEvent('thread_failed', {
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'toolu_failed',
      task_id: 'task-failed',
      status: 'failed',
      summary: 'Native phase failed',
    });

    const [run] = useWorkflowStore.getState().liveRuns.thread_failed;
    expect(run.status).toBe('failed');
    expect(run.phases).toMatchObject([
      { title: 'Collect', state: 'failed' },
      { title: 'Synthesize', state: 'pending' },
    ]);
  });

  it('restores completed receipts and marks only in-flight runs interrupted', async () => {
    bridgeMock.loadWorkflowRuns.mockResolvedValue({
      completed_thread: [{
        localId: 'done-1', tabId: 'completed_thread', workflowName: 'done',
        status: 'completed', requestedAt: 1, updatedAt: 2, phases: [],
      }],
      running_thread: [{
        localId: 'run-1', tabId: 'running_thread', workflowName: 'running',
        status: 'running', requestedAt: 3, updatedAt: 4, phases: [],
      }],
    });

    await useWorkflowStore.getState().loadRuns();

    expect(useWorkflowStore.getState().liveRuns.completed_thread[0].status).toBe('completed');
    expect(useWorkflowStore.getState().liveRuns.running_thread[0].status).toBe('interrupted');
    expect(useWorkflowStore.getState().runsLoaded).toBe(true);
    expect(bridgeMock.saveWorkflowRuns).toHaveBeenCalled();
  });
});
