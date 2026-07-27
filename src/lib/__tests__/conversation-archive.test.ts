import { describe, expect, it } from 'vitest';
import {
  filterSessionsForConversationView,
  groupsForConversationView,
  toggleArchivedSession,
} from '../conversation-archive';
import type { SessionListItem } from '../tauri-bridge';
import type { SessionGroup } from '../../stores/groupStore';

const session = (id: string): SessionListItem => ({
  id,
  project: '/repo',
  projectDir: '/repo',
  preview: id,
  modifiedAt: 1,
  path: `/repo/${id}.jsonl`,
  cliResumeId: id,
});

describe('conversation archive view', () => {
  it('partitions active and archived sessions without duplicating either side', () => {
    const sessions = [session('active'), session('archived')];
    const archived = new Set(['archived']);
    expect(filterSessionsForConversationView(sessions, archived, 'active').map((s) => s.id))
      .toEqual(['active']);
    expect(filterSessionsForConversationView(sessions, archived, 'archived').map((s) => s.id))
      .toEqual(['archived']);
  });

  it('retains original task-group identity but omits unrelated empty groups in archive', () => {
    const groups: SessionGroup[] = [
      { id: 'g1', label: 'Research', workspace: '/repo', sessionIds: ['archived'], pinnedInGroup: [] },
      { id: 'g2', label: 'Build', workspace: '/repo', sessionIds: ['active'], pinnedInGroup: [] },
    ];
    expect(groupsForConversationView(groups, [session('archived')], 'archived').map((g) => g.id))
      .toEqual(['g1']);
    expect(groupsForConversationView(groups, [session('active')], 'active').map((g) => g.id))
      .toEqual(['g1', 'g2']);
  });

  it('preserves original group and member order in the archive projection', () => {
    const groups: SessionGroup[] = [
      {
        id: 'g2',
        label: 'Second',
        workspace: '/repo',
        sessionIds: ['archived-b', 'archived-a'],
        pinnedInGroup: ['archived-b'],
      },
      {
        id: 'g1',
        label: 'First',
        workspace: '/repo',
        sessionIds: ['archived-c'],
        pinnedInGroup: [],
      },
    ];
    const projected = groupsForConversationView(
      groups,
      [session('archived-a'), session('archived-b'), session('archived-c')],
      'archived',
    );
    expect(projected.map((group) => group.id)).toEqual(['g2', 'g1']);
    expect(projected[0].sessionIds).toEqual(['archived-b', 'archived-a']);
    expect(projected[0].pinnedInGroup).toEqual(['archived-b']);
  });

  it('archives and restores the same id idempotently through a Set', () => {
    const archived = toggleArchivedSession(new Set<string>(), 'thread-1');
    expect([...archived]).toEqual(['thread-1']);
    expect([...toggleArchivedSession(archived, 'thread-1')]).toEqual([]);
  });
});
