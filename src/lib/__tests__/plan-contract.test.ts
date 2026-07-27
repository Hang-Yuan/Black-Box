import { describe, expect, it } from 'vitest';
import {
  extractPlanItems,
  getPlanProgress,
  normalizePlanItems,
} from '../plan-contract';

describe('persistent Plan contract', () => {
  it('normalizes Claude TodoWrite and native Task item shapes', () => {
    expect(normalizePlanItems([
      { content: 'Inspect the bug', activeForm: 'Inspecting the bug', status: 'in_progress' },
      { step: 'Fix the bug', status: 'pending' },
    ])).toEqual([
      { step: 'Inspect the bug', activeForm: 'Inspecting the bug', status: 'in_progress' },
      { step: 'Fix the bug', status: 'pending' },
    ]);
  });

  it('accepts parallel native tasks and fail-closes invalid states', () => {
    expect(() => normalizePlanItems([])).toThrow(RangeError);
    expect(() => normalizePlanItems([{ step: 'x', status: 'unknown' }])).toThrow(RangeError);
    expect(normalizePlanItems([
      { step: 'one', status: 'in_progress' },
      { step: 'two', status: 'in_progress' },
    ])).toHaveLength(2);
  });

  it('turns an approved numbered Markdown plan into executable state', () => {
    expect(extractPlanItems('# Plan\n\n1. Inspect\n2) Implement\n- ignored')).toEqual([
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Implement', status: 'pending' },
    ]);
  });

  it('derives progress without mutating the plan', () => {
    const items = normalizePlanItems([
      { step: 'done', status: 'completed' },
      { step: 'working', status: 'in_progress' },
      { step: 'later', status: 'pending' },
    ]);
    expect(getPlanProgress(items)).toMatchObject({ completed: 1, total: 3, inProgress: { step: 'working' } });
  });
});
