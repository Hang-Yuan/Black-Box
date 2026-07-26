import { create } from 'zustand';
import {
  bridge,
  type SaveWorkflowRequest,
  type WorkflowRecord,
  type WorkflowRuntimeProgress,
} from '../lib/tauri-bridge';
import { parseNativeWorkflowReceipt, type NativeWorkflowRunStatus } from '../lib/native-workflow';

export interface LiveWorkflowPhase {
  index?: number;
  title: string;
  detail?: string;
  state?: string;
}

export interface LiveWorkflowRun {
  localId: string;
  tabId: string;
  workflowName: string;
  contentDigest?: string;
  managed?: boolean;
  status: NativeWorkflowRunStatus;
  requestedAt: number;
  updatedAt: number;
  toolUseId?: string;
  taskId?: string;
  runId?: string;
  transcriptDir?: string;
  scriptPath?: string;
  summary?: string;
  error?: string;
  phases: LiveWorkflowPhase[];
}

export interface PendingWorkflowSubmission {
  workflowName: string;
  command: string;
  queuedAt: number;
}

interface WorkflowState {
  workflows: WorkflowRecord[];
  loading: boolean;
  error: string | null;
  liveRuns: Record<string, LiveWorkflowRun[]>;
  pendingSubmissions: Record<string, PendingWorkflowSubmission>;
  runsLoaded: boolean;
  fetchWorkflows: (cwd?: string) => Promise<void>;
  saveWorkflow: (request: SaveWorkflowRequest) => Promise<WorkflowRecord>;
  requestRun: (tabId: string, workflow: WorkflowRecord) => string;
  bindToolUse: (tabId: string, toolUseId: string, input: unknown) => void;
  applyToolResult: (tabId: string, toolUseId: string, result: unknown) => void;
  applyStreamEvent: (tabId: string, message: any) => void;
  applyRuntimeProgress: (tabId: string, localId: string, progress: WorkflowRuntimeProgress) => void;
  moveRuns: (oldTabId: string, newTabId: string) => void;
  queueSubmission: (tabId: string, workflowName: string, command: string) => void;
  consumeSubmission: (tabId: string) => void;
  loadRuns: () => Promise<void>;
}

const MAX_PERSISTED_WORKFLOW_RUNS = 200;
const WORKFLOW_RUN_STATUSES = new Set<NativeWorkflowRunStatus>([
  'requested', 'launching', 'running', 'interrupted', 'completed', 'failed',
]);
let runPersistenceChain = Promise.resolve();

function isLiveWorkflowRun(value: unknown): value is LiveWorkflowRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<LiveWorkflowRun>;
  return typeof run.localId === 'string'
    && typeof run.tabId === 'string'
    && typeof run.workflowName === 'string'
    && typeof run.requestedAt === 'number'
    && typeof run.updatedAt === 'number'
    && typeof run.status === 'string'
    && WORKFLOW_RUN_STATUSES.has(run.status as NativeWorkflowRunStatus)
    && Array.isArray(run.phases);
}

function pruneRunLedger(ledger: Record<string, LiveWorkflowRun[]>): Record<string, LiveWorkflowRun[]> {
  const newest = Object.values(ledger)
    .flat()
    .filter(isLiveWorkflowRun)
    .sort((left, right) => right.requestedAt - left.requestedAt)
    .slice(0, MAX_PERSISTED_WORKFLOW_RUNS);
  const pruned: Record<string, LiveWorkflowRun[]> = {};
  for (const run of newest) {
    (pruned[run.tabId] ||= []).push(run);
  }
  return pruned;
}

function normalizeRunLedger(value: unknown): Record<string, LiveWorkflowRun[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const ledger: Record<string, LiveWorkflowRun[]> = {};
  for (const [tabId, runs] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(runs)) continue;
    const valid = runs.filter(isLiveWorkflowRun).map((run) => {
      const interrupted = run.status === 'running';
      const launchFailed = run.status === 'requested' || run.status === 'launching';
      return {
        ...run,
        tabId,
        status: interrupted
          ? 'interrupted' as const
          : launchFailed
            ? 'failed' as const
            : run.status,
        ...((interrupted || launchFailed) && run.phases.length
          ? { phases: failActivePhase(run.phases) }
          : {}),
        ...(interrupted
          ? { error: run.error || 'Black Box restarted while the native Workflow was running' }
          : launchFailed
            ? { error: run.error || 'Black Box restarted before the Workflow launch was confirmed' }
            : {}),
      };
    });
    if (valid.length > 0) ledger[tabId] = valid;
  }
  return pruneRunLedger(ledger);
}

function persistRunLedger(ledger: Record<string, LiveWorkflowRun[]>): void {
  const snapshot = pruneRunLedger(ledger);
  runPersistenceChain = runPersistenceChain
    .then(() => bridge.saveWorkflowRuns(snapshot))
    .catch((error) => {
      console.error('[BLACKBOX] Failed to persist Workflow run ledger:', error);
    });
}

function runId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `workflow_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function inputName(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const name = (input as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function plannedPhases(workflow?: WorkflowRecord): LiveWorkflowPhase[] {
  return (workflow?.phases || []).map((phase, index) => ({
    index: index + 1,
    title: phase.title,
    ...(phase.detail ? { detail: phase.detail } : {}),
    state: 'pending',
  }));
}

function startFirstPendingPhase(phases: LiveWorkflowPhase[]): LiveWorkflowPhase[] {
  if (phases.some((phase) => phase.state === 'running')) return phases;
  let started = false;
  return phases.map((phase) => {
    if (!started && (!phase.state || phase.state === 'pending')) {
      started = true;
      return { ...phase, state: 'running' };
    }
    return phase;
  });
}

function completePhases(phases: LiveWorkflowPhase[]): LiveWorkflowPhase[] {
  return phases.map((phase) => ({ ...phase, state: 'completed' }));
}

function failActivePhase(phases: LiveWorkflowPhase[]): LiveWorkflowPhase[] {
  if (phases.some((phase) => phase.state === 'failed')) return phases;
  const activeIndex = phases.findIndex((phase) => phase.state === 'running');
  const pendingIndex = phases.findIndex((phase) => !phase.state || phase.state === 'pending');
  const failedIndex = activeIndex >= 0
    ? activeIndex
    : pendingIndex >= 0
      ? pendingIndex
      : Math.max(0, phases.length - 1);
  return phases.map((phase, index) => {
    if (index < failedIndex) {
      return { ...phase, state: phase.state === 'failed' ? 'failed' : 'completed' };
    }
    if (index === failedIndex) return { ...phase, state: 'failed' };
    return { ...phase, state: phase.state || 'pending' };
  });
}

function phasesFromRuntimeProgress(
  phases: LiveWorkflowPhase[],
  progress: WorkflowRuntimeProgress,
): LiveWorkflowPhase[] {
  const completed = Math.min(progress.completed, phases.length);
  const started = Math.min(Math.max(progress.started, completed), phases.length);
  const failedIndex = progress.failed > 0 ? Math.min(completed, phases.length - 1) : -1;
  return phases.map((phase, index) => {
    if (index < completed) return { ...phase, state: 'completed' };
    if (index === failedIndex) return { ...phase, state: 'failed' };
    if (index < started) return { ...phase, state: 'running' };
    return { ...phase, state: 'pending' };
  });
}

function phasesEqual(left: LiveWorkflowPhase[], right: LiveWorkflowPhase[]): boolean {
  return left.length === right.length && left.every((phase, index) => (
    phase.index === right[index]?.index
    && phase.title === right[index]?.title
    && phase.detail === right[index]?.detail
    && phase.state === right[index]?.state
  ));
}

function updateRuns(
  runs: LiveWorkflowRun[],
  predicate: (run: LiveWorkflowRun) => boolean,
  patch: Partial<LiveWorkflowRun>,
): LiveWorkflowRun[] {
  let changed = false;
  const next = runs.map((run) => {
    if (changed || !predicate(run)) return run;
    changed = true;
    return { ...run, ...patch, updatedAt: Date.now() };
  });
  return next;
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  workflows: [],
  loading: false,
  error: null,
  liveRuns: {},
  pendingSubmissions: {},
  runsLoaded: false,

  fetchWorkflows: async (cwd) => {
    set({ loading: true, error: null });
    try {
      const workflows = await bridge.listWorkflows(cwd);
      set({ workflows, loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  saveWorkflow: async (request) => {
    const workflow = await bridge.saveWorkflow(request);
    const cwd = request.cwd || undefined;
    await get().fetchWorkflows(cwd);
    return workflow;
  },

  requestRun: (tabId, workflow) => {
    const localId = runId();
    const now = Date.now();
    const requested: LiveWorkflowRun = {
      localId,
      tabId,
      workflowName: workflow.name,
      contentDigest: workflow.contentDigest,
      managed: workflow.blackBoxManaged,
      status: 'requested',
      requestedAt: now,
      updatedAt: now,
      phases: plannedPhases(workflow),
    };
    set((state) => ({
      liveRuns: pruneRunLedger({
        ...state.liveRuns,
        [tabId]: [requested, ...(state.liveRuns[tabId] || [])].slice(0, 20),
      }),
    }));
    persistRunLedger(get().liveRuns);
    return localId;
  },

  bindToolUse: (tabId, toolUseId, input) => {
    const inputWorkflowName = inputName(input);
    const name = inputWorkflowName || 'dynamic-workflow';
    set((state) => {
      const runs = state.liveRuns[tabId] || [];
      const alreadyBound = runs.find((run) => run.toolUseId === toolUseId);
      if (alreadyBound) {
        const updated = updateRuns(runs, (run) => run.toolUseId === toolUseId, {
          status: runStatusAfterRepeatedToolUse(alreadyBound.status),
          ...(inputWorkflowName ? { workflowName: inputWorkflowName } : {}),
        });
        return { liveRuns: { ...state.liveRuns, [tabId]: updated } };
      }
      const exactRequested = runs.find(
        (run) => run.status === 'requested' && run.workflowName === inputWorkflowName,
      );
      const fallbackRequested = runs.find((run) => run.status === 'requested');
      const requested = exactRequested || fallbackRequested;
      if (requested) {
        const updated = updateRuns(runs, (run) => run.localId === requested.localId, {
          toolUseId,
          status: 'launching',
          ...(inputWorkflowName ? { workflowName: inputWorkflowName } : {}),
        });
        return { liveRuns: { ...state.liveRuns, [tabId]: updated } };
      }
      const now = Date.now();
      const workflow = state.workflows.find((item) => item.name === name && item.valid);
      const discovered: LiveWorkflowRun = {
        localId: runId(),
        tabId,
        workflowName: name,
        status: 'launching',
        requestedAt: now,
        updatedAt: now,
        toolUseId,
        managed: workflow?.blackBoxManaged,
        phases: plannedPhases(workflow),
      };
      return {
        liveRuns: {
          ...state.liveRuns,
          [tabId]: [discovered, ...runs].slice(0, 20),
        },
      };
    });
    persistRunLedger(get().liveRuns);
  },

  applyToolResult: (tabId, toolUseId, result) => {
    const receipt = parseNativeWorkflowReceipt(result);
    set((state) => {
      const runs = state.liveRuns[tabId] || [];
      const target = runs.find((run) => run.toolUseId === toolUseId);
      const updated = updateRuns(runs, (run) => run.toolUseId === toolUseId, {
        status: receipt?.status || 'failed',
        ...(receipt?.workflowName ? { workflowName: receipt.workflowName } : {}),
        ...(receipt?.taskId ? { taskId: receipt.taskId } : {}),
        ...(receipt?.runId ? { runId: receipt.runId } : {}),
        ...(receipt?.transcriptDir ? { transcriptDir: receipt.transcriptDir } : {}),
        ...(receipt?.scriptPath ? { scriptPath: receipt.scriptPath } : {}),
        ...(receipt?.summary ? { summary: receipt.summary } : {}),
        ...(receipt?.status === 'running' && target?.phases.length
          ? { phases: startFirstPendingPhase(target.phases) }
          : receipt?.status === 'completed' && target?.phases.length
            ? { phases: completePhases(target.phases) }
            : (!receipt || receipt.status === 'failed') && target?.phases.length
              ? { phases: failActivePhase(target.phases) }
          : {}),
        ...(receipt?.error
          ? { error: receipt.error }
          : receipt ? {} : { error: 'Workflow tool returned no verifiable launch receipt' }),
      });
      return { liveRuns: { ...state.liveRuns, [tabId]: updated } };
    });
    persistRunLedger(get().liveRuns);
  },

  applyStreamEvent: (tabId, message) => {
    if (!message || typeof message !== 'object') return;
    const assistantBlocks = Array.isArray(message.message?.content) ? message.message.content : [];
    for (const block of assistantBlocks) {
      if (block?.type === 'tool_use' && ['Workflow', 'RunWorkflow'].includes(block.name)) {
        get().bindToolUse(tabId, block.id, block.input);
      }
    }
    const streamBlock = message.type === 'stream_event'
      && message.event?.type === 'content_block_start'
      ? message.event.content_block
      : undefined;
    if (streamBlock?.type === 'tool_use' && ['Workflow', 'RunWorkflow'].includes(streamBlock.name)) {
      get().bindToolUse(tabId, streamBlock.id, streamBlock.input);
    }
    if (message.type === 'tool_use' && ['Workflow', 'RunWorkflow'].includes(message.tool_name)) {
      get().bindToolUse(tabId, message.tool_use_id || message.id, message.input);
    }
    const toolResultText = (value: unknown): unknown => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        return value.map((item) => typeof item?.text === 'string' ? item.text : '').join('');
      }
      return value;
    };
    if (message.type === 'tool_result' && typeof message.tool_use_id === 'string') {
      get().applyToolResult(tabId, message.tool_use_id, toolResultText(message.content ?? message.output));
    }
    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          get().applyToolResult(tabId, block.tool_use_id, toolResultText(message.tool_use_result ?? block.content));
        }
      }
    }
    const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined;
    const taskId = typeof message.task_id === 'string' ? message.task_id : undefined;
    const data = message.data && typeof message.data === 'object' ? message.data : message;
    const progressType = typeof data.type === 'string' ? data.type : '';
    if (message.type === 'result' || message.type === 'process_exit') {
      set((state) => {
        const runs = state.liveRuns[tabId] || [];
        const updated = updateRuns(
          runs,
          (run) => run.status === 'requested' || run.status === 'launching',
          {
            status: 'failed',
            error: message.type === 'process_exit'
              ? 'CLI exited before the native Workflow launch was confirmed'
              : 'Claude finished without a native Workflow launch receipt',
          },
        );
        return { liveRuns: { ...state.liveRuns, [tabId]: updated } };
      });
      persistRunLedger(get().liveRuns);
      return;
    }
    set((state) => {
      const runs = state.liveRuns[tabId] || [];
      if (runs.length === 0) return state;
      const predicate = (run: LiveWorkflowRun) => Boolean(
        (toolUseId && run.toolUseId === toolUseId)
        || (taskId && run.taskId === taskId)
        || (!toolUseId && !taskId && ['workflow_phase', 'workflow_agent', 'workflow_log'].includes(progressType)
          && ['launching', 'running'].includes(run.status)),
      );
      const target = runs.find(predicate);
      let patch: Partial<LiveWorkflowRun> = {};
      if (message.subtype === 'task_started') {
        patch = {
          status: 'running',
          ...(taskId ? { taskId } : {}),
          ...(target?.phases.length ? { phases: startFirstPendingPhase(target.phases) } : {}),
        };
      } else if (message.subtype === 'task_progress') {
        patch = {
          status: 'running',
          ...(taskId ? { taskId } : {}),
          summary: typeof message.summary === 'string' ? message.summary : undefined,
        };
      } else if (message.subtype === 'task_notification') {
        const status = String(message.status || '').toLowerCase();
        const settledPhases = target?.phases.length
          ? status === 'failed'
            ? failActivePhase(target.phases)
            : completePhases(target.phases)
          : undefined;
        patch = status === 'failed'
          ? {
              status: 'failed',
              error: String(message.error || message.summary || 'Workflow failed'),
              ...(settledPhases ? { phases: settledPhases } : {}),
            }
          : {
              status: 'completed',
              summary: typeof message.summary === 'string' ? message.summary : undefined,
              ...(settledPhases ? { phases: settledPhases } : {}),
            };
      } else if (progressType === 'workflow_phase') {
        const title = typeof data.title === 'string' ? data.title : '';
        if (!title) return state;
        if (!target) return state;
        const phase: LiveWorkflowPhase = {
          index: typeof data.index === 'number' ? data.index : undefined,
          title,
          detail: typeof data.detail === 'string' ? data.detail : undefined,
          state: typeof data.state === 'string' ? data.state : 'running',
        };
        const matchingIndex = target.phases.findIndex((item) => item.title === title);
        patch = {
          status: 'running',
          phases: matchingIndex >= 0
            ? target.phases.map((item, index) => {
                if (index < matchingIndex) {
                  return { ...item, state: item.state === 'failed' ? 'failed' : 'completed' };
                }
                if (index === matchingIndex) return { ...item, ...phase };
                return item;
              })
            : [
                ...target.phases.map((item) => ({
                  ...item,
                  state: item.state === 'failed' ? 'failed' : 'completed',
                })),
                phase,
              ],
        };
      } else if (progressType === 'workflow_agent') {
        patch = { status: String(data.state || '') === 'error' ? 'failed' : 'running' };
      } else if (progressType === 'workflow_log') {
        patch = { status: 'running', summary: typeof data.message === 'string' ? data.message : undefined };
      } else {
        return state;
      }
      const updated = updateRuns(runs, predicate, patch);
      return { liveRuns: { ...state.liveRuns, [tabId]: updated } };
    });
    persistRunLedger(get().liveRuns);
  },

  applyRuntimeProgress: (tabId, localId, progress) => {
    if (!progress.available) return;
    let changed = false;
    set((state) => {
      const runs = state.liveRuns[tabId] || [];
      const target = runs.find((run) => run.localId === localId);
      if (!target
        || !target.managed
        || target.phases.length === 0
        || !['launching', 'running'].includes(target.status)) return state;
      const phases = phasesFromRuntimeProgress(target.phases, progress);
      const nextStatus = progress.failed > 0 ? 'failed' as const : 'running' as const;
      if (target.status === nextStatus && phasesEqual(target.phases, phases)) return state;
      changed = true;
      const updated = updateRuns(runs, (run) => run.localId === localId, {
        status: nextStatus,
        phases,
        ...(progress.failed > 0 ? { error: 'Native Workflow phase failed' } : {}),
      });
      return { liveRuns: { ...state.liveRuns, [tabId]: updated } };
    });
    if (changed) persistRunLedger(get().liveRuns);
  },

  moveRuns: (oldTabId, newTabId) => {
    if (!oldTabId || !newTabId || oldTabId === newTabId) return;
    set((state) => {
      const source = state.liveRuns[oldTabId] || [];
      const destination = state.liveRuns[newTabId] || [];
      const next = { ...state.liveRuns };
      if (source.length > 0) {
        next[newTabId] = [
          ...source.map((run) => ({ ...run, tabId: newTabId })),
          ...destination,
        ].slice(0, 20);
        delete next[oldTabId];
      }
      const pending = { ...state.pendingSubmissions };
      if (pending[oldTabId]) {
        pending[newTabId] = pending[oldTabId];
        delete pending[oldTabId];
      }
      return { liveRuns: pruneRunLedger(next), pendingSubmissions: pending };
    });
    persistRunLedger(get().liveRuns);
  },

  queueSubmission: (tabId, workflowName, command) => {
    set((state) => ({
      pendingSubmissions: {
        ...state.pendingSubmissions,
        [tabId]: { workflowName, command, queuedAt: Date.now() },
      },
    }));
  },

  consumeSubmission: (tabId) => {
    set((state) => {
      if (!state.pendingSubmissions[tabId]) return state;
      const next = { ...state.pendingSubmissions };
      delete next[tabId];
      return { pendingSubmissions: next };
    });
  },

  loadRuns: async () => {
    if (get().runsLoaded) return;
    try {
      const loaded = normalizeRunLedger(await bridge.loadWorkflowRuns());
      set((state) => {
        const merged: Record<string, LiveWorkflowRun[]> = { ...loaded };
        for (const [tabId, currentRuns] of Object.entries(state.liveRuns)) {
          const currentIds = new Set(currentRuns.map((run) => run.localId));
          merged[tabId] = [
            ...currentRuns,
            ...(loaded[tabId] || []).filter((run) => !currentIds.has(run.localId)),
          ].slice(0, 20);
        }
        return { liveRuns: pruneRunLedger(merged), runsLoaded: true };
      });
      persistRunLedger(get().liveRuns);
    } catch (error) {
      set({ runsLoaded: true, error: String(error) });
    }
  },
}));

function runStatusAfterRepeatedToolUse(status: NativeWorkflowRunStatus): NativeWorkflowRunStatus {
  return status === 'requested' ? 'launching' : status;
}
