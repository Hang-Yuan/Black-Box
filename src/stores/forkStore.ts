import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';

export interface ForkRecord {
  childThreadId: string;
  parentThreadId: string;
  parentTitle: string;
  cwd: string;
  createdAt: number;
  forkPoint: 'tip' | 'checkpoint';
  /** Historical forks branch immediately before this user turn. */
  checkpointUuid?: string;
  checkpointTurnIndex?: number;
  checkpointPreview?: string;
}

interface ForkState {
  forks: Record<string, ForkRecord>;
  loaded: boolean;
  /** Transient, read-only conversation shown beside the active task. */
  comparisonThreadId?: string;
  loadForks: () => Promise<void>;
  createPendingFork: (
    draftId: string,
    parentThreadId: string,
    parentTitle: string,
    cwd: string,
  ) => ForkRecord;
  moveFork: (draftId: string, childThreadId: string) => void;
  registerFork: (record: ForkRecord) => void;
  removeFork: (childThreadId: string) => void;
  openComparison: (threadId: string) => void;
  closeComparison: () => void;
}

const MAX_FORK_RECORDS = 500;
const MAX_TITLE_LENGTH = 300;
const MAX_CWD_LENGTH = 4_096;
const MAX_CHECKPOINT_PREVIEW_LENGTH = 300;
let writeQueue: Promise<void> = Promise.resolve();

function normalizeString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isThreadId(value: string, allowDraft = false): boolean {
  if (allowDraft && /^draft_[A-Za-z0-9_-]+$/.test(value)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sanitizeForks(value: unknown): Record<string, ForkRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const records: ForkRecord[] = [];
  for (const [childThreadId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || !isThreadId(childThreadId)) continue;
    const candidate = raw as Partial<ForkRecord>;
    const parentThreadId = normalizeString(candidate.parentThreadId, 64);
    const parentTitle = normalizeString(candidate.parentTitle, MAX_TITLE_LENGTH);
    const cwd = normalizeString(candidate.cwd, MAX_CWD_LENGTH);
    if (!isThreadId(parentThreadId) || !cwd || !Number.isFinite(candidate.createdAt)) continue;
    const checkpointUuid = normalizeString(candidate.checkpointUuid, 64);
    const checkpointTurnIndex = Number(candidate.checkpointTurnIndex);
    const isCheckpointFork = candidate.forkPoint === 'checkpoint'
      && isThreadId(checkpointUuid)
      && Number.isInteger(checkpointTurnIndex)
      && checkpointTurnIndex > 0;
    records.push({
      childThreadId,
      parentThreadId,
      parentTitle,
      cwd,
      createdAt: Number(candidate.createdAt),
      forkPoint: isCheckpointFork ? 'checkpoint' : 'tip',
      ...(isCheckpointFork ? {
        checkpointUuid,
        checkpointTurnIndex,
        checkpointPreview: normalizeString(
          candidate.checkpointPreview,
          MAX_CHECKPOINT_PREVIEW_LENGTH,
        ),
      } : {}),
    });
  }
  return Object.fromEntries(
    records
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_FORK_RECORDS)
      .map((record) => [record.childThreadId, record]),
  );
}

function trimForks(forks: Record<string, ForkRecord>): Record<string, ForkRecord> {
  return Object.fromEntries(
    Object.values(forks)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_FORK_RECORDS)
      .map((record) => [record.childThreadId, record]),
  );
}

function persist(forks: Record<string, ForkRecord>): void {
  const snapshot = JSON.parse(JSON.stringify(forks)) as Record<string, ForkRecord>;
  writeQueue = writeQueue
    .catch(() => {})
    .then(() => bridge.saveForkLineage(snapshot))
    .catch((error) => console.warn('[BLACKBOX Fork] Failed to persist lineage:', error));
}

export const useForkStore = create<ForkState>()((set, get) => ({
  forks: {},
  loaded: false,
  comparisonThreadId: undefined,

  loadForks: async () => {
    try {
      const forks = sanitizeForks(await bridge.loadForkLineage());
      set({ forks, loaded: true });
      persist(forks);
    } catch (error) {
      console.warn('[BLACKBOX Fork] Failed to load lineage:', error);
      set({ loaded: true });
    }
  },

  createPendingFork: (draftId, parentThreadId, rawParentTitle, rawCwd) => {
    if (!isThreadId(draftId, true) || !draftId.startsWith('draft_')) {
      throw new Error('Fork draft requires a valid draft thread id');
    }
    if (!isThreadId(parentThreadId)) {
      throw new Error('Fork source requires a valid Claude thread UUID');
    }
    const cwd = normalizeString(rawCwd, MAX_CWD_LENGTH);
    if (!cwd) throw new Error('Fork source requires a working directory');
    const record: ForkRecord = {
      childThreadId: draftId,
      parentThreadId,
      parentTitle: normalizeString(rawParentTitle, MAX_TITLE_LENGTH),
      cwd,
      createdAt: Date.now(),
      forkPoint: 'tip',
    };
    const forks = trimForks({ ...get().forks, [draftId]: record });
    set({ forks });
    // Pending drafts are intentionally not written to disk: they do not have a
    // durable Claude child UUID yet. moveFork publishes the lineage atomically.
    return record;
  },

  moveFork: (draftId, childThreadId) => {
    const existing = get().forks[draftId];
    if (!existing || !isThreadId(childThreadId)) return;
    const forks = { ...get().forks };
    delete forks[draftId];
    forks[childThreadId] = { ...existing, childThreadId };
    const trimmed = trimForks(forks);
    set({ forks: trimmed });
    persist(trimmed);
  },

  registerFork: (record) => {
    if (!isThreadId(record.childThreadId) || !isThreadId(record.parentThreadId)) {
      throw new Error('Fork lineage requires valid Claude thread UUIDs');
    }
    const sanitized = sanitizeForks({ [record.childThreadId]: record });
    const next = sanitized[record.childThreadId];
    if (!next) throw new Error('Fork lineage record is invalid');
    const forks = trimForks({ ...get().forks, [record.childThreadId]: next });
    set({ forks });
    persist(forks);
  },

  removeFork: (childThreadId) => {
    if (!get().forks[childThreadId]) return;
    const forks = { ...get().forks };
    delete forks[childThreadId];
    set({ forks });
    persist(forks);
  },

  openComparison: (threadId) => {
    if (!isThreadId(threadId)) throw new Error('Comparison requires a valid Claude thread UUID');
    set({ comparisonThreadId: threadId });
  },

  closeComparison: () => set({ comparisonThreadId: undefined }),
}));
