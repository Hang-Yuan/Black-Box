import { create } from 'zustand';

// --- Types ---

export interface SessionGroup {
  id: string;
  label: string;
  /** Normalized workspace key the group belongs to (e.g. "~/Projects/app"). */
  workspace: string;
  /** Member session ids, in manual order. */
  sessionIds: string[];
  /** Session ids pinned to the top within this group. */
  pinnedInGroup: string[];
}

interface GroupState {
  /**
   * All groups across every workspace. Group order *within* a workspace is the
   * relative order of that workspace's groups in this array (newest-first on create).
   */
  groups: SessionGroup[];

  createGroup: (workspace: string, label: string) => string;
  renameGroup: (groupId: string, label: string) => void;
  deleteGroup: (groupId: string) => void;
  addToGroup: (sessionId: string, groupId: string) => void;
  removeFromGroup: (sessionId: string) => void;
  /** Move a conversation by drag-and-drop. `null` returns it to the ungrouped
   *  bucket; `beforeSessionId` places it at a concrete row in the target group. */
  moveSession: (
    sessionId: string,
    targetGroupId: string | null,
    beforeSessionId?: string,
  ) => void;
  reorderInGroup: (groupId: string, orderedSessionIds: string[]) => void;
  reorderGroups: (workspace: string, orderedGroupIds: string[]) => void;
  pinInGroup: (groupId: string, sessionId: string) => void;
  unpinInGroup: (groupId: string, sessionId: string) => void;
  /** Swap a session id everywhere in the ledger — used when a draft session is
   *  promoted to its real CLI id, so it stays in its group instead of falling out. */
  replaceSessionId: (oldId: string, newId: string) => void;

  getGroupsForWorkspace: (workspace: string) => SessionGroup[];
  getGroupOfSession: (sessionId: string) => SessionGroup | undefined;
}

// --- Helpers ---

/** Drop a session id from a group's member + pinned lists. Returns the same
 *  reference when the session wasn't a member (lets callers no-op cleanly). */
function detachSession(group: SessionGroup, sessionId: string): SessionGroup {
  if (!group.sessionIds.includes(sessionId)) return group;
  return {
    ...group,
    sessionIds: group.sessionIds.filter((id) => id !== sessionId),
    pinnedInGroup: group.pinnedInGroup.filter((id) => id !== sessionId),
  };
}

// --- Store ---

export const useGroupStore = create<GroupState>()((set, get) => ({
  groups: [],

  createGroup: (workspace, label) => {
    const id = crypto.randomUUID();
    const group: SessionGroup = {
      id,
      label,
      workspace,
      sessionIds: [],
      pinnedInGroup: [],
    };
    // Newest group goes to the top of its workspace.
    set({ groups: [group, ...get().groups] });
    return id;
  },

  renameGroup: (groupId, label) => {
    set({ groups: get().groups.map((g) => (g.id === groupId ? { ...g, label } : g)) });
  },

  deleteGroup: (groupId) => {
    // Drop the group; its members fall back to "ungrouped" automatically.
    // The session files themselves live outside this ledger and are untouched.
    set({ groups: get().groups.filter((g) => g.id !== groupId) });
  },

  addToGroup: (sessionId, groupId) => {
    // No-op if the target group doesn't exist — never detach a session from
    // its current group without re-attaching it somewhere.
    if (!get().groups.some((g) => g.id === groupId)) return;
    const groups = get().groups.map((g) => {
      if (g.id === groupId) {
        // Already a member → no-op (no duplicates); otherwise append to the end.
        if (g.sessionIds.includes(sessionId)) return g;
        return { ...g, sessionIds: [...g.sessionIds, sessionId] };
      }
      // Single membership: drop the session from whatever other group it was in.
      return detachSession(g, sessionId);
    });
    set({ groups });
  },

  removeFromGroup: (sessionId) => {
    set({ groups: get().groups.map((g) => detachSession(g, sessionId)) });
  },

  moveSession: (sessionId, targetGroupId, beforeSessionId) => {
    const all = get().groups;
    const source = all.find((group) => group.sessionIds.includes(sessionId));

    // Dropping on the ungrouped bucket is an explicit detach. An already
    // ungrouped conversation is a clean no-op.
    if (targetGroupId === null) {
      if (!source) return;
      set({ groups: all.map((group) => detachSession(group, sessionId)) });
      return;
    }

    const target = all.find((group) => group.id === targetGroupId);
    // Never detach from the source if the drop target has gone stale.
    if (!target) return;

    if (source?.id === targetGroupId) {
      if (
        !beforeSessionId
        || beforeSessionId === sessionId
        || !target.sessionIds.includes(beforeSessionId)
      ) return;

      const from = target.sessionIds.indexOf(sessionId);
      const to = target.sessionIds.indexOf(beforeSessionId);
      if (from === -1 || to === -1 || from === to) return;
      const ordered = target.sessionIds.slice();
      const [moved] = ordered.splice(from, 1);
      ordered.splice(to, 0, moved);
      set({
        groups: all.map((group) => (
          group.id === targetGroupId ? { ...group, sessionIds: ordered } : group
        )),
      });
      return;
    }

    // Cross-group and ungrouped-to-group moves are committed as one snapshot,
    // preserving single membership and avoiding an intermediate detached save.
    const detached = all.map((group) => detachSession(group, sessionId));
    set({
      groups: detached.map((group) => {
        if (group.id !== targetGroupId) return group;
        const ordered = group.sessionIds.slice();
        const targetIndex = beforeSessionId
          ? ordered.indexOf(beforeSessionId)
          : -1;
        if (targetIndex === -1) ordered.push(sessionId);
        else ordered.splice(targetIndex, 0, sessionId);
        return { ...group, sessionIds: ordered };
      }),
    });
  },

  reorderInGroup: (groupId, orderedSessionIds) => {
    set({
      groups: get().groups.map((g) =>
        g.id === groupId ? { ...g, sessionIds: orderedSessionIds } : g,
      ),
    });
  },

  reorderGroups: (workspace, orderedGroupIds) => {
    const all = get().groups;
    const rank = new Map(orderedGroupIds.map((id, i) => [id, i]));
    // Re-rank only this workspace's groups, then slot them back into the
    // positions this workspace already occupied — other workspaces don't move.
    const sorted = all
      .filter((g) => g.workspace === workspace)
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    let i = 0;
    const next = all.map((g) => (g.workspace === workspace ? sorted[i++] : g));
    set({ groups: next });
  },

  pinInGroup: (groupId, sessionId) => {
    set({
      groups: get().groups.map((g) => {
        if (g.id !== groupId) return g;
        // Only pin a real member — never create a dangling pin.
        if (!g.sessionIds.includes(sessionId)) return g;
        if (g.pinnedInGroup.includes(sessionId)) return g;
        return { ...g, pinnedInGroup: [...g.pinnedInGroup, sessionId] };
      }),
    });
  },

  unpinInGroup: (groupId, sessionId) => {
    set({
      groups: get().groups.map((g) =>
        g.id === groupId
          ? { ...g, pinnedInGroup: g.pinnedInGroup.filter((id) => id !== sessionId) }
          : g,
      ),
    });
  },

  replaceSessionId: (oldId, newId) => {
    set({
      groups: get().groups.map((g) => {
        if (!g.sessionIds.includes(oldId)) return g;
        return {
          ...g,
          sessionIds: g.sessionIds.map((id) => (id === oldId ? newId : id)),
          pinnedInGroup: g.pinnedInGroup.map((id) => (id === oldId ? newId : id)),
        };
      }),
    });
  },

  getGroupsForWorkspace: (workspace) =>
    get().groups.filter((g) => g.workspace === workspace),

  getGroupOfSession: (sessionId) =>
    get().groups.find((g) => g.sessionIds.includes(sessionId)),
}));
