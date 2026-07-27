export const MAX_PLAN_ITEMS = 100;
export const MAX_PLAN_STEP_LENGTH = 1_000;
export const MAX_PLAN_EXPLANATION_LENGTH = 4_000;

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

export interface PersistentPlanItem {
  step: string;
  status: PlanItemStatus;
  activeForm?: string;
}

const PLAN_STATUSES = new Set<PlanItemStatus>(['pending', 'in_progress', 'completed']);

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Normalize either Codex-style `{ step, status }` items or Claude Code's
 * TodoWrite `{ content, status, activeForm }` items into one thread Plan.
 */
export function normalizePlanItems(value: unknown): PersistentPlanItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN_ITEMS) {
    throw new RangeError(`Plan must contain 1-${MAX_PLAN_ITEMS} items.`);
  }

  const items = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`Plan item ${index + 1} must be an object.`);
    }
    const candidate = raw as Record<string, unknown>;
    const step = normalizeText(candidate.step ?? candidate.content, MAX_PLAN_STEP_LENGTH);
    const status = candidate.status as PlanItemStatus;
    if (!step) throw new RangeError(`Plan item ${index + 1} must have a non-empty step.`);
    if (!PLAN_STATUSES.has(status)) {
      throw new RangeError(`Plan item ${index + 1} has an invalid status.`);
    }
    const activeForm = normalizeText(candidate.activeForm, MAX_PLAN_STEP_LENGTH);
    return { step, status, ...(activeForm ? { activeForm } : {}) };
  });

  return items;
}

export function normalizePlanExplanation(value: unknown): string | undefined {
  const explanation = normalizeText(value, MAX_PLAN_EXPLANATION_LENGTH);
  return explanation || undefined;
}

/** Convert an approved numbered Markdown plan into executable Plan state. */
export function extractPlanItems(markdown: string): PersistentPlanItem[] {
  const steps = markdown
    .split('\n')
    .map((line) => line.match(/^\s*\d+[.)]\s+(.+?)\s*$/)?.[1])
    .filter((step): step is string => Boolean(step))
    .slice(0, MAX_PLAN_ITEMS);

  return steps.map<PersistentPlanItem>((step, index) => ({
    step: normalizeText(step, MAX_PLAN_STEP_LENGTH),
    status: index === 0 ? 'in_progress' : 'pending',
  })).filter((item) => item.step);
}

export function getPlanProgress(items: PersistentPlanItem[]): {
  completed: number;
  total: number;
  inProgress?: PersistentPlanItem;
} {
  return {
    completed: items.filter((item) => item.status === 'completed').length,
    total: items.length,
    inProgress: items.find((item) => item.status === 'in_progress'),
  };
}
