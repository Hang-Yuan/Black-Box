import { useEffect, useMemo, useCallback, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { useAgentStore } from '../../stores/agentStore';
import { bridge, SessionListItem } from '../../lib/tauri-bridge';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { parseSessionMessages } from '../../lib/session-loader';
import { SessionGroup } from './SessionGroup';
import { SessionItem } from './SessionItem';
import { SessionContextMenu, ProjectContextMenu, GroupContextMenu } from './SessionContextMenu';
import { useGroupStore } from '../../stores/groupStore';
import { useForkStore } from '../../stores/forkStore';
import { initGroupPersistence } from '../../stores/groupPersistence';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import {
  settleOrphanedBackendProcesses,
  teardownSession,
  waitForStdinCleared,
} from '../../lib/sessionLifecycle';
import {
  filterSessionsForConversationView,
  groupsForConversationView,
  toggleArchivedSession,
  type ConversationView,
} from '../../lib/conversation-archive';

function closePlanPanelForComparison() {
  window.dispatchEvent(new CustomEvent('blackbox:close-plan-panel'));
}

let pinnedMetadataWriteQueue: Promise<void> = Promise.resolve();
let archivedMetadataWriteQueue: Promise<void> = Promise.resolve();

function enqueuePinnedMetadata(ids: string[]) {
  pinnedMetadataWriteQueue = pinnedMetadataWriteQueue
    .then(() => bridge.savePinnedSessions(ids))
    .catch((error) => {
      console.error('[BLACKBOX Metadata] Failed to persist pinned sessions:', error);
    });
}

function enqueueArchivedMetadata(ids: string[]) {
  archivedMetadataWriteQueue = archivedMetadataWriteQueue
    .then(() => bridge.saveArchivedSessions(ids))
    .catch((error) => {
      console.error('[BLACKBOX Metadata] Failed to persist archived sessions:', error);
    });
}

// --- Path utilities ---

let _cachedHomeDir: string | null = null;
bridge.getHomeDir().then((h) => { _cachedHomeDir = h; }).catch(() => {});

function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p);
}

// S16 (v3 §4.3): prefer the already-decoded `project` field from the backend
// (decode_project_name in Rust). We only fall through to heuristic decoding
// when the caller passes the raw projectDir token. For the encoded case we
// cache backend decoder results — the synchronous API shape prevents us from
// awaiting per call site, so decoding is fire-and-forget and the cached
// answer is returned the next time the path is queried.
const _decodedCache = new Map<string, string>();
function resolveProjectPath(raw: string): string {
  if (raw.startsWith('/') || isWindowsAbsolutePath(raw)) return raw;
  if (raw.startsWith('~/') || raw === '~') {
    if (_cachedHomeDir) return raw.replace('~', _cachedHomeDir);
    return raw;
  }
  const cached = _decodedCache.get(raw);
  if (cached) return cached;
  // Kick off an async decode so the next render picks up the authoritative
  // value; keep a naive fallback to avoid blocking the current render.
  bridge.decodeProjectDir(raw)
    .then((decoded) => { _decodedCache.set(raw, decoded); })
    .catch(() => {});
  if (/^[A-Za-z]-/.test(raw)) {
    const drive = raw[0];
    const rest = raw.slice(2);
    return `${drive}:\\${rest.replace(/-/g, '\\')}`;
  }
  return raw.replace(/-/g, '/');
}

function normalizeProjectKey(raw: string): string {
  const unix = raw.match(/^\/(?:Users|home)\/[^/]+(\/.*)/);
  if (unix) return '~' + unix[1];
  const win = raw.match(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+([/\\].*)/i);
  if (win) return '~' + win[1];
  return raw;
}

/** Extract the leaf workspace name. The full path remains internal context. */
export function projectLabel(project: string): string {
  const parts = project.replace(/^~[\\/]/, '').split(/[\\/]/);
  return parts[parts.length - 1] || project;
}

// --- Context menu types ---

interface ContextMenuState {
  x: number;
  y: number;
  session: SessionListItem;
}

interface ProjectMenuState {
  x: number;
  y: number;
  project: string;
}

// --- Main component ---

export function ConversationList() {
  const t = useT();

  // Store subscriptions
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const searchQuery = useSessionStore((s) => s.searchQuery);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const setSearchQuery = useSessionStore((s) => s.setSearchQuery);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const setSelected = useSessionStore((s) => s.setSelectedSession);
  const customPreviews = useSessionStore((s) => s.customPreviews);
  const setCustomPreview = useSessionStore((s) => s.setCustomPreview);
  const loadCustomPreviewsFromDisk = useSessionStore((s) => s.loadCustomPreviewsFromDisk);
  const runningSessions = useSessionStore((s) => s.runningSessions);
  const contentSearchResults = useSessionStore((s) => s.contentSearchResults);
  const isContentSearching = useSessionStore((s) => s.isContentSearching);
  const searchSessionContent = useSessionStore((s) => s.searchSessionContent);
  const clearContentSearch = useSessionStore((s) => s.clearContentSearch);
  const selectedFork = useForkStore((s) => selectedId ? s.forks[selectedId] : undefined);
  const selectedUserTurnCount = useChatStore((s) => selectedId
    ? (s.tabs.get(selectedId)?.messages.filter((message) => message.role === 'user').length ?? 0)
    : 0);
  const selectedInputDraft = useChatStore((s) => selectedId
    ? (s.tabs.get(selectedId)?.inputDraft ?? '')
    : '');

  useEffect(() => {
    if (
      !selectedId
      || selectedFork?.forkPoint !== 'checkpoint'
      || !selectedFork.checkpointTurnIndex
      || !selectedFork.checkpointPreview
      || selectedUserTurnCount !== selectedFork.checkpointTurnIndex - 1
      || selectedInputDraft.trim()
    ) return;
    useChatStore.getState().setInputDraft(selectedId, selectedFork.checkpointPreview);
  }, [selectedFork, selectedId, selectedInputDraft, selectedUserTurnCount]);

  // Context menus
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

  // Session groups (the grouping ledger lives in groupStore)
  const groups = useGroupStore((s) => s.groups);
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; groupId: string } | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<SessionListItem | null>(null);
  const [deleteAllTarget, setDeleteAllTarget] = useState<{
    projectKey: string;
    count: number;
  } | null>(null);
  const [forkNotice, setForkNotice] = useState<string | null>(null);
  const [startupRecoveryError, setStartupRecoveryError] = useState(false);
  const [startupRecoveryAttempt, setStartupRecoveryAttempt] = useState(0);

  // Shift+click multi-select: track last clicked index
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Smart collapse (Phase 2)
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());
  const [manualCollapsed, setManualCollapsed] = useState<Set<string>>(new Set());

  // The archive is a separate conversation view, not a destructive move. Task
  // groups keep their ledger identity but start collapsed every time history is
  // opened. Workspace headers stay visible so archived group names are easy to find.
  const [conversationView, setConversationView] = useState<ConversationView>('active');
  const [archiveExpandedGroups, setArchiveExpandedGroups] = useState<Set<string>>(new Set());
  const [archiveCollapsedProjects, setArchiveCollapsedProjects] = useState<Set<string>>(new Set());

  // Black Box's on-disk session_metadata.json is the sole authority for pins,
  // archive state, task groups, and ordering. React state is only the hydrated
  // view; localStorage must not compete with restore/import tombstones.
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set());
  const [archivedSessions, setArchivedSessions] = useState<Set<string>>(new Set());

  // Refresh animation
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    const started = Date.now();
    await fetchSessions();
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, 400 - elapsed);
    setTimeout(() => setRefreshing(false), remaining);
  }, [fetchSessions]);

  // Multi-select
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ESC to cancel multi-select
  useEffect(() => {
    if (!multiSelect) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMultiSelect(false);
        setSelectedIds(new Set());
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [multiSelect]);

  // Persist pinned/archived
  const persistPinned = useCallback((next: Set<string>) => {
    setPinnedSessions(next);
    enqueuePinnedMetadata([...next]);
  }, []);

  const persistArchived = useCallback((next: Set<string>) => {
    setArchivedSessions(next);
    enqueueArchivedMetadata([...next]);
  }, []);

  // Load pinned/archived from backend on init
  useEffect(() => {
    bridge.loadPinnedSessions?.()
      .then((data: string[]) => {
        if (Array.isArray(data)) setPinnedSessions(new Set(data));
      })
      .catch(() => {});
    bridge.loadArchivedSessions?.()
      .then((data: string[]) => {
        if (Array.isArray(data)) {
          setArchivedSessions(new Set(data));
        }
      })
      .catch(() => {});
  }, []);

  // Load session groups from disk + keep disk in sync on every change
  useEffect(() => {
    initGroupPersistence().catch((error) => {
      console.error('[BLACKBOX Metadata] Failed to hydrate session groups:', error);
    });
  }, []);

  // A portable organization import updates the unified on-disk authority.
  // Rehydrate every projection together so the sidebar reflects the merge
  // immediately without restarting Black Box.
  useEffect(() => {
    const reloadOrganization = () => {
      Promise.all([
        bridge.loadPinnedSessions(),
        bridge.loadArchivedSessions(),
        initGroupPersistence(),
        loadCustomPreviewsFromDisk(),
      ])
        .then(([pinned, archived]) => {
          if (Array.isArray(pinned)) setPinnedSessions(new Set(pinned));
          if (Array.isArray(archived)) setArchivedSessions(new Set(archived));
          return fetchSessions();
        })
        .catch((error) => {
          console.error('[BLACKBOX Metadata] Failed to refresh imported organization:', error);
        });
    };
    window.addEventListener('blackbox:session-organization-imported', reloadOrganization);
    return () => window.removeEventListener('blackbox:session-organization-imported', reloadOrganization);
  }, [fetchSessions, loadCustomPreviewsFromDisk]);

  // Initial fetch + polling
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    setStartupRecoveryError(false);
    settleOrphanedBackendProcesses()
      .then(() => fetchSessions())
      .then(() => {
        if (cancelled) return;
        const currentSelected = useSessionStore.getState().selectedSessionId;
        if (!currentSelected) {
          const lastId = useSessionStore.getState().getLastSessionId();
          if (lastId) {
            const sessions = useSessionStore.getState().sessions;
            const match = sessions.find((s) => s.id === lastId);
            if (match) {
              handleLoadSession(match);
            }
          }
        }
        interval = setInterval(fetchSessions, 30000);
      })
      .catch((error) => {
        console.error('[BLACKBOX] Session recovery barrier failed; disk restore is paused:', error);
        if (!cancelled) setStartupRecoveryError(true);
      });
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [startupRecoveryAttempt]);

  // Listen for sessions:changed event for instant refresh
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('sessions:changed', () => {
      fetchSessions();
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [fetchSessions]);

  // Debounce content search: 300ms after searchQuery changes, ≥2 chars
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      clearContentSearch();
      return;
    }
    const timer = setTimeout(() => {
      searchSessionContent(searchQuery.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchSessionContent, clearContentSearch]);

  // Display name resolver
  const displayName = useCallback((session: SessionListItem) => {
    return customPreviews[session.id] || session.preview || '';
  }, [customPreviews]);

  const archivedVisualState = useMemo(
    () => conversationView === 'archived' ? new Set<string>() : archivedSessions,
    [conversationView, archivedSessions],
  );

  // Filtered sessions (search + selected conversation view)
  const filtered = useMemo(() => {
    let result = filterSessionsForConversationView(sessions, archivedSessions, conversationView);

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          displayName(s).toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q)
      );
    }

    return result;
  }, [sessions, searchQuery, displayName, archivedSessions, conversationView]);

  // Group by project
  const projectGroups = useMemo(() => {
    const map = new Map<string, SessionListItem[]>();
    for (const s of filtered) {
      const raw = s.project || s.projectDir;
      const key = normalizeProjectKey(raw);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    for (const items of map.values()) {
      items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    }
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      const ta = a[1][0]?.modifiedAt || 0;
      const tb = b[1][0]?.modifiedAt || 0;
      return tb - ta;
    });
    return entries;
  }, [filtered]);

  // Content-only matches: sessions hit by content search but NOT by metadata filter
  const contentOnlyMatches = useMemo(() => {
    if (!searchQuery.trim() || contentSearchResults.size === 0) return [];
    const metadataIds = new Set(filtered.map((s) => s.id));
    return sessions.filter((s) => {
      if (metadataIds.has(s.id)) return false;
      if (!contentSearchResults.has(s.id)) return false;
      return archivedSessions.has(s.id) === (conversationView === 'archived');
    });
  }, [sessions, filtered, contentSearchResults, searchQuery, archivedSessions, conversationView]);

  // Smart expand: expand if contains selected, or manually expanded
  const isExpanded = useCallback((key: string) => {
    if (manualCollapsed.has(key)) return false;
    if (manualExpanded.has(key)) return true;
    // Default: expand if contains selected session
    if (!selectedId) return true; // expand all if nothing selected
    const raw = sessions.find((s) => s.id === selectedId);
    if (!raw) return false;
    const selectedKey = normalizeProjectKey(raw.project || raw.projectDir);
    return selectedKey === key;
  }, [manualCollapsed, manualExpanded, selectedId, sessions]);

  const toggleCollapse = useCallback((project: string) => {
    const expanded = isExpanded(project);
    if (expanded) {
      // Collapse it
      setManualCollapsed((prev) => { const next = new Set(prev); next.add(project); return next; });
      setManualExpanded((prev) => { const next = new Set(prev); next.delete(project); return next; });
    } else {
      // Expand it
      setManualExpanded((prev) => { const next = new Set(prev); next.add(project); return next; });
      setManualCollapsed((prev) => { const next = new Set(prev); next.delete(project); return next; });
    }
  }, [isExpanded]);

  const isProjectExpanded = useCallback((project: string) => {
    if (conversationView === 'archived') return !archiveCollapsedProjects.has(project);
    return isExpanded(project);
  }, [conversationView, archiveCollapsedProjects, isExpanded]);

  const handleToggleProjectCollapse = useCallback((project: string) => {
    if (conversationView === 'active') {
      toggleCollapse(project);
      return;
    }
    setArchiveCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, [conversationView, toggleCollapse]);

  const switchConversationView = useCallback((view: ConversationView) => {
    setConversationView(view);
    setContextMenu(null);
    setProjectMenu(null);
    setGroupMenu(null);
    setMultiSelect(false);
    setSelectedIds(new Set());
    if (view === 'archived') {
      // History can be large: task groups always enter collapsed by default.
      setArchiveExpandedGroups(new Set());
      setArchiveCollapsedProjects(new Set());
    }
  }, []);

  // --- Session loading (slim version using session-loader) ---
  const handleLoadSession = useCallback(async (session: SessionListItem) => {
    const { path: sessionPath, id: sessionId, project: projectOrDir } = session;
    const currentTabId = selectedId;
    useSettingsStore.getState().setMainView('chat');
    if (currentTabId === sessionId) return;

    // Save current to cache
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }

    // Close file preview
    useFileStore.getState().closePreview();

    // Switch selection
    setSelected(sessionId);

    // Try cache first
    const restored = useChatStore.getState().restoreFromCache(sessionId);
    if (restored) {
      useAgentStore.getState().restoreFromCache(sessionId);
      if (projectOrDir) {
        useSettingsStore.getState().setWorkingDirectory(resolveProjectPath(projectOrDir));
      }
      return;
    }

    // Draft sessions
    if (!sessionPath) {
      useChatStore.getState().ensureTab(sessionId);
      useChatStore.getState().resetTab(sessionId);
      useAgentStore.getState().clearAgents();
      return;
    }

    // Load from disk
    useChatStore.getState().ensureTab(sessionId);
    useSettingsStore.getState().setWorkingDirectory(resolveProjectPath(projectOrDir));
    const { clearMessages, addMessage, setSessionStatus, setSessionMeta } = useChatStore.getState();
    const agentActions = useAgentStore.getState();
    const hydrationGeneration = generateMessageId();
    clearMessages(sessionId);
    agentActions.clearAgents();
    setSessionStatus(sessionId, 'running');
    // TK-329: explicitly clear stdinId when loading from disk — no live process exists yet.
    // Only set the CLI UUID (for resume). Prevents inheriting a stale stdinId
    // from a previous session that might still be alive in the backend.
    setSessionMeta(sessionId, {
      sessionId,
      stdinId: undefined,
      stdinReady: false,
      hydratingFromDisk: true,
      hydrationGeneration,
    });
    // PRD §9: Write cliResumeId in sessionStore — InputBar reads this for resume
    useSessionStore.getState().setCliResumeId(sessionId, sessionId);

    try {
      const rawMessages = await bridge.loadSession(sessionPath);
      if (useSessionStore.getState().selectedSessionId !== sessionId) {
        return;
      }
      if (
        useChatStore.getState().getTab(sessionId)?.sessionMeta.hydrationGeneration
        !== hydrationGeneration
      ) {
        return;
      }
      const { messages, agents } = parseSessionMessages(rawMessages);
      setSessionMeta(sessionId, {
        // A durable disk transcript remains a valid resume target even when
        // its only visible assistant output is a tool card or its compact
        // summary is intentionally hidden by the presentation parser.
        turnAcceptedForResume: messages.some(
          (message) => message.role === 'user' || message.role === 'assistant',
        ),
        hydratingFromDisk: false,
        hydrationGeneration: undefined,
      });

      // Apply agents
      for (const agent of agents) {
        agentActions.upsertAgent(agent);
      }

      // Apply messages
      for (const msg of messages) {
        if (msg.toolResultContent) {
          // For messages that have tool results, add the base message first, then update
          const { toolResultContent, ...baseMsg } = msg;
          addMessage(sessionId, baseMsg);
          useChatStore.getState().updateMessage(sessionId, msg.id, { toolResultContent });
        } else {
          addMessage(sessionId, msg);
        }
      }

      // A historical fork branches immediately before the selected user turn.
      // Keep that original prompt editable even after an app reload, but stop
      // restoring it once the child has accepted any replacement turn.
      const fork = useForkStore.getState().forks[sessionId];
      const childUserTurns = messages.filter((message) => message.role === 'user').length;
      if (
        fork?.forkPoint === 'checkpoint'
        && fork.checkpointTurnIndex
        && fork.checkpointPreview
        && childUserTurns === fork.checkpointTurnIndex - 1
        && !useChatStore.getState().getTab(sessionId)?.inputDraft.trim()
      ) {
        useChatStore.getState().setInputDraft(sessionId, fork.checkpointPreview);
      }

      setSessionStatus(sessionId, 'completed');
    } catch (err) {
      if (useSessionStore.getState().selectedSessionId !== sessionId) return;
      if (
        useChatStore.getState().getTab(sessionId)?.sessionMeta.hydrationGeneration
        !== hydrationGeneration
      ) {
        return;
      }
      setSessionMeta(sessionId, {
        hydratingFromDisk: false,
        hydrationGeneration: undefined,
      });
      setSessionStatus(sessionId, 'error');
      addMessage(sessionId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: `${t('conv.loadFailed')}: ${err}`,
        timestamp: Date.now(),
      });
    }
  }, [selectedId, setSelected, t]);

  useEffect(() => {
    const handleOpenSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; draftText?: string }>).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
      if (session) {
        void handleLoadSession(session).then(() => {
          const draftText = detail?.draftText?.trim();
          if (!draftText || useSessionStore.getState().selectedSessionId !== sessionId) return;
          const existing = useChatStore.getState().getTab(sessionId)?.inputDraft.trim() || '';
          useChatStore.getState().setInputDraft(
            sessionId,
            existing ? `${existing}\n\n${draftText}` : draftText,
          );
        });
      }
    };
    window.addEventListener('blackbox:open-session', handleOpenSession);
    return () => window.removeEventListener('blackbox:open-session', handleOpenSession);
  }, [handleLoadSession]);

  // --- Delete handlers ---
  const executeDelete = useCallback(async (sessionId: string, sessionPath: string) => {
    try {
      // Kill running process before deleting (S8 fix — prevent residual processes)
      const tab = useChatStore.getState().getTab(sessionId);
      const routedStdinIds = Object.entries(useSessionStore.getState().stdinToTab)
        .filter(([, tabId]) => tabId === sessionId)
        .map(([stdinId]) => stdinId);
      const stdinIds = Array.from(new Set([
        ...(tab?.sessionMeta.stdinId ? [tab.sessionMeta.stdinId] : []),
        ...routedStdinIds,
      ]));
      for (const stdinId of stdinIds) {
        await teardownSession(stdinId, sessionId, 'delete');
        if (tab?.sessionMeta.stdinId === stdinId) {
          await waitForStdinCleared(sessionId, stdinId).catch(() => {});
        }
      }

      if (sessionPath) {
        await bridge.deleteSession(sessionId, sessionPath);
      } else {
        useSessionStore.getState().removeDraft(sessionId);
      }
      if (selectedId === sessionId) {
        setSelected('');
        useChatStore.getState().resetTab(sessionId);
        useSettingsStore.getState().setWorkingDirectory('');
      }
      useChatStore.getState().removeFromCache(sessionId);
      // Drop the per-tab agent cache — otherwise creating a new session
      // that reuses this ID shows the ghost agents of the old one (#B9).
      useAgentStore.getState().clearCacheForTab(sessionId);
      // Phase 3 §3.1: drop per-tab path grants so an authorized external
      // file can't be read again after the tab is gone.
      bridge.clearPathGrants(sessionId).catch(() => {});
      useGroupStore.getState().removeFromGroup(sessionId);
      useForkStore.getState().removeFork(sessionId);
      fetchSessions();
      return true;
    } catch (err) {
      console.error('Failed to delete session:', err);
      return false;
    }
  }, [selectedId, setSelected, fetchSessions]);

  const pruneSessionMetadata = useCallback((sessionIds: Iterable<string>) => {
    const removed = new Set(sessionIds);
    if (removed.size === 0) return;
    const nextPinned = new Set([...pinnedSessions].filter((id) => !removed.has(id)));
    const nextArchived = new Set([...archivedSessions].filter((id) => !removed.has(id)));
    if (nextPinned.size !== pinnedSessions.size) persistPinned(nextPinned);
    if (nextArchived.size !== archivedSessions.size) persistArchived(nextArchived);
  }, [pinnedSessions, archivedSessions, persistPinned, persistArchived]);

  // Single delete → confirm dialog
  const handleDeleteSingle = useCallback((session: SessionListItem) => {
    setDeleteTarget(session);
  }, []);

  // Delete all in project → confirm dialog
  const handleDeleteAllInProject = useCallback((projectKey: string) => {
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const projectSessions = allSessions.filter((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    if (projectSessions.length === 0) return;
    setDeleteAllTarget({ projectKey, count: projectSessions.length });
  }, []);

  const confirmDeleteAll = useCallback(async () => {
    if (!deleteAllTarget) return;
    const suffix = deleteAllTarget.projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const projectSessions = allSessions.filter((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    const deleted: string[] = [];
    for (const session of projectSessions) {
      if (await executeDelete(session.id, session.path)) deleted.push(session.id);
    }
    pruneSessionMetadata(deleted);
    setDeleteAllTarget(null);
    fetchSessions();
  }, [deleteAllTarget, executeDelete, fetchSessions, pruneSessionMetadata]);

  // --- Context menu handlers ---
  const handleContextMenu = useCallback((e: React.MouseEvent, session: SessionListItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }, []);

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, project: string) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu({ x: e.clientX, y: e.clientY, project });
  }, []);

  const handleRevealInFinder = useCallback((session: SessionListItem) => {
    if (session.path) bridge.revealInFinder(session.path).catch(() => {});
  }, []);

  const handleExportMarkdown = useCallback(async (session: SessionListItem) => {
    if (!session.path) return;
    const outputPath = await save({
      defaultPath: `${session.id}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (outputPath) {
      bridge.exportSessionMarkdown(session.path, outputPath).catch(() => {});
    }
  }, []);

  const handleNewSessionInProject = useCallback((projectKey: string) => {
    useSettingsStore.getState().setMainView('chat');
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const match = allSessions.find((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    const realPath = match ? (match.project || match.projectDir) : resolveProjectPath(projectKey);
    useSettingsStore.getState().setWorkingDirectory(realPath);
    const currentTabId = useSessionStore.getState().selectedSessionId;
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }
    const newDraftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useChatStore.getState().ensureTab(newDraftId);
    useChatStore.getState().resetTab(newDraftId);
    // Agent Teams are session-scoped. A new draft starts with a clean live
    // roster even when the previous conversation keeps idle teammates cached.
    useAgentStore.getState().restoreFromCache(newDraftId);
    useSessionStore.getState().addDraftSession(newDraftId, realPath);
    return newDraftId;
  }, []);

  const handleForkSession = useCallback(async (session: SessionListItem) => {
    if (!session.path || runningSessions.has(session.id)) return;
    const parentThreadId = session.cliResumeId || session.id;
    const cwd = resolveProjectPath(session.project || session.projectDir);

    try {
      const location = await bridge.getTaskLocation(parentThreadId, cwd);
      if (location.currentLocation === 'worktree') {
        setForkNotice(t('conv.forkWorktreeBlocked'));
        return;
      }
    } catch {
      // A non-Git conversation has no task-location record; it is still safe
      // to fork because Claude Code only clones conversation context.
    }

    let draftId: string | null = null;
    try {
      const rawMessages = await bridge.loadSession(session.path);
      const { messages, agents } = parseSessionMessages(rawMessages);
      const currentTabId = useSessionStore.getState().selectedSessionId;
      if (currentTabId) {
        useChatStore.getState().saveToCache(currentTabId);
        useAgentStore.getState().saveToCache(currentTabId);
      }

      draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const parentTitle = displayName(session) || t('conv.empty');
      const chat = useChatStore.getState();
      chat.ensureTab(draftId);
      chat.resetTab(draftId);
      for (const message of messages) {
        if (message.toolResultContent) {
          const { toolResultContent, ...baseMessage } = message;
          chat.addMessage(draftId, baseMessage);
          chat.updateMessage(draftId, message.id, { toolResultContent });
        } else {
          chat.addMessage(draftId, message);
        }
      }
      chat.setSessionStatus(draftId, 'completed');
      chat.setSessionMeta(draftId, {
        forkSourceId: parentThreadId,
        sessionId: undefined,
        stdinId: undefined,
        cwdSnapshot: cwd,
        turnAcceptedForResume: false,
      });

      const agentStore = useAgentStore.getState();
      agentStore.clearAgents();
      for (const agent of agents) agentStore.upsertAgent(agent);
      agentStore.saveToCache(draftId);

      useForkStore.getState().createPendingFork(draftId, parentThreadId, parentTitle, cwd);
      useSessionStore.getState().addDraftSession(draftId, cwd);
      useSessionStore.getState().setCustomPreview(
        draftId,
        parentTitle ? `${parentTitle} · ${t('conv.fork')}` : t('conv.forkDefaultTitle'),
      );

      const parentGroup = useGroupStore.getState().groups.find(
        (group) => group.sessionIds.includes(session.id),
      );
      if (parentGroup) useGroupStore.getState().addToGroup(draftId, parentGroup.id);

      useSettingsStore.getState().setMainView('chat');
      useSettingsStore.getState().setWorkingDirectory(cwd);
      useFileStore.getState().closePreview();
      setConversationView('active');
    } catch (error) {
      if (draftId) {
        useForkStore.getState().removeFork(draftId);
        useSessionStore.getState().removeDraft(draftId);
        useChatStore.getState().removeTab(draftId);
        useAgentStore.getState().clearCacheForTab(draftId);
      }
      const detail = error instanceof Error ? error.message : String(error);
      setForkNotice(`${t('conv.forkFailed')}: ${detail}`);
    }
  }, [displayName, runningSessions, t]);

  const handleCompareSession = useCallback((session: SessionListItem) => {
    const activeThreadId = useSessionStore.getState().selectedSessionId;
    if (!activeThreadId || activeThreadId === session.id || !session.path) return;
    const settings = useSettingsStore.getState();
    if (settings.secondaryPanelOpen) settings.toggleSecondaryPanel();
    closePlanPanelForComparison();
    useForkStore.getState().openComparison(session.id);
    settings.setMainView('chat');
  }, []);

  // New session that lands straight into a task group: create it in the group's
  // workspace, then write the draft id into the group ledger.
  const handleNewSessionInGroup = useCallback((groupId: string) => {
    const group = useGroupStore.getState().groups.find((g) => g.id === groupId);
    if (!group) return;
    const draftId = handleNewSessionInProject(group.workspace);
    useGroupStore.getState().addToGroup(draftId, groupId);
  }, [handleNewSessionInProject]);

  const handleReorderGroups = useCallback(
    (workspace: string, orderedGroupIds: string[]) => {
      useGroupStore.getState().reorderGroups(workspace, orderedGroupIds);
    },
    [],
  );

  // Pin / Archive handlers
  const handleTogglePin = useCallback((session: SessionListItem) => {
    const next = new Set(pinnedSessions);
    if (next.has(session.id)) next.delete(session.id);
    else next.add(session.id);
    persistPinned(next);
  }, [pinnedSessions, persistPinned]);

  const handleToggleArchive = useCallback((session: SessionListItem) => {
    persistArchived(toggleArchivedSession(archivedSessions, session.id));
  }, [archivedSessions, persistArchived]);

  // --- Session group handlers ---
  // Create an empty group in a workspace (workspace header → "create group").
  const handleCreateGroup = useCallback((projectKey: string) => {
    const id = useGroupStore.getState().createGroup(projectKey, '新分组');
    setRenamingGroupId(id); // jump straight into inline rename
  }, []);

  // Create a group and drop this session into it (session → "create group").
  const handleCreateGroupWithSession = useCallback((session: SessionListItem) => {
    const ws = normalizeProjectKey(session.project || session.projectDir);
    const id = useGroupStore.getState().createGroup(ws, '新分组');
    useGroupStore.getState().addToGroup(session.id, id);
    setRenamingGroupId(id);
  }, []);

  const handleAddToGroup = useCallback((session: SessionListItem, groupId: string) => {
    useGroupStore.getState().addToGroup(session.id, groupId);
  }, []);

  const handleRemoveFromGroup = useCallback((session: SessionListItem) => {
    useGroupStore.getState().removeFromGroup(session.id);
  }, []);

  const handleGroupContextMenu = useCallback((e: React.MouseEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setGroupMenu({ x: e.clientX, y: e.clientY, groupId });
  }, []);

  const handleRenameGroupCommit = useCallback((groupId: string, label: string) => {
    useGroupStore.getState().renameGroup(groupId, label);
    setRenamingGroupId(null);
  }, []);

  const handleDeleteGroup = useCallback((groupId: string) => {
    useGroupStore.getState().deleteGroup(groupId);
  }, []);

  const handleToggleGroupCollapse = useCallback((groupId: string) => {
    if (conversationView === 'archived') {
      setArchiveExpandedGroups((previous) => {
        const next = new Set(previous);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
      return;
    }
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, [conversationView]);

  // Build flat list of visible session IDs for shift+click range selection
  const flatSessionIds = useMemo(() => {
    const ids: string[] = [];
    for (const [project, items] of projectGroups) {
      if (isProjectExpanded(project)) {
        for (const s of items) ids.push(s.id);
      }
    }
    return ids;
  }, [projectGroups, isProjectExpanded]);

  // Multi-select handlers (with shift+click range support)
  const handleToggleCheck = useCallback((sessionId: string, shiftKey?: boolean) => {
    // Auto-enter multiSelect mode if not already in it
    if (!multiSelect) {
      setMultiSelect(true);
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);

      // Shift+click: range select
      if (shiftKey && lastClickedIndex !== null) {
        const currentIndex = flatSessionIds.indexOf(sessionId);
        if (currentIndex !== -1) {
          const start = Math.min(lastClickedIndex, currentIndex);
          const end = Math.max(lastClickedIndex, currentIndex);
          for (let i = start; i <= end; i++) {
            next.add(flatSessionIds[i]);
          }
          setLastClickedIndex(currentIndex);
          return next;
        }
      }

      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);

      setLastClickedIndex(flatSessionIds.indexOf(sessionId));
      return next;
    });
  }, [flatSessionIds, lastClickedIndex, multiSelect]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteAllTarget({
      projectKey: '__batch__',
      count: selectedIds.size,
    });
  }, [selectedIds]);

  const handleBatchArchive = useCallback(() => {
    if (selectedIds.size === 0) return;
    const next = new Set(archivedSessions);
    for (const id of selectedIds) {
      if (conversationView === 'archived') next.delete(id);
      else next.add(id);
    }
    persistArchived(next);
    setSelectedIds(new Set());
    setMultiSelect(false);
  }, [selectedIds, archivedSessions, conversationView, persistArchived]);

  const confirmBatchDelete = useCallback(async () => {
    const allSessions = useSessionStore.getState().sessions;
    const deleted: string[] = [];
    for (const id of selectedIds) {
      const session = allSessions.find((s) => s.id === id);
      if (session && await executeDelete(session.id, session.path)) deleted.push(session.id);
    }
    pruneSessionMetadata(deleted);
    setSelectedIds(new Set());
    setMultiSelect(false);
    setDeleteAllTarget(null);
    fetchSessions();
  }, [selectedIds, executeDelete, fetchSessions, pruneSessionMetadata]);

  const handleRename = useCallback((sessionId: string, newName: string) => {
    setCustomPreview(sessionId, newName);
  }, [setCustomPreview]);

  // Rename from context menu — trigger inline edit in SessionItem
  const handleRenameFromMenu = useCallback((session: SessionListItem) => {
    setRenamingSessionId(session.id);
  }, []);

  const handleSelectMode = useCallback((_project: string) => {
    setMultiSelect(true);
    setSelectedIds(new Set());
  }, []);

  return (
    <div className="flex flex-col gap-1 px-3">
      {startupRecoveryError && (
        <div
          data-testid="session-recovery-blocked"
          className="mb-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2
            text-[10px] leading-relaxed text-warning"
        >
          <div>{t('conv.recoveryBlocked')}</div>
          <button
            type="button"
            className="mt-1 font-medium underline underline-offset-2 hover:text-text-primary"
            onClick={() => setStartupRecoveryAttempt((attempt) => attempt + 1)}
          >
            {t('conv.retryRecovery')}
          </button>
        </div>
      )}
      {/* Active / archive switch + search */}
      <div className="px-1 mb-2 space-y-2">
        <div
          data-testid="conversation-view-toggle"
          className="grid grid-cols-2 gap-1 rounded-lg bg-bg-tertiary/70 p-1"
        >
          {([
            ['active', t('conv.activeView')],
            ['archived', t('conv.archivedView')],
          ] as const).map(([view, label]) => (
            <button
              key={view}
              type="button"
              data-testid={`conversation-view-${view}`}
              aria-pressed={conversationView === view}
              onClick={() => switchConversationView(view)}
              className={`flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5
                text-[11px] transition-smooth
                ${conversationView === view
                  ? 'bg-bg-card text-text-primary shadow-sm'
                  : 'text-text-tertiary hover:text-text-muted'}`}
            >
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-md
            bg-bg-tertiary
            focus-within:ring-1 focus-within:ring-inset focus-within:ring-border-focus">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5"
              className="text-text-tertiary flex-shrink-0">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('conv.search')}
              className="flex-1 bg-transparent text-xs text-text-primary
                placeholder:text-text-tertiary outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="flex-shrink-0 p-0.5 rounded text-text-tertiary
                  hover:text-text-primary transition-smooth">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Loading */}
      {isLoading && sessions.length === 0 && (
        <div className="flex items-center justify-center py-6">
          <div className="w-5 h-5 border-2 border-accent/30
            border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {/* Project groups — the sidebar intentionally shows only the leaf folder name. */}
      {projectGroups.map(([project, items]) => {
        const workspaceGroups = groups.filter((group) => group.workspace === project);
        const visibleWorkspaceGroups = groupsForConversationView(
          workspaceGroups,
          items,
          conversationView,
        );
        const viewCollapsedGroups = conversationView === 'archived'
          ? new Set(
              visibleWorkspaceGroups
                .filter((group) => !archiveExpandedGroups.has(group.id))
                .map((group) => group.id),
            )
          : collapsedGroups;
        return (
        <SessionGroup
          key={project}
          projectKey={project}
          projectLabel={projectLabel(project)}
          sessions={items}
          isExpanded={isProjectExpanded(project)}
          selectedId={selectedId}
          runningSessions={runningSessions}
          pinnedSessions={pinnedSessions}
          archivedSessions={archivedVisualState}
          customPreviews={customPreviews}
          multiSelect={multiSelect}
          selectedIds={selectedIds}
          onToggleCollapse={handleToggleProjectCollapse}
          onContextMenu={handleContextMenu}
          onProjectContextMenu={handleProjectContextMenu}
          onLoadSession={handleLoadSession}
          onRename={handleRename}
          onNewSession={handleNewSessionInProject}
          onToggleCheck={handleToggleCheck}
          renamingSessionId={renamingSessionId}
          onRenameDone={() => setRenamingSessionId(null)}
          workspaceGroups={visibleWorkspaceGroups}
          collapsedGroups={viewCollapsedGroups}
          onToggleGroupCollapse={handleToggleGroupCollapse}
          onGroupContextMenu={handleGroupContextMenu}
          renamingGroupId={renamingGroupId}
          onRenameGroupCommit={handleRenameGroupCommit}
          onRenameGroupCancel={() => setRenamingGroupId(null)}
          onReorderGroups={handleReorderGroups}
          onNewSessionInGroup={handleNewSessionInGroup}
          readOnly={conversationView === 'archived'}
        />
        );
      })}

      {/* Content matches section (async, appears after metadata results) */}
      {searchQuery.trim() && contentOnlyMatches.length > 0 && (
        <div className="mt-3 mb-1">
          <div className="flex items-center gap-2 px-3 py-1">
            <div className="flex-1 h-px bg-border-subtle" />
            <span className="text-[10px] text-text-tertiary font-medium uppercase tracking-wider">
              {t('conv.contentMatches')} ({contentOnlyMatches.length})
            </span>
            <div className="flex-1 h-px bg-border-subtle" />
          </div>
          {contentOnlyMatches.map((session) => {
            const result = contentSearchResults.get(session.id);
            return (
              <SessionItem
                key={session.id}
                session={session}
                isSelected={selectedId === session.id}
                isRunning={runningSessions.has(session.id)}
                isPinned={pinnedSessions.has(session.id)}
                isArchived={conversationView === 'active' && archivedSessions.has(session.id)}
                displayName={displayName(session)}
                contentSnippet={result?.snippet}
                matchCount={result?.match_count}
                searchQuery={searchQuery}
                multiSelect={multiSelect}
                isChecked={selectedIds.has(session.id)}
                onSelect={handleLoadSession}
                onContextMenu={handleContextMenu}
                onRename={handleRename}
                onToggleCheck={handleToggleCheck}
                triggerRename={renamingSessionId === session.id}
                onRenameDone={() => setRenamingSessionId(null)}
              />
            );
          })}
        </div>
      )}

      {/* Content search loading spinner */}
      {searchQuery.trim() && isContentSearching && (
        <div className="flex items-center justify-center gap-1.5 py-3 text-text-tertiary">
          <div className="w-3 h-3 border-[1.5px] border-text-tertiary/20
            border-t-text-tertiary/60 rounded-full animate-spin" />
          <span className="text-[10px]">{t('conv.searchingContent')}</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filtered.length === 0 && contentOnlyMatches.length === 0 && !isContentSearching && (
        <div className="text-center py-6 px-4">
          <div className="text-text-tertiary text-xs">
            {searchQuery
              ? t('conv.noMatch')
              : conversationView === 'archived'
                ? t('conv.noArchived')
                : t('conv.noConv')}
          </div>
        </div>
      )}

      {/* Refresh button */}
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className="mx-1 mt-1 py-1 rounded-md
          text-text-muted hover:text-text-primary
          hover:bg-bg-secondary transition-smooth
          flex items-center justify-center
          disabled:opacity-50"
        title={t('conv.refresh')}
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={refreshing ? 'animate-spin' : ''}
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>

      {/* Multi-select floating toolbar — sticky at bottom of scroll container */}
      {multiSelect && (
        <div className="sticky bottom-0 mx-1 mt-2 p-2 rounded-md
          bg-bg-card/95 border border-border-subtle shadow-lg
          flex items-center gap-2 animate-fade-in z-10">
          <span className="text-xs text-text-muted flex-1">
            {t('conv.selected').replace('{n}', String(selectedIds.size))}
          </span>
          <button
            onClick={handleBatchArchive}
            disabled={selectedIds.size === 0}
            className="px-2 py-1 text-xs rounded-md bg-accent/10 text-accent
              hover:bg-accent/20 transition-smooth disabled:opacity-30"
          >
            {conversationView === 'archived' ? t('conv.unarchive') : t('conv.archive')}
          </button>
          <button
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0}
            className="px-2 py-1 text-xs rounded-md bg-error/10 text-error
              hover:bg-error/20 transition-smooth
              disabled:opacity-30"
          >
            {t('conv.delete')}
          </button>
          <button
            onClick={() => { setMultiSelect(false); setSelectedIds(new Set()); }}
            className="px-2 py-1 text-xs rounded-md bg-bg-tertiary text-text-muted
              hover:text-text-primary transition-smooth"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      {/* Session context menu */}
      {contextMenu && (() => {
        const ws = normalizeProjectKey(contextMenu.session.project || contextMenu.session.projectDir);
        const wsGroups = groups.filter((g) => g.workspace === ws);
        const currentGroup = wsGroups.find((g) => g.sessionIds.includes(contextMenu.session.id));
        return (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          session={contextMenu.session}
          onRename={handleRenameFromMenu}
          onFork={contextMenu.session.path ? handleForkSession : undefined}
          forkDisabled={runningSessions.has(contextMenu.session.id)}
          onCompare={contextMenu.session.path ? handleCompareSession : undefined}
          compareDisabled={!selectedId
            || selectedId === contextMenu.session.id
            || runningSessions.has(contextMenu.session.id)}
          onRevealInFinder={handleRevealInFinder}
          onExport={handleExportMarkdown}
          onDelete={handleDeleteSingle}
          onPin={conversationView === 'active' ? handleTogglePin : undefined}
          isPinned={pinnedSessions.has(contextMenu.session.id)}
          onArchive={handleToggleArchive}
          isArchived={archivedSessions.has(contextMenu.session.id)}
          onCreateGroupWithSession={conversationView === 'active' ? handleCreateGroupWithSession : undefined}
          availableGroups={conversationView === 'active'
            ? wsGroups
                .filter((g) => g.id !== currentGroup?.id)
                .map((g) => ({ id: g.id, label: g.label }))
            : undefined}
          onAddToGroup={conversationView === 'active' ? handleAddToGroup : undefined}
          currentGroupId={conversationView === 'active' ? currentGroup?.id ?? null : null}
          onRemoveFromGroup={conversationView === 'active' ? handleRemoveFromGroup : undefined}
          onClose={() => setContextMenu(null)}
        />
        );
      })()}

      {/* Project context menu */}
      {conversationView === 'active' && projectMenu && (
        <ProjectContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          project={projectMenu.project}
          onNewSession={handleNewSessionInProject}
          onCreateGroup={handleCreateGroup}
          onDeleteAll={handleDeleteAllInProject}
          onSelectMode={handleSelectMode}
          onClose={() => setProjectMenu(null)}
        />
      )}

      {/* Group context menu */}
      {conversationView === 'active' && groupMenu && (
        <GroupContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          groupId={groupMenu.groupId}
          onRename={(id) => setRenamingGroupId(id)}
          onDelete={handleDeleteGroup}
          onClose={() => setGroupMenu(null)}
        />
      )}

      {/* Delete single confirm dialog */}
      {deleteTarget && (
        <ConfirmDialog
          open={true}
          title={t('conv.delete')}
          message={t('conv.deleteConfirm')}
          detail={t('conv.deleteConfirmDetail').replace(
            '{name}',
            displayName(deleteTarget) || deleteTarget.preview,
          )}
          variant="danger"
          confirmLabel={t('conv.delete')}
          onConfirm={async () => {
            const target = deleteTarget;
            setDeleteTarget(null);
            if (await executeDelete(target.id, target.path)) {
              pruneSessionMetadata([target.id]);
            }
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {forkNotice && (
        <ConfirmDialog
          open={true}
          title={t('conv.fork')}
          message={forkNotice}
          confirmLabel={t('common.confirm')}
          hideCancel={true}
          onConfirm={() => setForkNotice(null)}
          onCancel={() => setForkNotice(null)}
        />
      )}

      {/* Delete all confirm dialog */}
      {deleteAllTarget && (
        <ConfirmDialog
          open={true}
          title={t('conv.deleteAll')}
          message={
            deleteAllTarget.projectKey === '__batch__'
              ? t('conv.deleteAllConfirm')
                  .replace('{count}', String(deleteAllTarget.count))
                  .replace('{project}', t('conv.selected').replace('{n}', String(deleteAllTarget.count)))
              : t('conv.deleteAllConfirm')
                  .replace('{count}', String(deleteAllTarget.count))
                  .replace('{project}', projectLabel(deleteAllTarget.projectKey))
          }
          detail={t('conv.deleteAllConfirmDetail')}
          variant="danger"
          confirmLabel={t('conv.delete')}
          onConfirm={deleteAllTarget.projectKey === '__batch__' ? confirmBatchDelete : confirmDeleteAll}
          onCancel={() => setDeleteAllTarget(null)}
        />
      )}
    </div>
  );
}
