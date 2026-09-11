import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeSessionTimestamp, parseSessionMessages } from '../session-loader';
import { useChatStore } from '../../stores/chatStore';
import { __streamThinkingTesting } from '../../hooks/useStreamProcessor';
import { buildInterruptedContinuationPrompt } from '../interrupted-continuation';

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

  it('projects only user-authored text from interrupted continuation payloads', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        uuid: 'cli-placeholder',
        timestamp: 1,
        message: { content: [{ type: 'text', text: 'No response requested.' }] },
      },
      {
        type: 'user',
        uuid: 'cli-interruption-placeholder',
        timestamp: 1,
        message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      },
      {
        type: 'user',
        uuid: 'continued-user',
        timestamp: 2,
        message: {
          content: [{
            type: 'text',
            text: buildInterruptedContinuationPrompt(
              '这是一段已经显示过的未完成正文。',
              '那现在的情况是什么？',
            ),
          }],
        },
      },
    ]);

    expect(loaded.messages).toEqual([
      expect.objectContaining({
        id: 'continued-user',
        role: 'user',
        content: '那现在的情况是什么？',
      }),
    ]);
    expect(loaded.messages[0].content).not.toContain('系统注记');
    expect(loaded.messages[0].content).not.toContain('已输出正文');
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

  it('merges split SDK wrapper records by logical assistant message id', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        uuid: 'thinking-wrapper',
        timestamp: 1,
        message: {
          id: 'logical-message',
          content: [{ type: 'thinking', thinking: 'internal draft' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'text-wrapper',
        timestamp: 2,
        message: {
          id: 'logical-message',
          content: [{ type: 'text', text: 'final answer' }],
        },
      },
    ]);

    expect(loaded.messages).toEqual([
      expect.objectContaining({
        id: 'logical-message__thinking_committed',
        type: 'thinking',
        content: 'internal draft',
      }),
      expect.objectContaining({
        id: 'logical-message_text_0',
        type: 'text',
        content: 'final answer',
      }),
    ]);
  });

  it('coalesces replayed thinking wrappers into one historical row', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        uuid: 'thinking-wrapper-1',
        timestamp: 1,
        message: {
          id: 'logical-thinking',
          content: [{ type: 'thinking', thinking: 'first half' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'thinking-wrapper-2',
        timestamp: 2,
        message: {
          id: 'logical-thinking',
          content: [{ type: 'thinking', thinking: 'first half second half' }],
        },
      },
    ]);

    expect(loaded.messages).toEqual([
      expect.objectContaining({
        id: 'logical-thinking__thinking_committed',
        type: 'thinking',
        content: 'first half second half',
      }),
    ]);
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

  it('restores named teammates while keeping raw task notifications out of chat', () => {
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
    expect(loaded.messages).toHaveLength(1);
  });

  it('restores an unresolved async Agent as interrupted when disk hydration has no live runtime', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [{
            type: 'tool_use',
            id: 'agent-launch-tool',
            name: 'Agent',
            input: { description: 'Inspect background state' },
          }],
        },
      },
      {
        type: 'user',
        timestamp: 2,
        toolUseResult: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'stable-task-id',
          description: 'Inspect background state',
        },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'agent-launch-tool', content: '' }],
        },
      },
    ]);

    expect(loaded.agents).toContainEqual(expect.objectContaining({
      id: 'agent-launch-tool',
      taskId: 'stable-task-id',
      phase: 'interrupted',
      background: true,
      endTime: expect.any(Number),
    }));
  });

  it('settles a reloaded async Agent by task id when a resumed tool-use id differs', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [{
            type: 'tool_use',
            id: 'agent-launch-tool',
            name: 'Agent',
            input: { description: 'Inspect background state' },
          }],
        },
      },
      {
        type: 'user',
        timestamp: 2,
        toolUseResult: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'stable-task-id',
        },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'agent-launch-tool', content: '' }],
        },
      },
      {
        type: 'user',
        timestamp: 3,
        message: {
          content: `<task-notification>
            <task-id>stable-task-id</task-id>
            <tool-use-id>resumed-tool-id</tool-use-id>
            <status>completed</status>
          </task-notification>`,
        },
      },
    ]);

    expect(loaded.agents).toContainEqual(expect.objectContaining({
      id: 'agent-launch-tool',
      taskId: 'stable-task-id',
      phase: 'completed',
      background: true,
      endTime: 3,
    }));
  });

  it('restores forwarded subagent progress into its optional process history', () => {
    const loaded = parseSessionMessages([
      {
        type: 'assistant',
        timestamp: 1,
        message: {
          content: [{
            type: 'tool_use',
            id: 'agent-tool',
            name: 'Agent',
            input: { description: 'Inspect the runtime' },
          }],
        },
      },
      {
        type: 'assistant',
        timestamp: 2,
        parent_tool_use_id: 'agent-tool',
        message: {
          id: 'forwarded-one',
          content: [
            { type: 'text', text: 'Checking the event route.' },
            { type: 'tool_use', id: 'read-tool', name: 'Read', input: {} },
          ],
        },
      },
    ]);

    expect(loaded.messages.some((message) => message.content.includes('Checking the event route.'))).toBe(false);
    expect(loaded.agents.find((agent) => agent.id === 'agent-tool')?.activity).toEqual([
      expect.objectContaining({ kind: 'text', content: 'Checking the event route.' }),
      expect.objectContaining({ kind: 'tool', toolName: 'Read' }),
    ]);
  });

  it('preserves a native end-turn report boundary and hides its scheduler directive', () => {
    const loaded = parseSessionMessages([{
      type: 'assistant',
      timestamp: 10,
      message: {
        id: 'scheduled-final',
        stop_reason: 'end_turn',
        content: [{
          type: 'text',
          text: 'The durable transaction committed.\n::automation-needs-attention{title="Review" summary="Choose one option"}',
        }],
      },
    }]);

    expect(loaded.messages).toEqual([
      expect.objectContaining({
        id: 'scheduled-final_text_0',
        content: 'The durable transaction committed.',
        isFinalResponse: true,
      }),
    ]);
  });
});

describe('background assistant finalization', () => {
  beforeEach(() => {
    useChatStore.setState({ tabs: new Map(), sessionCache: new Map() });
  });

  it('commits background thinking once before clearing stream state', () => {
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
