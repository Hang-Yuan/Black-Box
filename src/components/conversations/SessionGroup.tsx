import { useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SessionListItem } from '../../lib/tauri-bridge';
import { SortableSessionItem } from './SortableSessionItem';
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
  onMoveSession: (
    sessionId: string,
    targetGroupId: string | null,
    beforeSessionId?: string,
  ) => void;
  onNewSessionInGroup: (groupId: string) => void;
  sessionDragEnabled: boolean;
  /** Archived history preserves the ledger but does not mutate its structure. */
  readOnly?: boolean;
}

interface UngroupedDropZoneProps {
  id: string;
  enabled: boolean;
  activeSessionDrag: string | null;
  children: React.ReactNode;
}

/** Must render beneath DndContext so the ungrouped ledger is a real drop target. */
function UngroupedDropZone({
  id,
  enabled,
  activeSessionDrag,
  children,
}: UngroupedDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    disabled: !enabled,
    data: { kind: 'ungrouped' },
  });

  return (
    <div
      ref={setNodeRef}
      className={`mx-1 rounded-md transition-colors
        ${isOver && activeSessionDrag
          ? 'bg-accent/10 ring-1 ring-inset ring-accent/35'
          : ''}`}
    >
      {children}
    </div>
  );
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
  onMoveSession,
  onNewSessionInGroup,
  sessionDragEnabled,
  readOnly = false,
}: SessionGroupProps) {
  const t = useT();
  const [activeSessionDrag, setActiveSessionDrag] = useState<string | null>(null);

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
  const ungroupedDropId = `ungrouped:${projectKey}`;

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id);
    const groupIds = new Set(taskGroups.map((taskGroup) => taskGroup.group.id));
    setActiveSessionDrag(groupIds.has(activeId) ? null : activeId);
  };

  const handleGroupDragEnd = (e: DragEndEvent) => {
    setActiveSessionDrag(null);
    if (readOnly) return;
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const currentOrder = taskGroups.map((tg) => tg.group.id);
    if (currentOrder.includes(activeId)) {
      const overGroup = taskGroups.find(({ group, sessions: members }) => (
        group.id === overId || members.some((session) => session.id === overId)
      ));
      if (!overGroup || overGroup.group.id === activeId) return;
      const next = reorderByDragEnd(currentOrder, activeId, overGroup.group.id);
      onReorderGroups(projectKey, next);
      return;
    }

    if (!sessionDragEnabled || activeId === overId) return;
    const targetGroup = taskGroups.find(({ group, sessions: members }) => (
      group.id === overId || members.some((session) => session.id === overId)
    ));
    if (targetGroup) {
      const beforeSessionId = targetGroup.sessions.some((session) => session.id === overId)
        ? overId
        : undefined;
      onMoveSession(activeId, targetGroup.group.id, beforeSessionId);
      return;
    }

    const overIsUngrouped = overId === ungroupedDropId
      || pinnedItems.some((session) => session.id === overId)
      || dateGroups.some(({ items }) => items.some((session) => session.id === overId));
    if (overIsUngrouped) onMoveSession(activeId, null);
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragCancel={() => setActiveSessionDrag(null)}
            onDragEnd={handleGroupDragEnd}
          >
            {/* Global-pinned sessions (cross-group, top of workspace) */}
            {pinnedItems.length > 0 && (
              <SortableContext
                items={pinnedItems.map((session) => session.id)}
                strategy={verticalListSortingStrategy}
              >
              {pinnedItems.map((session) => (
                <SortableSessionItem
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
                  dragEnabled={sessionDragEnabled}
                  groupId={null}
                />
              ))}
              </SortableContext>
            )}

            {/* Task groups — drag the six-dot handle to reorder (within workspace) */}
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
                  sessionDragEnabled={sessionDragEnabled}
                />
              ))}
            </SortableContext>

            {/* Ungrouped — date-grouped sessions and an explicit detach target. */}
            <UngroupedDropZone
              id={ungroupedDropId}
              enabled={sessionDragEnabled}
              activeSessionDrag={activeSessionDrag}
            >
              {taskGroups.length > 0 && (
                <div className="px-6 pt-1.5 pb-0.5 text-[10px] text-text-tertiary/80 select-none">
                  未归类
                  {activeSessionDrag && (
                    <span className="ml-1 text-accent/80">· 松开移出分组</span>
                  )}
                </div>
              )}
              {dateGroups.length === 0 && taskGroups.length > 0 && activeSessionDrag && (
                <div className="mx-2 mb-1 rounded border border-dashed border-border-subtle
                  px-3 py-2 text-center text-[10px] text-text-tertiary">
                  拖到这里移出分组
                </div>
              )}
              {dateGroups.map(({ category, label: dateLabel, items }) => (
                <div key={category}>
                  <div className="text-[10px] text-text-tertiary/70 font-medium px-6 py-0.5 mt-0.5
                    select-none">
                    {dateLabel}
                  </div>
                  <SortableContext
                    items={items.map((session) => session.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {items.map((session) => (
                      <SortableSessionItem
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
                        dragEnabled={sessionDragEnabled}
                        groupId={null}
                      />
                    ))}
                  </SortableContext>
                </div>
              ))}
            </UngroupedDropZone>
          </DndContext>
        </div>
      )}
    </div>
  );
}
