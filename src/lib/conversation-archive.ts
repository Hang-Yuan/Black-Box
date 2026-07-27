import type { SessionListItem } from './tauri-bridge';
import type { SessionGroup } from '../stores/groupStore';

export type ConversationView = 'active' | 'archived';

/** One authority rule for both metadata and full-text search results. */
export function filterSessionsForConversationView(
  sessions: SessionListItem[],
  archivedSessionIds: ReadonlySet<string>,
  view: ConversationView,
): SessionListItem[] {
  const archived = view === 'archived';
  return sessions.filter((session) => archivedSessionIds.has(session.id) === archived);
}

/**
 * The active view keeps empty task groups available for ongoing organization.
 * The archive view only shows groups that contain a visible archived session,
 * preserving the original group label/order without filling history with
 * unrelated empty cards.
 */
export function groupsForConversationView(
  groups: SessionGroup[],
  visibleSessions: SessionListItem[],
  view: ConversationView,
): SessionGroup[] {
  if (view === 'active') return groups;
  const visibleIds = new Set(visibleSessions.map((session) => session.id));
  return groups.filter((group) => group.sessionIds.some((id) => visibleIds.has(id)));
}

export function toggleArchivedSession(
  archivedSessionIds: ReadonlySet<string>,
  sessionId: string,
): Set<string> {
  const next = new Set(archivedSessionIds);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  return next;
}
