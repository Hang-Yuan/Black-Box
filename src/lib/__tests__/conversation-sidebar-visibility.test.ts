import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION_SIDEBAR_VISIBILITY_KEY,
  loadConversationSidebarVisibility,
  saveConversationSidebarVisibility,
} from '../conversation-sidebar-visibility';

describe('conversation sidebar visibility persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('restores project and task-group choices after a simulated app restart', () => {
    saveConversationSidebarVisibility({
      activeExpandedProjects: ['~/Intelligence_Network'],
      activeCollapsedProjects: ['~/Archive'],
      activeCollapsedGroups: ['phd-application', 'meta-series'],
      archiveCollapsedProjects: ['~/OldWorkspace'],
      archiveExpandedGroups: ['archived-project'],
    });

    expect(loadConversationSidebarVisibility()).toEqual({
      activeExpandedProjects: ['~/Intelligence_Network'],
      activeCollapsedProjects: ['~/Archive'],
      activeCollapsedGroups: ['meta-series', 'phd-application'],
      archiveCollapsedProjects: ['~/OldWorkspace'],
      archiveExpandedGroups: ['archived-project'],
    });
  });

  it('recovers safely from corrupt or partially migrated state', () => {
    localStorage.setItem(CONVERSATION_SIDEBAR_VISIBILITY_KEY, JSON.stringify({
      activeCollapsedGroups: ['one', 'one', 7, null],
      archiveExpandedGroups: 'invalid',
    }));

    expect(loadConversationSidebarVisibility()).toEqual({
      activeExpandedProjects: [],
      activeCollapsedProjects: [],
      activeCollapsedGroups: ['one'],
      archiveCollapsedProjects: [],
      archiveExpandedGroups: [],
    });
  });

  it('does not let unavailable storage block the conversation list', () => {
    const failingStorage = {
      getItem: () => { throw new Error('unavailable'); },
      setItem: () => { throw new Error('unavailable'); },
    };

    expect(loadConversationSidebarVisibility(failingStorage)).toEqual({
      activeExpandedProjects: [],
      activeCollapsedProjects: [],
      activeCollapsedGroups: [],
      archiveCollapsedProjects: [],
      archiveExpandedGroups: [],
    });
    expect(() => saveConversationSidebarVisibility({
      activeExpandedProjects: [],
      activeCollapsedProjects: [],
      activeCollapsedGroups: [],
      archiveCollapsedProjects: [],
      archiveExpandedGroups: [],
    }, failingStorage)).not.toThrow();
  });
});
