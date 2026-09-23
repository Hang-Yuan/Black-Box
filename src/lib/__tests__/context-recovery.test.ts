import { describe, expect, it } from 'vitest';
import {
  assistantContentHasVisibleTerminalResponse,
  decideEmptyTerminalRecovery,
  effectiveContextInputTokens,
  EMPTY_TERMINAL_RECOVERY_LIMIT,
  EMPTY_TERMINAL_RECOVERY_PROMPT,
  isGenericContextGreeting,
  isGreetingOnlyPrompt,
  isInternalRecoveryPrompt,
  isInternalRunnerRecoveryPrompt,
  projectInternalRunnerRecovery,
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

  it('uses official Claude maxima before provider overrides and retains proxy capacities', () => {
    expect(resolveDisplayedContextWindow(200_000, 'claude-opus-5')).toBe(1_000_000);
    expect(resolveDisplayedContextWindow(200_000, 'claude-opus-5.5')).toBe(1_000_000);
    expect(resolveDisplayedContextWindow(undefined, 'claude-fable-5-1')).toBe(1_000_000);
    expect(resolveDisplayedContextWindow(undefined, 'claude-sonnet-4-6')).toBe(1_000_000);
    expect(resolveDisplayedContextWindow(1_000_000, 'claude-haiku-4-5-20251001')).toBe(200_000);
    expect(resolveDisplayedContextWindow(20_000, 'relay-small')).toBe(20_000);
    expect(resolveDisplayedContextWindow(undefined, 'relay-standard')).toBe(200_000);
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
    expect(decideEmptyTerminalRecovery({
      ...base,
      activeBackgroundAgent: true,
    })).toBe('none');
  });

  it('recognizes Claude runner restart control traffic and preserves retry state', () => {
    expect(isInternalRunnerRecoveryPrompt('Continue from where you left off.')).toBe(true);
    expect(isInternalRunnerRecoveryPrompt(
      'Continue from where you left off. Note: this session was automatically restarted after its process exited unexpectedly.',
    )).toBe(true);
    expect(isInternalRunnerRecoveryPrompt('Please continue from where you left off.')).toBe(false);
    expect(isInternalRecoveryPrompt(EMPTY_TERMINAL_RECOVERY_PROMPT)).toBe(true);
    expect(isInternalRecoveryPrompt('用户自己说继续')).toBe(false);

    expect(projectInternalRunnerRecovery({})).toEqual({
      activeTurnInput: EMPTY_TERMINAL_RECOVERY_PROMPT,
      contextRecoveryAttempts: 0,
      awaitingVisibleAssistantResponse: true,
      recoveryPhase: 'resuming',
    });
    expect(projectInternalRunnerRecovery({
      activeTurnInput: '原始用户任务',
      contextRecoveryAttempts: 2,
    })).toEqual({
      activeTurnInput: '原始用户任务',
      contextRecoveryAttempts: 2,
      awaitingVisibleAssistantResponse: true,
      recoveryPhase: 'resuming',
    });
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
