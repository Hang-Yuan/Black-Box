import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import {
  buildNativeLoopCommand,
  deriveNativeLoopJobs,
  NATIVE_LOOP_MAX_AGE_MS,
  validateNativeLoopInterval,
} from '../native-loop';

function toolMessage(
  toolName: string,
  toolInput: Record<string, unknown>,
  result: string,
  timestamp: number,
): ChatMessage {
  return {
    id: `${toolName}-${timestamp}`,
    role: 'assistant',
    type: 'tool_use',
    content: '',
    toolName,
    toolInput,
    toolCompleted: true,
    toolResultContent: result,
    timestamp,
  };
}

describe('native Claude session loops', () => {
  it('derives active jobs only from successful native receipts', () => {
    const messages = [
      toolMessage('CronCreate', { cron: '*/5 * * * *', prompt: 'check deploy', recurring: true },
        'Scheduled recurring job abc12345 (Every 5 minutes).', 100),
      toolMessage('CronCreate', { cron: '*/1 * * * *', prompt: 'check build', recurring: true },
        'Scheduled recurring job def67890 (Every minute).', 200),
      toolMessage('CronDelete', { id: 'abc12345' }, 'Cancelled job abc12345.', 300),
    ];

    expect(deriveNativeLoopJobs(messages, 400)).toEqual([{
      id: 'def67890',
      cron: '*/1 * * * *',
      prompt: 'check build',
      createdAt: 200,
    }]);
  });

  it('does not claim an unconfirmed or expired loop is active', () => {
    const unconfirmed = toolMessage(
      'CronCreate',
      { cron: '*/5 * * * *', prompt: 'check deploy', recurring: true },
      'Scheduling failed.',
      100,
    );
    const confirmed = toolMessage(
      'CronCreate',
      { cron: '*/5 * * * *', prompt: 'check deploy', recurring: true },
      'Scheduled recurring job abc12345 (Every 5 minutes).',
      100,
    );

    expect(deriveNativeLoopJobs([unconfirmed], 200)).toEqual([]);
    expect(deriveNativeLoopJobs([confirmed], 100 + NATIVE_LOOP_MAX_AGE_MS + 1)).toEqual([]);
  });

  it('keeps short session cadence separate from durable Scheduled work', () => {
    expect(validateNativeLoopInterval('')).toBe('valid');
    expect(validateNativeLoopInterval('30s')).toBe('invalid');
    expect(validateNativeLoopInterval('1m')).toBe('valid');
    expect(validateNativeLoopInterval('15m')).toBe('valid');
    expect(validateNativeLoopInterval('60m')).toBe('durable');
    expect(validateNativeLoopInterval('2h')).toBe('durable');
    expect(validateNativeLoopInterval('every minute')).toBe('invalid');
    expect(buildNativeLoopCommand('5m', 'check deploy')).toBe('/loop 5m check deploy');
  });
});
