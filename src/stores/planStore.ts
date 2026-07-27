import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';
import {
  normalizePlanExplanation,
  normalizePlanItems,
  type PersistentPlanItem,
} from '../lib/plan-contract';

export type PlanSource = 'native_tasks' | 'todo' | 'approved_plan' | 'restored';

export interface PlanRecord {
  threadId: string;
  items: PersistentPlanItem[];
  explanation?: string;
  source: PlanSource;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface PlanState {
  plans: Record<string, PlanRecord>;
  loaded: boolean;
  loadPlans: () => Promise<void>;
  setPlan: (
    threadId: string,
    items: unknown,
    explanation?: unknown,
    source?: PlanSource,
  ) => PlanRecord;
  clearPlan: (threadId: string) => void;
  movePlan: (oldThreadId: string, newThreadId: string) => void;
}

const MAX_PLAN_RECORDS = 200;
let writeQueue: Promise<void> = Promise.resolve();

function trimPlanRecords(plans: Record<string, PlanRecord>): Record<string, PlanRecord> {
  return Object.fromEntries(
    Object.entries(plans)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_PLAN_RECORDS),
  );
}

function persist(plans: Record<string, PlanRecord>): void {
  const snapshot = JSON.parse(JSON.stringify(plans)) as Record<string, PlanRecord>;
  writeQueue = writeQueue
    .catch(() => {})
    .then(() => bridge.savePlans(snapshot))
    .catch((error) => console.warn('[BLACKBOX Plan] Failed to persist plans:', error));
}

function isPlanRecord(value: unknown): value is PlanRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PlanRecord>;
  try {
    normalizePlanItems(record.items);
  } catch {
    return false;
  }
  return typeof record.threadId === 'string'
    && ['native_tasks', 'update_plan', 'todo', 'approved_plan', 'restored'].includes(String(record.source))
    && Number.isFinite(record.createdAt)
    && Number.isFinite(record.updatedAt);
}

function sanitizeLoadedPlans(value: unknown): Record<string, PlanRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, record]) => isPlanRecord(record))
    .sort(([, a], [, b]) => (b as PlanRecord).updatedAt - (a as PlanRecord).updatedAt)
    .slice(0, MAX_PLAN_RECORDS);
  const plans: Record<string, PlanRecord> = {};
  for (const [threadId, raw] of entries) {
    const record = raw as PlanRecord;
    plans[threadId] = {
      ...record,
      threadId,
      items: normalizePlanItems(record.items),
      explanation: normalizePlanExplanation(record.explanation),
      revision: Math.max(1, Number(record.revision) || 1),
      source: String(record.source) === 'update_plan' ? 'restored' : record.source || 'restored',
    };
  }
  return plans;
}

export const usePlanStore = create<PlanState>()((set, get) => ({
  plans: {},
  loaded: false,

  loadPlans: async () => {
    try {
      const plans = sanitizeLoadedPlans(await bridge.loadPlans());
      set({ plans, loaded: true });
      persist(plans);
    } catch (error) {
      console.warn('[BLACKBOX Plan] Failed to load plans:', error);
      set({ loaded: true });
    }
  },

  setPlan: (threadId, rawItems, rawExplanation, source = 'todo') => {
    const items = normalizePlanItems(rawItems);
    const explanation = normalizePlanExplanation(rawExplanation);
    const existing = get().plans[threadId];
    if (existing
      && existing.source === source
      && existing.explanation === explanation
      && JSON.stringify(existing.items) === JSON.stringify(items)) {
      return existing;
    }
    const now = Date.now();
    const plan: PlanRecord = {
      threadId,
      items,
      explanation,
      source,
      revision: (existing?.revision || 0) + 1,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const plans = trimPlanRecords({ ...get().plans, [threadId]: plan });
    set({ plans });
    persist(plans);
    return plan;
  },

  clearPlan: (threadId) => {
    if (!get().plans[threadId]) return;
    const plans = { ...get().plans };
    delete plans[threadId];
    set({ plans });
    persist(plans);
  },

  movePlan: (oldThreadId, newThreadId) => {
    const existing = get().plans[oldThreadId];
    if (!existing || oldThreadId === newThreadId) return;
    const plans = { ...get().plans };
    delete plans[oldThreadId];
    const target = plans[newThreadId];
    const winner = target && target.updatedAt > existing.updatedAt ? target : existing;
    plans[newThreadId] = {
      ...winner,
      threadId: newThreadId,
      revision: Math.max(existing.revision, target?.revision || 0) + 1,
      updatedAt: Date.now(),
    };
    const trimmed = trimPlanRecords(plans);
    set({ plans: trimmed });
    persist(trimmed);
  },
}));
