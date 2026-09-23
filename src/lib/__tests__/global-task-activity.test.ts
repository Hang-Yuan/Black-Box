import { describe, expect, it } from 'vitest';
import {
  buildGlobalTaskActivity,
  summarizeTaskActivityStatuses,
  type GlobalTaskActivityInput,
} from '../global-task-activity';

function emptyInput(): GlobalTaskActivityInput {
  return {
    threads: [],
    plans: {},
    workflowRuns: {},
    loopJobs: [],
    automations: [],
  };
}

describe('global task activity', () => {
  it('uses the documented primary status precedence and keeps paused states independent', () => {
    expect(summarizeTaskActivityStatuses([
      'completed', 'failed', 'queued', 'running', 'waiting_user', 'paused', 'resume_pending',
    ])).toEqual({
      status: 'waiting_user',
      paused: true,
      resumePending: true,
    });
    expect(summarizeTaskActivityStatuses(['completed', 'failed'])).toMatchObject({ status: 'failed' });
    expect(summarizeTaskActivityStatuses(['paused'])).toEqual({
      status: 'paused', paused: true, resumePending: false,
    });
    expect(summarizeTaskActivityStatuses(['resume_pending'])).toEqual({
      status: 'resume_pending', paused: false, resumePending: true,
    });
  });

  it('renders one row per thread and keeps Plan, Workflow and Loop as details', () => {
    const input = emptyInput();
    input.threads = [{
      threadId: 'thread-1',
      title: 'Research task',
      updatedAt: 10,
      running: true,
      waitingFor: 'question',
    }];
    input.plans = {
      'thread-1': {
        threadId: 'thread-1',
        items: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Verify', activeForm: 'Verifying', status: 'in_progress' },
        ],
        updatedAt: 30,
      },
    };
    input.workflowRuns = {
      'thread-1': [{
        localId: 'workflow-1',
        tabId: 'thread-1',
        workflowName: 'audit',
        status: 'failed',
        updatedAt: 40,
        error: 'phase failed',
        phases: [{ state: 'completed' }, { state: 'failed' }],
      }],
    };
    input.loopJobs = [{
      threadId: 'thread-1',
      jobId: 'loop-1',
      cron: '*/5 * * * *',
      status: 'paused',
      createdAt: 5,
      updatedAt: 50,
    }];

    const snapshot = buildGlobalTaskActivity(input);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]).toMatchObject({
      threadId: 'thread-1',
      title: 'Research task',
      status: 'waiting_user',
      paused: true,
      updatedAt: 50,
    });
    expect(snapshot.threads[0].details.map((detail) => detail.kind)).toEqual([
      'plan', 'workflow', 'loop',
    ]);
    expect(snapshot.threads[0].details.find((detail) => detail.kind === 'plan')).toMatchObject({
      completed: 1,
      total: 2,
      currentStep: 'Verifying',
    });
  });

  it('keeps automations as independent rows with a redacted summary shape', () => {
    const input = emptyInput();
    input.threads = [{ threadId: 'idle-history', title: 'No task', updatedAt: 1 }];
    input.automations = [{
      id: 'auto-1',
      title: 'Nightly review',
      definitionStatus: 'ACTIVE',
      runStatus: null,
      scheduleKind: 'cron',
      activeRunId: null,
      running: false,
      unreadRuns: 0,
      nextRunAt: 200,
      lastRunAt: 100,
      updatedAt: 150,
    }];

    const snapshot = buildGlobalTaskActivity(input);
    expect(snapshot.threads).toEqual([]);
    expect(snapshot.automations).toEqual([{
      kind: 'automation',
      id: 'automation:auto-1',
      automationId: 'auto-1',
      title: 'Nightly review',
      status: 'queued',
      updatedAt: 150,
      nextRunAt: 200,
      lastRunAt: 100,
      scheduleKind: 'cron',
      activeRunId: null,
      unreadRuns: 0,
    }]);
    expect(snapshot.automations[0]).not.toHaveProperty('prompt');
    expect(snapshot.automations[0]).not.toHaveProperty('cwds');
  });

  it('keeps automation outcome status independent from unread result state', () => {
    const input = emptyInput();
    input.threads = [{
      threadId: 'thread-waiting',
      title: 'Approval needed',
      updatedAt: 10,
      running: true,
      waitingFor: 'permission',
    }];
    input.automations = [
      {
        id: 'attention', title: 'Attention', definitionStatus: 'ACTIVE',
        runStatus: 'NEEDS_ATTENTION', scheduleKind: 'cron', activeRunId: 'run-1',
        running: false, unreadRuns: 1, nextRunAt: 30, lastRunAt: 20, updatedAt: 25,
      },
      {
        id: 'succeeded', title: 'Succeeded', definitionStatus: 'ACTIVE',
        runStatus: 'SUCCEEDED', scheduleKind: 'cron', activeRunId: null,
        running: false, unreadRuns: 1, nextRunAt: 35, lastRunAt: 20, updatedAt: 24,
      },
      {
        id: 'legacy', title: 'Legacy', definitionStatus: 'ACTIVE',
        runStatus: 'PENDING_REVIEW', scheduleKind: 'cron', activeRunId: null,
        running: false, unreadRuns: 1, nextRunAt: 36, lastRunAt: 20, updatedAt: 23,
      },
      {
        id: 'recovered', title: 'Recovered', definitionStatus: 'ACTIVE',
        runStatus: 'RECOVERED', scheduleKind: 'cron', activeRunId: null,
        running: false, unreadRuns: 1, nextRunAt: 38, lastRunAt: 20, updatedAt: 22,
      },
      {
        id: 'resolved', title: 'Resolved', definitionStatus: 'ACTIVE',
        runStatus: 'RESOLVED', scheduleKind: 'cron', activeRunId: null,
        running: false, unreadRuns: 0, nextRunAt: 39, lastRunAt: 20, updatedAt: 21,
      },
      {
        id: 'failed', title: 'Failed', definitionStatus: 'ACTIVE',
        runStatus: 'FAILED', scheduleKind: 'heartbeat', activeRunId: null,
        running: false, unreadRuns: 0, nextRunAt: 40, lastRunAt: 20, updatedAt: 26,
      },
      {
        id: 'paused', title: 'Paused', definitionStatus: 'PAUSED',
        runStatus: 'CANCELLED', scheduleKind: 'cron', activeRunId: null,
        running: false, unreadRuns: 0, nextRunAt: null, lastRunAt: 20, updatedAt: 27,
      },
    ];

    const snapshot = buildGlobalTaskActivity(input);
    expect(snapshot.threads[0].status).toBe('waiting_user');
    expect(Object.fromEntries(snapshot.automations.map((row) => [row.automationId, row.status]))).toEqual({
      paused: 'paused',
      failed: 'failed',
      attention: 'waiting_user',
      succeeded: 'completed',
      legacy: 'completed',
      recovered: 'completed',
      resolved: 'completed',
    });
  });

  it('keeps activity whose thread is not present in the current session list', () => {
    const input = emptyInput();
    input.loopJobs = [{
      threadId: 'detached-thread-id',
      jobId: 'loop-2',
      cron: '0 * * * *',
      status: 'resume_pending',
      createdAt: 1,
      updatedAt: 2,
    }];
    const [row] = buildGlobalTaskActivity(input).threads;
    expect(row.threadId).toBe('detached-thread-id');
    expect(row.title).toContain('detached');
    expect(row.status).toBe('resume_pending');
  });

  it('never treats persisted Plan state alone as proof of a live process', () => {
    const input = emptyInput();
    input.threads = [{ threadId: 'idle-thread', title: 'Idle', updatedAt: 10 }];
    input.plans = {
      'idle-thread': {
        threadId: 'idle-thread', updatedAt: 12,
        items: [{ step: 'Continue later', status: 'in_progress' }],
      },
    };
    input.loopJobs = [{
      threadId: 'idle-thread', jobId: 'loop-1', cron: '*/5 * * * *',
      status: 'running', createdAt: 9, updatedAt: 13,
    }];

    const [row] = buildGlobalTaskActivity(input).threads;
    expect(row.status).toBe('resume_pending');
    expect(row.details.find((detail) => detail.kind === 'plan')?.status).toBe('resume_pending');
    expect(row.details.find((detail) => detail.kind === 'loop')?.status).toBe('resume_pending');
    expect(row.details.every((detail) => detail.status !== 'running')).toBe(true);
  });
});
