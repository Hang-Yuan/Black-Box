import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import {
  buildConversationDisplayItems,
  isFirstVisibleAssistantTextInTurn,
  processUpdatePreview,
} from '../conversation-presentation';

function message(
  id: string,
  role: ChatMessage['role'],
  type: ChatMessage['type'],
  content = '',
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, type, content, timestamp: 1, ...extra };
}

describe('conversation presentation', () => {
  it('hides forwarded subagent prose and tools from the primary transcript', () => {
    const items = buildConversationDisplayItems([
      message('u1', 'user', 'text', 'Do the work'),
      message('agent', 'assistant', 'tool_use', '', { toolName: 'Agent' }),
      message('sub-text', 'assistant', 'text', 'raw subagent report', { subAgentDepth: 1 }),
      message('sub-tool', 'assistant', 'tool_use', '', { subAgentDepth: 1, toolName: 'Read' }),
      message('final', 'assistant', 'text', 'Lead synthesis'),
    ], 'completed');

    expect(items.map((item) => item.kind === 'message' ? item.msg.id : item.kind)).toEqual([
      'u1',
      'agent',
      'final',
    ]);
  });

  it('folds repeated completed lead narration while keeping the final answer visible', () => {
    const items = buildConversationDisplayItems([
      message('u1', 'user', 'text', 'Investigate'),
      message('p1', 'assistant', 'text', 'Checking the first hypothesis.'),
      message('tool1', 'assistant', 'tool_use', '', { toolName: 'Read' }),
      message('p2', 'assistant', 'text', 'The evidence points elsewhere.'),
      message('tool2', 'assistant', 'tool_use', '', { toolName: 'Bash' }),
      message('tool3', 'assistant', 'tool_use', '', { toolName: 'Read' }),
      message('final', 'assistant', 'text', 'The fix is complete.'),
    ], 'completed');

    expect(items.map((item) => item.kind === 'message' ? item.msg.id : item.kind)).toEqual([
      'u1',
      'process_group',
      'tool_group',
      'final',
    ]);
    const group = items.find((item) => item.kind === 'process_group');
    expect(group && group.kind === 'process_group' ? group.msgs.map((msg) => msg.id) : []).toEqual(['p1', 'p2']);
    expect(group && group.kind === 'process_group' ? group.active : true).toBe(false);
  });

  it('folds active lead progress into one live-preview group', () => {
    const items = buildConversationDisplayItems([
      message('u1', 'user', 'text', 'Investigate'),
      message('p1', 'assistant', 'text', 'First check'),
      message('p2', 'assistant', 'text', 'Second check'),
    ], 'running');

    expect(items.map((item) => item.kind === 'message' ? item.msg.id : item.kind)).toEqual([
      'u1',
      'process_group',
    ]);
    const group = items.find((item) => item.kind === 'process_group');
    expect(group && group.kind === 'process_group' ? group.active : false).toBe(true);
  });

  it('keeps a native terminal report visible even before runtime status settles', () => {
    const items = buildConversationDisplayItems([
      message('p1', 'assistant', 'text', 'Checking receipts.'),
      message('p2', 'assistant', 'text', 'Writing the audit log.'),
      message('final', 'assistant', 'text', 'The transaction committed.', {
        isFinalResponse: true,
      }),
    ], 'running');

    expect(items.map((item) => item.kind === 'message' ? item.msg.id : item.kind)).toEqual([
      'process_group',
      'final',
    ]);
    expect(items.find((item) => item.kind === 'message' && item.msg.id === 'final')).toBeTruthy();
  });

  it('keeps lead progress and mechanical tool calls in separate expandable groups', () => {
    const items = buildConversationDisplayItems([
      message('u1', 'user', 'text', 'Investigate'),
      message('p1', 'assistant', 'text', 'Checking the evidence.'),
      message('tool1', 'assistant', 'tool_use', '', { toolName: 'Read' }),
      message('tool2', 'assistant', 'tool_use', '', { toolName: 'Bash' }),
      message('tool3', 'assistant', 'tool_use', '', { toolName: 'Read' }),
      message('p2', 'assistant', 'text', 'The checks passed.'),
    ], 'running');

    expect(items.map((item) => item.kind === 'message' ? item.msg.id : item.kind)).toEqual([
      'u1',
      'process_group',
      'tool_group',
    ]);
  });

  it('builds a short plain-text preview from markdown', () => {
    expect(processUpdatePreview('## **Checking** `runtime`\nmore')).toBe('Checking runtime');
  });

  it('keeps the lead avatar on the final answer after hidden process updates', () => {
    const items = buildConversationDisplayItems([
      message('u1', 'user', 'text', 'Continue after reconnect'),
      message('p1', 'assistant', 'text', 'Checking restored state.'),
      message('p2', 'assistant', 'text', 'The resumed process is healthy.'),
      message('final', 'assistant', 'text', 'Here is the answer.'),
    ], 'completed');
    const finalIndex = items.findIndex(
      (item) => item.kind === 'message' && item.msg.id === 'final',
    );

    expect(items.some((item) => item.kind === 'process_group')).toBe(true);
    expect(isFirstVisibleAssistantTextInTurn(items, finalIndex)).toBe(true);
  });
});
