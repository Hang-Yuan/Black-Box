import { describe, expect, it } from 'vitest';
import {
  isGenericContextGreeting,
  isGreetingOnlyPrompt,
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
});
