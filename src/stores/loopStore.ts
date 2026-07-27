import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { TaskActivityStatus } from '../lib/global-task-activity';

export const LOOP_LEDGER_MAX_RECORDS = 200;
export const LOOP_LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const LOOP_LEDGER_STORAGE_KEY = 'blackbox-loop-ledger';

export type LoopJobStatus = TaskActivityStatus;

/** The complete durable schema. Never add prompts, output or message data. */
export interface LoopLedgerJob {
  threadId: string;
  jobId: string;
  cron: string;
  status: LoopJobStatus;
  createdAt: number;
  updatedAt: number;
}

export interface LoopToolReceipt {
  threadId: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  resultText: string;
  occurredAt?: number;
}

interface LoopState {
  jobs: LoopLedgerJob[];
  upsertJob: (job: LoopLedgerJob) => boolean;
  setJobStatus: (threadId: string, jobId: string, status: LoopJobStatus) => void;
  removeJob: (threadId: string, jobId: string) => void;
  moveJobs: (oldThreadId: string, newThreadId: string) => void;
  pruneExpired: (now?: number) => void;
  reconcileAfterRestart: (now?: number) => void;
}

const LOOP_STATUSES = new Set<LoopJobStatus>([
  'waiting_user',
  'running',
  'queued',
  'failed',
  'completed',
  'paused',
  'resume_pending',
]);

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function boundedCron(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length <= 512 ? normalized : undefined;
}

function sanitizeLoopJob(
  value: unknown,
  now: number,
  startup: boolean,
): LoopLedgerJob | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<LoopLedgerJob>;
  const threadId = boundedString(candidate.threadId, 256);
  const jobId = boundedString(candidate.jobId, 256);
  const cron = boundedCron(candidate.cron);
  const createdAt = Number(candidate.createdAt);
  const updatedAt = Number(candidate.updatedAt);
  if (!threadId
    || !jobId
    || cron === undefined
    || !LOOP_STATUSES.has(candidate.status as LoopJobStatus)
    || !Number.isFinite(createdAt)
    || !Number.isFinite(updatedAt)
    || createdAt < 0
    || updatedAt < 0
    || now - updatedAt > LOOP_LEDGER_MAX_AGE_MS) {
    return undefined;
  }

  return {
    threadId,
    jobId,
    cron,
    status: startup && candidate.status === 'running'
      ? 'resume_pending'
      : candidate.status as LoopJobStatus,
    createdAt,
    updatedAt,
  };
}

/**
 * Bounds, expires, deduplicates and projects unknown input onto the six-field
 * durable schema. running becomes resume_pending only across a restart.
 */
export function normalizeLoopLedger(
  value: unknown,
  now = Date.now(),
  startup = false,
): LoopLedgerJob[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const jobs: LoopLedgerJob[] = [];
  for (const job of value
    .map((candidate) => sanitizeLoopJob(candidate, now, startup))
    .filter((candidate): candidate is LoopLedgerJob => Boolean(candidate))
    .sort((left, right) => right.updatedAt - left.updatedAt)) {
    const key = `${job.threadId}\u0000${job.jobId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(job);
    if (jobs.length === LOOP_LEDGER_MAX_RECORDS) break;
  }
  return jobs;
}

export function migrateLoopThreadId(
  jobs: readonly LoopLedgerJob[],
  oldThreadId: string,
  newThreadId: string,
  now = Date.now(),
): LoopLedgerJob[] {
  if (!oldThreadId || !newThreadId || oldThreadId === newThreadId) {
    return normalizeLoopLedger(jobs, now);
  }
  return normalizeLoopLedger(jobs.map((job) => (
    job.threadId === oldThreadId
      ? { ...job, threadId: newThreadId }
      : job
  )), now);
}

export const useLoopStore = create<LoopState>()(
  persist(
    (set) => ({
      jobs: [],

      upsertJob: (job) => {
        const normalized = normalizeLoopLedger([job])[0];
        if (!normalized) return false;
        set((state) => ({
          jobs: normalizeLoopLedger([normalized, ...state.jobs]),
        }));
        return true;
      },

      setJobStatus: (threadId, jobId, status) => {
        if (!LOOP_STATUSES.has(status)) return;
        const now = Date.now();
        set((state) => ({
          jobs: normalizeLoopLedger(state.jobs.map((job) => (
            job.threadId === threadId && job.jobId === jobId
              ? { ...job, status, updatedAt: now }
              : job
          )), now),
        }));
      },

      removeJob: (threadId, jobId) => set((state) => ({
        jobs: state.jobs.filter((job) => job.threadId !== threadId || job.jobId !== jobId),
      })),

      moveJobs: (oldThreadId, newThreadId) => set((state) => ({
        jobs: migrateLoopThreadId(state.jobs, oldThreadId, newThreadId),
      })),

      pruneExpired: (now = Date.now()) => set((state) => ({
        jobs: normalizeLoopLedger(state.jobs, now),
      })),

      reconcileAfterRestart: (now = Date.now()) => set((state) => ({
        jobs: normalizeLoopLedger(state.jobs, now, true),
      })),
    }),
    {
      name: LOOP_LEDGER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ jobs: normalizeLoopLedger(state.jobs) }),
      merge: (persisted, current) => ({
        ...current,
        jobs: normalizeLoopLedger(
          (persisted as { jobs?: unknown } | undefined)?.jobs,
          Date.now(),
          true,
        ),
      }),
    },
  ),
);

export function getLoopJobsForThread(threadId: string): LoopLedgerJob[] {
  return useLoopStore.getState().jobs.filter((job) => job.threadId === threadId);
}

/**
 * Project a confirmed native Cron tool receipt into the metadata-only ledger.
 * The prompt and tool output are used transiently for parsing and are never
 * persisted in the store.
 */
export function recordLoopToolReceipt(receipt: LoopToolReceipt): void {
  const { threadId, toolName, toolInput, resultText } = receipt;
  if (!threadId || !toolName) return;

  if (toolName === 'CronCreate' && toolInput?.recurring === true) {
    const jobId = resultText.match(/Scheduled(?: recurring)? job\s+([A-Za-z0-9_-]+)/i)?.[1];
    if (!jobId) return;
    const occurredAt = Number.isFinite(receipt.occurredAt)
      ? Number(receipt.occurredAt)
      : Date.now();
    useLoopStore.getState().upsertJob({
      threadId,
      jobId,
      cron: typeof toolInput.cron === 'string' ? toolInput.cron : '',
      status: 'running',
      createdAt: occurredAt,
      updatedAt: Date.now(),
    });
    return;
  }

  if (toolName === 'CronDelete' && /(cancelled|deleted|not found)/i.test(resultText)) {
    const jobId = typeof toolInput?.id === 'string' ? toolInput.id : undefined;
    if (jobId) useLoopStore.getState().removeJob(threadId, jobId);
  }
}
