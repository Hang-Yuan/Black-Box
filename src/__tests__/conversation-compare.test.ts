import { describe, expect, it } from 'vitest';
import {
  buildConversationTurnKeys,
  resolveComparisonAlignment,
} from '../lib/conversation-compare';

describe('conversation comparison turn alignment', () => {
  it('assigns assistant and tool output to the preceding user turn', () => {
    expect(buildConversationTurnKeys([
      { id: 'u1', role: 'user', checkpointUuid: 'turn-1' },
      { id: 'a1', role: 'assistant' },
      { id: 'tool-1', role: 'assistant' },
      { id: 'u2', role: 'user', checkpointUuid: 'turn-2' },
      { id: 'a2', role: 'assistant' },
    ])).toEqual(['turn-1', 'turn-1', 'turn-1', 'turn-2', 'turn-2']);
  });

  it('opens the comparison at the currently visible shared turn', () => {
    expect(resolveComparisonAlignment(
      'turn-2',
      ['turn-1', 'turn-1', 'turn-2', 'turn-2'],
      ['turn-1', 'turn-1', 'turn-2', 'turn-2'],
    )).toEqual({ mode: 'exact', turnKey: 'turn-2' });
  });

  it('falls back to the final shared turn after the branch diverges', () => {
    expect(resolveComparisonAlignment(
      'branch-turn',
      ['turn-1', 'turn-2', 'branch-turn'],
      ['turn-1', 'turn-2', 'parent-turn'],
    )).toEqual({ mode: 'last-shared', turnKey: 'turn-2' });
  });

  it('uses the bottom when unrelated conversations have no shared turn', () => {
    expect(resolveComparisonAlignment(
      'left-turn',
      ['left-turn'],
      ['right-turn'],
    )).toEqual({ mode: 'bottom' });
  });
});
