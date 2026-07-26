import { useMemo } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SessionListItem } from '../../lib/tauri-bridge';
import { SessionItem } from './SessionItem';
import { TaskGroup } from './TaskGroup';
import { partitionWorkspaceSessions } from '../../stores/groupSelectors';
import { reorderByDragEnd } from '../../stores/groupDnd';
import type { SessionGroup as GroupData } from '../../stores/groupStore';
import { useT } from '../../lib/i18n';

/** Determine date category for a timestamp */
function getDateCategory(ms: number): 'today' | 'yesterday' | 'thisWeek' | 'earlier' {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;

  const dayOfWeek = now.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = todayStart - daysToMonday * 86400000;

  if (ms >= todayStart) return 'today';
  if (ms >= yesterdayStart) return 'yesterday';
  if (ms >= weekStart) return 'thisWeek';
  return 'earlier';
}

interface SessionGroupProps {
  projectKey: string;
  projectLabel: string;
  sessions: SessionListItem[];
  isExpanded: boolean;
  selectedId: string | null;
  runningSessions: Set<string>;
  pinnedSessions: Set<string>;
  archivedSessions: Set<string>;
  customPreviews: Record<string, string>;
  multiSelect: boolean;
  selectedIds: Set<string>;
  onToggleCollapse: (project: string) => void;
  onContextMenu: (e: React.MouseEvent, session: SessionListItem) => void;
  onProjectContextMenu: (e: React.MouseEvent, project: string) => void;
  onLoadSession: (session: SessionListItem) => void;
  onRename: (sessionId: string, newName: string) => void;
  onNewSession: (project: string) => void;
  onToggleCheck: (sessionId: string, shiftKey?: boolean) => void;
  renamingSessionId?: string | null;
  onRenameDone?: () => void;
  // --- Session grouping ---
  workspaceGroups: GroupData[];
  collapsedGroups: Set<string>;
  onToggleGroupCollapse: (groupId: string) => void;
  onGroupContextMenu: (e: React.MouseEvent, groupId: string) => void;
  renamingGroupId?: string | null;
  onRenameGroupCommit: (groupId: string, label: string) => void;
  onRenameGroupCancel: () => void;
  onReorderGroups: (workspace: string, orderedGroupIds: string[]) => void;
  onNewSessionInGroup: (groupId: string) => void;
  /** Archived history preserves the ledger but does not mutate its structure. */
  readOnly?: boolean;
}

export function SessionGroup({
  projectKey,
  projectLabel: label,
  sessions,
  isExpanded,
  selectedId,
  runningSessions,
  pinnedSessions,
  archivedSessions,
  customPreviews,
  multiSelect,
  selectedIds,
  onToggleCollapse,
  onContextMenu,
  onProjectContextMenu,
  onLoadSession,
  onRename,
  onNewSession,
  onToggleCheck,
  renamingSessionId,
  onRenameDone,
  workspaceGroups,
  collapsedGroups,
  onToggleGroupCollapse,
  onGroupContextMenu,
  renamingGroupId,
  onRenameGroupCommit,
  onRenameGroupCancel,
  onReorderGroups,
  onNewSessionInGroup,
  readOnly = false,
}: SessionGroupProps) {
  const t = useT();

  // Split this workspace's sessions into task groups + ungrouped, then within
  // ungrouped: global-pinned first, the rest grouped by date.
  const { taskGroups, pinnedItems, dateGroups } = useMemo(() => {
    const { groups, ungrouped } = partitionWorkspaceSessions(sessions, workspaceGroups);

    const pinned: SessionListItem[] = [];
    const unpinned: SessionListItem[] = [];
    for (const s of ungrouped) {
      if (pinnedSessions.has(s.id)) pinned.push(s);
      else unpinned.push(s);
    }

    const categoryMap = new Map<string, SessionListItem[]>();
    for (const s of unpinned) {
      const cat = getDateCategory(s.modifiedAt);
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat)!.push(s);
    }
    const categoryOrder: Array<{ key: string; label: string }> = [
      { key: 'today', label: t('conv.today') },
      { key: 'yesterday', label: t('conv.yesterday') },
      { key: 'thisWeek', label: t('conv.thisWeek') },
      { key: 'earlier', label: t('conv.older') },
    ];
    const dGroups: { category: string; label: string; items: SessionListItem[] }[] = [];
    for (const { key, label: catLabel } of categoryOrder) {
      const items = categoryMap.get(key);
      if (items && items.length > 0) dGroups.push({ category: key, label: catLabel, items });
    }

    return { taskGroups: groups, pinnedItems: pinned, dateGroups: dGroups };
  }, [sessions, workspaceGroups, pinnedSessions, t]);

  const getDisplayName = (session: SessionListItem) =>
    customPreviews[session.id] || session.preview || '';

  // Drag-to-reorder groups within this workspace. Each workspace renders its own
  // DndContext, so a drag can never cross workspaces (mp-review constraint).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const handleGroupDragEnd = (e: DragEndEvent) => {
    if (readOnly) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const currentOrder = taskGroups.map((tg) => tg.group.id);
    const next = reorderByDragEnd(currentOrder, String(active.id), String(over.id));
    onReorderGroups(projectKey, next);
  };

  return (
    <div className="mb-1">
      {/* Project header */}
      <div
        onClick={() => onToggleCollapse(projectKey)}
        onContextMenu={readOnly ? undefined : (e) => onProjectContextMenu(e, projectKey)}
        className="w-full flex items-center gap-2 px-2.5 py-1 cursor-pointer
          hover:bg-bg-secondary rounded-sm transition-smooth group"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleCollapse(projectKey); }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`text-accent transition-transform flex-shrink-0
            ${isExpanded ? 'rotate-90' : ''}`}>
          <path d="M3 1l4 4-4 4" />
        </svg>
        <span className="text-[12px] font-semibold text-text-primary
          truncate flex-1 text-left min-w-0">
          {label}
        </span>
        {!readOnly && (
          <span className="text-[10px] text-text-tertiary flex-shrink-0">
            {sessions.length} {t('conv.sessions')}
          </span>
        )}
        {!readOnly && (
          <button
            onClick={(e) => { e.stopPropagation(); onNewSession(projectKey); }}
            className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100
              hover:bg-bg-tertiary transition-smooth text-text-tertiary hover:text-accent"
            title={t('conv.newChat')}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        )}
      </div>

      {/* Sessions */}
      {isExpanded && (
        <div className="pt-2">
          {/* Global-pinned sessions (cross-group, top of workspace) */}
          {pinnedItems.length > 0 && (
            <>
              {pinnedItems.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={selectedId === session.id}
                  isRunning={runningSessions.has(session.id)}
                  isPinned={true}
                  isArchived={archivedSessions.has(session.id)}
                  displayName={getDisplayName(session)}
                  multiSelect={multiSelect}
                  isChecked={selectedIds.has(session.id)}
                  onSelect={onLoadSession}
                  onContextMenu={onContextMenu}
                  onRename={onRename}
                  onToggleCheck={onToggleCheck}
                  triggerRename={renamingSessionId === session.id}
                  onRenameDone={onRenameDone}
                />
              ))}
            </>
          )}

          {/* Task groups — drag the six-dot handle to reorder (within workspace) */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleGroupDragEnd}
          >
            <SortableContext
              items={taskGroups.map((tg) => tg.group.id)}
              strategy={verticalListSortingStrategy}
            >
              {taskGroups.map(({ group, sessions: groupSessions }) => (
                <TaskGroup
                  key={group.id}
                  group={group}
                  sessions={groupSessions}
                  isExpanded={!collapsedGroups.has(group.id)}
                  selectedId={selectedId}
                  runningSessions={runningSessions}
                  archivedSessions={archivedSessions}
                  customPreviews={customPreviews}
                  multiSelect={multiSelect}
                  selectedIds={selectedIds}
                  renamingSessionId={renamingSessionId}
                  onLoadSession={onLoadSession}
                  onSessionContextMenu={onContextMenu}
                  onRenameSession={onRename}
                  onToggleCheck={onToggleCheck}
                  onRenameDone={onRenameDone}
                  onToggleCollapse={onToggleGroupCollapse}
                  onGroupContextMenu={onGroupContextMenu}
                  isRenaming={renamingGroupId === group.id}
                  onRenameGroupCommit={onRenameGroupCommit}
                  onRenameCancel={onRenameGroupCancel}
                  onNewSessionInGroup={onNewSessionInGroup}
                  readOnly={readOnly}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Ungrouped — date-grouped sessions */}
          {dateGroups.length > 0 && taskGroups.length > 0 && (
            <div className="px-7 pt-1.5 pb-0.5 text-[10px] text-text-tertiary/80 select-none">
              未归类
            </div>
          )}
          {dateGroups.map(({ category, label: dateLabel, items }) => (
            <div key={category}>
              <div className="text-[10px] text-text-tertiary/70 font-medium px-6 py-0.5 mt-0.5
                select-none">
                {dateLabel}
              </div>
              {items.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={selectedId === session.id}
                  isRunning={runningSessions.has(session.id)}
                  isPinned={false}
                  isArchived={archivedSessions.has(session.id)}
                  displayName={getDisplayName(session)}
                  multiSelect={multiSelect}
                  isChecked={selectedIds.has(session.id)}
                  onSelect={onLoadSession}
                  onContextMenu={onContextMenu}
                  onRename={onRename}
                  onToggleCheck={onToggleCheck}
                  triggerRename={renamingSessionId === session.id}
                  onRenameDone={onRenameDone}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
