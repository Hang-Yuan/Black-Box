import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import {
  hasResumableConversationEvidence,
  shouldAttemptDurableResume,
} from '../resume-evidence';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    type: 'text',
    content: '',
    timestamp: 1,
    ...overrides,
  };
}

describe('durable resume evidence', () => {
  it('treats a tool-only assistant turn as accepted conversation evidence', () => {
    expect(hasResumableConversationEvidence([
      message({ type: 'tool_use', toolName: 'Write', toolInput: { file_path: 'a.txt' } }),
    ])).toBe(true);
  });

  it('does not mistake local system UI messages or empty thinking for a model turn', () => {
    expect(hasResumableConversationEvidence([
      message({ role: 'system', content: 'local notice' }),
      message({ type: 'thinking', content: '' }),
    ])).toBe(false);
  });

  it('uses the durable JSONL path when compact metadata is hidden from presentation', () => {
    expect(shouldAttemptDurableResume({
      messages: [],
      sessionPath: '/safe/.claude/projects/project/thread.jsonl',
    })).toBe(true);
  });

  it('uses live stream acceptance when a JSONL has not appeared yet', () => {
    expect(shouldAttemptDurableResume({
      messages: [message({ role: 'user', content: 'pending' })],
      turnAcceptedForResume: true,
    })).toBe(true);
  });

  it('does not resume a brand-new draft without disk or assistant evidence', () => {
    expect(shouldAttemptDurableResume({
      messages: [message({ role: 'user', content: 'first prompt' })],
      sessionPath: '',
    })).toBe(false);
  });
});
