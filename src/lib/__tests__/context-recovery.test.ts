import { describe, expect, it } from 'vitest';
import {
  assistantContentHasVisibleTerminalResponse,
  decideEmptyTerminalRecovery,
  effectiveContextInputTokens,
  EMPTY_TERMINAL_RECOVERY_LIMIT,
  isGenericContextGreeting,
  isGreetingOnlyPrompt,
  resolveDisplayedContextWindow,
  shouldRetryContextDrop,
} from '../context-recovery';

describe('context-drop recovery signature', () => {
  const droppedUsage = {
    input_tokens: 10,
    output_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  it('recognizes the fixed generic greeting across punctuation variants', () => {
    expect(isGenericContextGreeting('Hi! How can I help you today?')).toBe(true);
    expect(isGenericContextGreeting('Hello, how can I help you today?')).toBe(true);
    expect(isGenericContextGreeting('I found the requested file.')).toBe(false);
  });

  it('never retries when the user actually sent a greeting', () => {
    expect(isGreetingOnlyPrompt('你好！')).toBe(true);
    expect(shouldRetryContextDrop({
      prompt: '你好！',
      response: 'Hi! How can I help you today?',
      usage: droppedUsage,
      subtype: 'success',
      attempts: 0,
    })).toBe(false);
  });

  it('retries one non-greeting turn with the observed tiny zero-cache signature', () => {
    expect(shouldRetryContextDrop({
      prompt: '我是说最新版本的 J 版本，请继续分析。',
      response: 'Hi! How can I help you today?',
      usage: droppedUsage,
      subtype: 'success',
      attempts: 0,
    })).toBe(true);
  });

  it('does not retry normal context use, failures, or a second greeting', () => {
    expect(shouldRetryContextDrop({
      prompt: '继续分析。',
      response: 'Hi! How can I help you today?',
      usage: { ...droppedUsage, cache_read_input_tokens: 90_000 },
      subtype: 'success',
      attempts: 0,
    })).toBe(false);
    expect(shouldRetryContextDrop({
      prompt: '继续分析。',
      response: 'Hi! How can I help you today?',
      usage: droppedUsage,
      subtype: 'error',
      attempts: 0,
    })).toBe(false);
    expect(shouldRetryContextDrop({
      prompt: '继续分析。',
      response: 'Hi! How can I help you today?',
      usage: droppedUsage,
      subtype: 'success',
      attempts: 1,
    })).toBe(false);
  });

  it('treats empty thinking and filtered placeholders as missing terminal output', () => {
    expect(assistantContentHasVisibleTerminalResponse([
      { type: 'thinking', thinking: '' },
    ])).toBe(false);
    expect(assistantContentHasVisibleTerminalResponse([
      { type: 'text', text: 'No response requested.' },
    ])).toBe(false);
    expect(assistantContentHasVisibleTerminalResponse([
      { type: 'text', text: 'Finished with a visible result.' },
    ])).toBe(true);
    expect(assistantContentHasVisibleTerminalResponse([
      { type: 'tool_use', name: 'Bash' },
    ])).toBe(false);
    expect(assistantContentHasVisibleTerminalResponse([
      { type: 'tool_use', name: 'AskUserQuestion' },
    ])).toBe(true);
  });

  it('counts cached input toward context pressure', () => {
    expect(effectiveContextInputTokens({
      input_tokens: 8,
      cache_creation_input_tokens: 4_622,
      cache_read_input_tokens: 148_675,
    })).toBe(153_305);
  });

  it('uses a configured provider window for occupancy instead of the model-name fallback', () => {
    expect(resolveDisplayedContextWindow(20_000, true)).toBe(20_000);
    expect(resolveDisplayedContextWindow(200_000, false)).toBe(200_000);
    expect(resolveDisplayedContextWindow(1_000_000, false)).toBe(1_000_000);
    expect(resolveDisplayedContextWindow(undefined, true)).toBe(1_000_000);
    expect(resolveDisplayedContextWindow(undefined, false)).toBe(200_000);
  });

  it('recovers empty terminal success on the same session with bounded retries', () => {
    const base = {
      subtype: 'success',
      activeTurnInput: '继续当前任务',
      awaitingVisibleAssistantResponse: true,
      resultAddsVisibleText: false,
      stdinAvailable: true,
      pendingCommand: false,
      recoveryCompactPending: false,
    } as const;
    expect(decideEmptyTerminalRecovery({
      ...base,
      attempts: 0,
    })).toBe('retry');
    expect(decideEmptyTerminalRecovery({
      ...base,
      attempts: 0,
    })).toBe('retry');
    expect(decideEmptyTerminalRecovery({
      ...base,
      attempts: EMPTY_TERMINAL_RECOVERY_LIMIT,
    })).toBe('fail');
    expect(decideEmptyTerminalRecovery({
      ...base,
      recoveryCompactPending: true,
    })).toBe('resume_after_compact');
  });

  it('does not replay completed, failed, command, or already visible turns', () => {
    const base = {
      subtype: 'success',
      activeTurnInput: '继续',
      awaitingVisibleAssistantResponse: true,
      resultAddsVisibleText: false,
      attempts: 0,
      stdinAvailable: true,
      pendingCommand: false,
      recoveryCompactPending: false,
    };
    expect(decideEmptyTerminalRecovery({ ...base, subtype: 'error' })).toBe('none');
    expect(decideEmptyTerminalRecovery({ ...base, activeTurnInput: undefined })).toBe('none');
    expect(decideEmptyTerminalRecovery({ ...base, pendingCommand: true })).toBe('none');
    expect(decideEmptyTerminalRecovery({ ...base, resultAddsVisibleText: true })).toBe('none');
    expect(decideEmptyTerminalRecovery({
      ...base,
      awaitingVisibleAssistantResponse: false,
    })).toBe('none');
  });
});
