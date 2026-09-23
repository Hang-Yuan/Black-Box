import { describe, expect, it } from 'vitest';
import {
  applyNativeGoalAttachment,
  deriveNativeGoalState,
  parseNativeGoalCommand,
} from '../native-goal';

describe('Claude native Goal projection', () => {
  it('parses set and clear commands without taking over Goal semantics', () => {
    expect(parseNativeGoalCommand('/goal ship verified release')).toEqual({
      action: 'set',
      condition: 'ship verified release',
    });
    expect(parseNativeGoalCommand('/goal clear')).toEqual({ action: 'clear' });
    expect(parseNativeGoalCommand('/goal')).toBeNull();
    expect(parseNativeGoalCommand('/compact')).toBeNull();
  });

  it('keeps failed evaluator checks active and accepts the later achieved receipt', () => {
    const setAt = '2026-09-16T16:49:33.727Z';
    const checkedAt = '2026-09-16T17:00:00.000Z';
    const achievedAt = '2026-09-16T17:13:52.326Z';
    const active = applyNativeGoalAttachment(undefined, {
      type: 'goal_status', met: false, sentinel: true, condition: 'deep simulation',
    }, setAt);
    const checked = applyNativeGoalAttachment(active, {
      type: 'goal_status', met: false, condition: 'deep simulation', reason: 'still working',
    }, checkedAt);
    const achieved = applyNativeGoalAttachment(checked, {
      type: 'goal_status', met: true, condition: 'deep simulation',
      reason: 'evidence complete', iterations: 1, durationMs: 1_458_599, tokens: 157_170,
    }, achievedAt);

    expect(checked).toMatchObject({ status: 'active', reason: 'still working' });
    expect(achieved).toMatchObject({
      status: 'achieved', condition: 'deep simulation', reason: 'evidence complete',
      iterations: 1, durationMs: 1_458_599, tokens: 157_170,
      setAt: Date.parse(setAt), updatedAt: Date.parse(achievedAt),
    });
  });

  it('distinguishes an explicit clear sentinel from evaluator achievement', () => {
    const state = deriveNativeGoalState([
      {
        timestamp: '2026-09-16T16:49:33.727Z',
        attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'task' },
      },
      {
        timestamp: '2026-09-16T16:55:00.000Z',
        attachment: { type: 'goal_status', met: true, sentinel: true, condition: 'task' },
      },
    ]);
    expect(state).toMatchObject({ status: 'cleared', condition: 'task' });
  });
});
