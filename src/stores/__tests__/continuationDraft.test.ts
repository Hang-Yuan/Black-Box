import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ names: {} as Record<string, string>, groups: [] as unknown[] }));
vi.mock('../../lib/tauri-bridge', () => ({
  bridge: {
    saveCustomPreviews: vi.fn(async (names) => { disk.names = structuredClone(names); }),
    loadCustomPreviews: vi.fn(async () => structuredClone(disk.names)),
    saveSessionGroups: vi.fn(async (groups) => { disk.groups = structuredClone(groups); }),
    loadSessionGroups: vi.fn(async () => structuredClone(disk.groups)),
    listSessions: vi.fn(async () => []),
  },
}));

import { nextConversationTitle } from '../../lib/conversation-handoff';
import { useSessionStore } from '../sessionStore';
import { useGroupStore } from '../groupStore';
import { initGroupPersistence } from '../groupPersistence';

const source = {
  id: 'source', path: '/workspace/source.jsonl', project: '/workspace',
  projectDir: '-workspace', modifiedAt: 1, preview: 'Project development', cliResumeId: 'source',
};
const group = {
  id: 'group', label: 'Project', workspace: '/workspace',
  sessionIds: ['source'], pinnedInGroup: ['source'],
};

describe('continuation draft identity', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    disk.names = {};
    disk.groups = [];
    useSessionStore.setState({
      sessions: [source], selectedSessionId: source.id, previousSessionId: null,
      customPreviews: {}, runningSessions: new Set(), stdinToTab: {},
    });
    useGroupStore.setState({ groups: [group] });
  });

  it.each([
    ['项目开发', '项目开发2'],
    ['项目开发2', '项目开发3'],
    ['项目开发 9', '项目开发 10'],
    ['项目v1开发', '项目v1开发2'],
    ['项目v1开发19', '项目v1开发20'],
    ['Project 99  ', 'Project 100'],
    ['Project 9007199254740992', 'Project 9007199254740993'],
  ])('numbers %s as %s', (title, expected) => {
    expect(nextConversationTitle(title)).toBe(expected);
  });

  it('selects a named draft inside the source group from its first render', () => {
    useSessionStore.getState().setCustomPreview(source.id, '项目v1开发');
    let selectedName: string | undefined;
    let selectedGroup: string | undefined;
    const unsubscribe = useSessionStore.subscribe((state) => {
      if (state.selectedSessionId !== 'draft_next') return;
      selectedName = state.customPreviews.draft_next;
      selectedGroup = useGroupStore.getState().getGroupOfSession('draft_next')?.id;
    });
    useSessionStore.getState().addContinuationDraft('draft_next', '/workspace', source.id, 'New chat');
    unsubscribe();

    expect(selectedName).toBe('项目v1开发2');
    expect(selectedGroup).toBe(group.id);
    expect(useGroupStore.getState().groups[0]).toMatchObject({
      sessionIds: ['source', 'draft_next'], pinnedInGroup: ['source'],
    });
    expect(useSessionStore.getState().sessions.find((session) => session.id === source.id)).toEqual(source);
    expect(useSessionStore.getState().customPreviews.source).toBe('项目v1开发');
    expect(useSessionStore.getState().previousSessionId).toBe(source.id);
  });

  it('keeps an ungrouped source ungrouped and uses its visible preview', () => {
    useGroupStore.setState({ groups: [{ ...group, sessionIds: ['another'] }] });
    useSessionStore.getState().addContinuationDraft('draft_next', '/workspace', source.id, 'New chat');
    expect(useSessionStore.getState().customPreviews.draft_next).toBe('Project development2');
    expect(useGroupStore.getState().getGroupOfSession('draft_next')).toBeUndefined();
  });

  it('uses a localized fallback for a source with no title', () => {
    useSessionStore.setState({ sessions: [{ ...source, preview: '' }] });
    useSessionStore.getState().addContinuationDraft('draft_next', '/workspace', source.id, '新建会话');
    expect(useSessionStore.getState().customPreviews.draft_next).toBe('新建会话2');
  });

  it('retains the inherited name and group through refresh, CLI promotion and metadata reload', async () => {
    disk.groups = [group];
    await initGroupPersistence();
    useSessionStore.getState().setCustomPreview(source.id, 'Project 9');
    useSessionStore.getState().addContinuationDraft('draft_next', '/workspace', source.id, 'New chat');
    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions[0].id).toBe('draft_next');
    expect(useSessionStore.getState().customPreviews.draft_next).toBe('Project 10');

    useSessionStore.getState().promoteDraft('draft_next', 'cli-next');
    await vi.waitFor(() => expect(disk.groups).toEqual([{
      ...group, sessionIds: ['source', 'cli-next'],
    }]));
    expect(disk.names['cli-next']).toBe('Project 10');
    expect(disk.names.draft_next).toBeUndefined();
    useSessionStore.setState({ customPreviews: {} });
    await useSessionStore.getState().loadCustomPreviewsFromDisk();
    await initGroupPersistence();
    expect(useSessionStore.getState().customPreviews['cli-next']).toBe('Project 10');
    expect(useGroupStore.getState().getGroupOfSession('cli-next')?.id).toBe(group.id);

    useSessionStore.getState().addContinuationDraft('draft_following', '/workspace', 'cli-next', 'New chat');
    expect(useSessionStore.getState().customPreviews.draft_following).toBe('Project 11');
    expect(useGroupStore.getState().getGroupOfSession('draft_following')?.id).toBe(group.id);
    await vi.waitFor(() => expect(disk.groups).toEqual([{
      ...group, sessionIds: ['source', 'cli-next', 'draft_following'],
    }]));
  });
});
