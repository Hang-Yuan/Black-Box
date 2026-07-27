import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeSessionTimestamp, parseSessionMessages } from '../session-loader';
import { useChatStore } from '../../stores/chatStore';
import { __streamThinkingTesting } from '../../hooks/useStreamProcessor';

describe('session-loader tool result recovery', () => {
  it('rehydrates mid-loop queued_command attachments as delivered steer messages', () => {
    const loaded = parseSessionMessages([
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'change direction',
        timestamp: '2026-07-12T10:00:00.000Z',
      },
      {
        type: 'attachment',
        uuid: 'steer-attachment-1',
        timestamp: '2026-07-12T10:00:00.000Z',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: 'change direction',
          timestamp: '2026-07-12T10:00:00.000Z',
        },
      },
    ]);

    expect(loaded.messages).toEqual([
      expect.objectContaining({
        id: 'steer-attachment-1',
        role: 'user',
        content: 'change direction',
        isSteer: true,
        steerState: 'sent',
        timestamp: Date.parse('2026-07-12T10:00:00.000Z'),
      }),
    ]);
    expect(loaded.messages[0].checkpointUuid).toBeUndefined();
  });

  it('restores replayed user UUIDs as native file-checkpoint keys', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const loaded = parseSessionMessages([{
      type: 'user',
      uuid,
      timestamp: 1,
      message: { role: 'user', content: [{ type: 'text', text: 'restore me' }] },
    }]);

    expect(loaded.messages[0]).toMatchObject({
      id: uuid,
      checkpointUuid: uuid,
      role: 'user',
      content: 'restore me',
    });
  });

  it('normalizes ISO JSONL timestamps to epoch milliseconds', () => {
    const iso = '2026-07-11T17:20:30.456Z';
    expect(normalizeSessionTimestamp(iso)).toBe(Date.parse(iso));

    const loaded = parseSessionMessages([{
      type: 'user',
      uuid: 'iso-user',
      timestamp: iso,
      message: { content: [{ type: 'text', text: 'hello' }] },
    }]);

    expect(loaded.mainAgentStartTime).toBe(Date.parse(iso));
    expect(loaded.messages[0]?.timestamp).toBe(Date.parse(iso));
  });

  it('marks top-level tool_result records as completed even when output is empty', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      },
      {
        type: 'tool_result',
        timestamp: 2,
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        content: '',
      },
    ]);

    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]).toMatchObject({
      id: 'tool-1',
      type: 'tool_use',
      toolName: 'Bash',
      toolCompleted: true,
    });
    expect(loaded.messages[0].toolResultContent).toBeUndefined();
  });

  it('binds top-level tool_use_result payloads to referenced tool cards', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Read', input: { path: '/tmp/a.txt' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: 2,
        tool_use_result: {
          stdout: 'file contents',
        },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-2', content: '' },
          ],
        },
      },
    ]);

    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]).toMatchObject({
      id: 'tool-2',
      type: 'tool_use',
      toolName: 'Read',
      toolCompleted: true,
      toolResultContent: 'file contents',
    });
  });

  it('treats empty top-level tool_use_result payloads as completed tool runs', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [
            { type: 'tool_use', id: 'tool-3', name: 'Grep', input: { pattern: 'todo' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: 2,
        tool_use_result: '',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-3', content: '' },
          ],
        },
      },
    ]);

    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]).toMatchObject({
      id: 'tool-3',
      type: 'tool_use',
      toolName: 'Grep',
      toolCompleted: true,
    });
    expect(loaded.messages[0].toolResultContent).toBeUndefined();
  });

  it('falls back to the tool_result block when metadata-only toolUseResult has no text', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'cron-create-1',
              name: 'CronCreate',
              input: { cron: '*/1 * * * *', prompt: 'check status', recurring: true },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: 2,
        toolUseResult: {
          id: 'c4ffef2b',
          humanSchedule: 'Every minute',
          recurring: true,
          durable: false,
        },
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'cron-create-1',
            content: 'Scheduled recurring job c4ffef2b (Every minute). Session-only.',
          }],
        },
      },
    ]);

    expect(loaded.messages[0]).toMatchObject({
      id: 'cron-create-1',
      type: 'tool_use',
      toolName: 'CronCreate',
      toolCompleted: true,
      toolResultContent: 'Scheduled recurring job c4ffef2b (Every minute). Session-only.',
    });
  });

  it('binds top-level tool_result envelopes to the referenced tool card', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [
            { type: 'tool_use', id: 'tool-4', name: 'Glob', input: { path: 'src/**/*.ts' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: 2,
        tool_use_id: 'tool-4',
        tool_result: {
          output: 'src/lib/session-loader.ts',
        },
      },
    ]);

    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]).toMatchObject({
      id: 'tool-4',
      type: 'tool_use',
      toolName: 'Glob',
      toolCompleted: true,
      toolResultContent: 'src/lib/session-loader.ts',
    });
  });

  it('restores named teammates without exposing their internal launch metadata', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'agent-tool',
              name: 'Agent',
              input: { name: 'ui-reader', description: 'Read the marker' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: 2,
        tool_use_result: {
          output: 'agentId: a6d0a11503796be67\noutput_file: /private/tmp/claude-501/private.output',
        },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'agent-tool', content: '' }],
        },
      },
      {
        type: 'assistant',
        timestamp: 3,
        message: {
          content: [{
            type: 'text',
            text: '<task-notification id="a6d0a11503796be67">ui-reader (a6d0a11503796be67): Completed\nUseful result</task-notification>',
          }],
        },
      },
    ]);

    expect(loaded.agents).toContainEqual(expect.objectContaining({
      id: 'agent-tool',
      kind: 'teammate',
      name: 'ui-reader',
    }));
    expect(loaded.messages[0]).toMatchObject({
      id: 'agent-tool',
      toolCompleted: true,
    });
    expect(loaded.messages[0].toolResultContent).toBeUndefined();
    expect(loaded.messages[1].content).toContain('ui-reader: Completed');
    expect(loaded.messages[1].content).not.toContain('a6d0a11503796be67');
  });
});

describe('background assistant finalization', () => {
  beforeEach(() => {
    useChatStore.setState({ tabs: new Map(), sessionCache: new Map() });
  });

  it('keeps committed thinking messages when background partials are cleared', () => {
    const store = useChatStore.getState();
    store.ensureTab('bg-tab');
    store.updatePartialMessage('bg-tab', 'draft answer');
    store.updatePartialThinking('bg-tab', 'draft thought');

    const thinkingPersistence = __streamThinkingTesting.resolveThinkingPersistence(
      'msg-bg',
      [{ type: 'text', text: 'final answer' }] as any[],
      'draft thought',
    );

    __streamThinkingTesting.commitThinkingBeforeAssistantText({
      tabId: 'bg-tab',
      msgUuid: 'msg-bg',
      thinkingPersistence,
      timestamp: 123,
    });

    __streamThinkingTesting.finalizeBackgroundAssistantStreamingState({
      tabId: 'bg-tab',
      hasTextBlock: true,
      hasAskUserQuestion: false,
      shouldMaterializeThinking: true,
      thinkingPersistence,
    });

    const tab = useChatStore.getState().getTab('bg-tab');
    expect(tab?.messages).toEqual([
      expect.objectContaining({
        id: 'msg-bg__thinking_committed',
        type: 'thinking',
        content: 'draft thought',
      }),
    ]);
    expect(tab?.partialText).toBe('');
    expect(tab?.partialThinking).toBe('');
    expect(tab?.isStreaming).toBe(false);
  });
});
