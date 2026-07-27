import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOOP_LEDGER_MAX_AGE_MS,
  LOOP_LEDGER_MAX_RECORDS,
  LOOP_LEDGER_STORAGE_KEY,
  migrateLoopThreadId,
  normalizeLoopLedger,
  recordLoopToolReceipt,
  useLoopStore,
} from '../loopStore';

describe('loopStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useLoopStore.setState({ jobs: [] });
    vi.restoreAllMocks();
  });

  it('projects persisted input onto the six-field schema, expires old jobs and caps at 200', () => {
    const now = 1_000_000_000;
    const raw = Array.from({ length: LOOP_LEDGER_MAX_RECORDS + 5 }, (_, index) => ({
      threadId: 'thread-1',
      jobId: `job-${index}`,
      cron: '*/5 * * * *',
      status: index === 0 ? 'running' : 'queued',
      createdAt: now - index,
      updatedAt: now - index,
      prompt: 'must never persist',
      output: 'must never persist',
    }));
    raw.push({
      threadId: 'expired',
      jobId: 'expired',
      cron: '0 * * * *',
      status: 'queued',
      createdAt: now - LOOP_LEDGER_MAX_AGE_MS - 1,
      updatedAt: now - LOOP_LEDGER_MAX_AGE_MS - 1,
      prompt: 'secret',
      output: 'secret',
    });

    const jobs = normalizeLoopLedger(raw, now, true);
    expect(jobs).toHaveLength(LOOP_LEDGER_MAX_RECORDS);
    expect(jobs[0].status).toBe('resume_pending');
    expect(jobs.some((job) => job.jobId === 'expired')).toBe(false);
    expect(Object.keys(jobs[0]).sort()).toEqual([
      'createdAt', 'cron', 'jobId', 'status', 'threadId', 'updatedAt',
    ]);
  });

  it('migrates draft jobs to the durable thread id and resolves collisions by newest update', () => {
    const jobs = migrateLoopThreadId([
      {
        threadId: 'draft_1', jobId: 'same', cron: '*/5 * * * *',
        status: 'running', createdAt: 1, updatedAt: 10,
      },
      {
        threadId: 'real-1', jobId: 'same', cron: '0 * * * *',
        status: 'paused', createdAt: 2, updatedAt: 20,
      },
    ], 'draft_1', 'real-1', 30);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      threadId: 'real-1',
      jobId: 'same',
      status: 'paused',
      updatedAt: 20,
    });
  });

  it('persists only loop jobs and supports lifecycle updates without message history', () => {
    const now = Date.now();
    expect(useLoopStore.getState().upsertJob({
      threadId: 'draft_1',
      jobId: 'job-1',
      cron: '*/10 * * * *',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })).toBe(true);

    useLoopStore.getState().moveJobs('draft_1', 'thread-1');
    useLoopStore.getState().setJobStatus('thread-1', 'job-1', 'paused');
    expect(useLoopStore.getState().jobs[0]).toMatchObject({
      threadId: 'thread-1', jobId: 'job-1', status: 'paused',
    });

    const persisted = JSON.parse(localStorage.getItem(LOOP_LEDGER_STORAGE_KEY) || '{}');
    expect(Object.keys(persisted.state)).toEqual(['jobs']);
    expect(Object.keys(persisted.state.jobs[0]).sort()).toEqual([
      'createdAt', 'cron', 'jobId', 'status', 'threadId', 'updatedAt',
    ]);

    useLoopStore.getState().removeJob('thread-1', 'job-1');
    expect(useLoopStore.getState().jobs).toEqual([]);
  });

  it('turns running work into resume_pending at a restart boundary', () => {
    const now = Date.now();
    useLoopStore.setState({
      jobs: [{
        threadId: 'thread-1', jobId: 'job-1', cron: '0 * * * *',
        status: 'running', createdAt: now, updatedAt: now,
      }],
    });
    useLoopStore.getState().reconcileAfterRestart(now);
    expect(useLoopStore.getState().jobs[0].status).toBe('resume_pending');
  });

  it('records only confirmed Cron metadata and removes it on a confirmed delete', () => {
    const now = Date.now();
    recordLoopToolReceipt({
      threadId: 'thread-1',
      toolName: 'CronCreate',
      toolInput: {
        recurring: true,
        cron: '*/5 * * * *',
        prompt: 'sensitive task body',
      },
      resultText: 'Scheduled recurring job job_123',
      occurredAt: now,
    });

    expect(useLoopStore.getState().jobs).toEqual([expect.objectContaining({
      threadId: 'thread-1', jobId: 'job_123', cron: '*/5 * * * *', status: 'running',
    })]);
    expect(JSON.stringify(useLoopStore.getState().jobs)).not.toContain('sensitive task body');

    recordLoopToolReceipt({
      threadId: 'thread-1',
      toolName: 'CronDelete',
      toolInput: { id: 'job_123' },
      resultText: 'Scheduled job deleted',
    });
    expect(useLoopStore.getState().jobs).toEqual([]);
  });
});
