import { describe, expect, it } from 'vitest';
import {
  buildInterruptedContinuationPrompt,
  unwrapInterruptedContinuationPrompt,
} from '../interrupted-continuation';

describe('interrupted continuation projection', () => {
  it('keeps the recovery envelope runtime-only', () => {
    const payload = buildInterruptedContinuationPrompt(
      '已经显示的半段回复',
      '继续检查这个问题',
    );

    expect(payload).toContain('系统注记');
    expect(payload).toContain('已经显示的半段回复');
    expect(unwrapInterruptedContinuationPrompt(payload)).toBe('继续检查这个问题');
  });

  it('leaves ordinary user text untouched', () => {
    const ordinary = '普通消息\n\n保留原始空行';
    expect(unwrapInterruptedContinuationPrompt(ordinary)).toBe(ordinary);
  });
});
