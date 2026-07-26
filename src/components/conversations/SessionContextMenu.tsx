import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SessionListItem } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import {
  placeContextMenu,
  placeSubmenu,
  type FloatingMenuPosition,
} from '../../lib/floating-menu-placement';

/** A group option offered in the "add to group" section. */
export interface GroupOption {
  id: string;
  label: string;
}

interface SessionContextMenuProps {
  x: number;
  y: number;
  session: SessionListItem;
  onRename: (session: SessionListItem) => void;
  onFork?: (session: SessionListItem) => void;
  forkDisabled?: boolean;
  onCompare?: (session: SessionListItem) => void;
  compareDisabled?: boolean;
  onRevealInFinder: (session: SessionListItem) => void;
  onExport: (session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
  onPin?: (session: SessionListItem) => void;
  isPinned?: boolean;
  onArchive?: (session: SessionListItem) => void;
  isArchived?: boolean;
  // --- Session grouping ---
  /** Create a new group in this session's workspace and drop it in. */
  onCreateGroupWithSession?: (session: SessionListItem) => void;
  /** Groups in this session's workspace it can be moved into (excludes current). */
  availableGroups?: GroupOption[];
  onAddToGroup?: (session: SessionListItem, groupId: string) => void;
  /** Non-null when the session is currently in a group → enables "remove". */
  currentGroupId?: string | null;
  onRemoveFromGroup?: (session: SessionListItem) => void;
  onClose: () => void;
}

const itemCls =
  'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary ' +
  'hover:bg-bg-secondary transition-smooth';

export function SessionContextMenu({
  x,
  y,
  session,
  onRename,
  onFork,
  forkDisabled,
  onCompare,
  compareDisabled,
  onRevealInFinder,
  onExport,
  onDelete,
  onPin,
  isPinned,
  onArchive,
  isArchived,
  onCreateGroupWithSession,
  availableGroups,
  onAddToGroup,
  currentGroupId,
  onRemoveFromGroup,
  onClose,
}: SessionContextMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const groupTriggerRef = useRef<HTMLButtonElement>(null);
  const groupSubmenuRef = useRef<HTMLDivElement>(null);
  const groupMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<FloatingMenuPosition>({
    left: x,
    top: y,
    horizontal: 'right',
    vertical: 'down',
  });
  const [groupMenuPosition, setGroupMenuPosition] = useState<FloatingMenuPosition>({
    left: x + 184,
    top: y,
    horizontal: 'right',
    vertical: 'down',
  });

  const positionMainMenu = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setMenuPosition(placeContextMenu(
      x,
      y,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [x, y]);

  const positionGroupSubmenu = useCallback(() => {
    const trigger = groupTriggerRef.current;
    const submenu = groupSubmenuRef.current;
    if (!trigger || !submenu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    setGroupMenuPosition(placeSubmenu(
      {
        left: triggerRect.left,
        right: triggerRect.right,
        top: triggerRect.top,
        bottom: triggerRect.bottom,
      },
      { width: submenuRect.width, height: submenuRect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, []);

  const cancelGroupMenuClose = useCallback(() => {
    if (groupMenuCloseTimerRef.current) {
      clearTimeout(groupMenuCloseTimerRef.current);
      groupMenuCloseTimerRef.current = null;
    }
  }, []);

  const openGroupMenu = useCallback(() => {
    cancelGroupMenuClose();
    setGroupMenuOpen(true);
  }, [cancelGroupMenuClose]);

  const scheduleGroupMenuClose = useCallback(() => {
    cancelGroupMenuClose();
    groupMenuCloseTimerRef.current = setTimeout(() => {
      groupMenuCloseTimerRef.current = null;
      setGroupMenuOpen(false);
    }, 120);
  }, [cancelGroupMenuClose]);

  useLayoutEffect(() => {
    positionMainMenu();
    window.addEventListener('resize', positionMainMenu);
    return () => window.removeEventListener('resize', positionMainMenu);
  }, [positionMainMenu]);

  useLayoutEffect(() => {
    if (!groupMenuOpen) return;
    positionGroupSubmenu();
    window.addEventListener('resize', positionGroupSubmenu);
    return () => window.removeEventListener('resize', positionGroupSubmenu);
  }, [groupMenuOpen, menuPosition, positionGroupSubmenu]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current
        && !menuRef.current.contains(target)
        && !groupSubmenuRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  useEffect(() => () => cancelGroupMenuClose(), [cancelGroupMenuClose]);

  const showGrouping =
    !!onCreateGroupWithSession || !!onRemoveFromGroup || (availableGroups?.length ?? 0) > 0;

  return createPortal(
    <>
      <div
        ref={menuRef}
        className="fixed z-[9999] min-w-[180px] py-1.5 rounded-lg
          bg-bg-card border border-border-subtle shadow-xl animate-fade-in
          overflow-visible"
        data-placement={menuPosition.vertical}
        style={{
          left: menuPosition.left,
          top: menuPosition.top,
          maxHeight: 'calc(100vh - 16px)',
        }}
      >
      <button onClick={() => { onClose(); onRename(session); }} className={itemCls}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
        </svg>
        {t('conv.rename')}
      </button>

      {onFork && (
        <button
          data-testid={`fork-session-${session.id}`}
          onClick={() => {
            if (forkDisabled) return;
            onClose();
            onFork(session);
          }}
          disabled={forkDisabled}
          title={forkDisabled ? t('conv.forkRunningBlocked') : t('conv.forkHint')}
          className={`${itemCls} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2v3.5A3.5 3.5 0 006.5 9H13" />
            <path d="M9.5 5.5L13 9l-3.5 3.5" />
          </svg>
          {t('conv.fork')}
        </button>
      )}

      {onCompare && (
        <button
          data-testid={`compare-session-${session.id}`}
          onClick={() => {
            if (compareDisabled) return;
            onClose();
            onCompare(session);
          }}
          disabled={compareDisabled}
          title={compareDisabled ? t('conv.compareDisabled') : t('conv.compareHint')}
          className={`${itemCls} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="5.5" height="11" rx="1.5" />
            <rect x="9" y="2.5" width="5.5" height="11" rx="1.5" />
          </svg>
          {t('conv.compareSideBySide')}
        </button>
      )}

      {onPin && (
        <button onClick={() => { onClose(); onPin(session); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2L14 6.5L8.5 12L6 14L4.5 11.5L2 9.5L4 7.5L9.5 2z" />
            <path d="M4.5 11.5L1.5 14.5" />
          </svg>
          {isPinned ? t('conv.unpin') : t('conv.pin')}
        </button>
      )}

      {onArchive && (
        <button onClick={() => { onClose(); onArchive(session); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {isArchived ? (
              <>
                <path d="M2.5 5.5h11v8h-11z" />
                <path d="M1.5 2.5h13v3h-13zM8 11V7M5.8 9.2L8 7l2.2 2.2" />
              </>
            ) : (
              <>
                <path d="M2.5 5.5h11v8h-11z" />
                <path d="M1.5 2.5h13v3h-13zM6 9h4" />
              </>
            )}
          </svg>
          {isArchived ? t('conv.unarchive') : t('conv.archive')}
        </button>
      )}

      {/* --- Session grouping --- */}
      {showGrouping && <div className="my-1 border-t border-border-subtle" />}

      {onCreateGroupWithSession && (
        <button onClick={() => { onClose(); onCreateGroupWithSession(session); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="2.5" width="11" height="11" rx="3" />
            <path d="M8 5.5v5M5.5 8h5" />
          </svg>
          创建任务组
        </button>
      )}

      {availableGroups && availableGroups.length > 0 && onAddToGroup && (
        <div
          className="relative"
          onMouseEnter={openGroupMenu}
          onMouseLeave={scheduleGroupMenuClose}
        >
          <button
            ref={groupTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={groupMenuOpen}
            data-testid="session-group-submenu-trigger"
            onFocus={openGroupMenu}
            onClick={() => setGroupMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setGroupMenuOpen(true);
              }
            }}
            className={itemCls}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="10" height="10" rx="2.5" />
            </svg>
            <span className="flex-1 text-left">加入任务组</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
              strokeLinejoin="round" className="text-text-tertiary">
              <path d="M6 3.5L10.5 8 6 12.5" />
            </svg>
          </button>
        </div>
      )}

      {currentGroupId && onRemoveFromGroup && (
        <button onClick={() => { onClose(); onRemoveFromGroup(session); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h10" />
          </svg>
          移出任务组
        </button>
      )}

      {(session.path || true) && <div className="my-1 border-t border-border-subtle" />}

      {session.path && (
        <button onClick={() => { onClose(); onRevealInFinder(session); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 4h4l2 2h6v7H2V4z" />
          </svg>
          {t('conv.revealInFinder')}
        </button>
      )}

      {session.path && (
        <button onClick={() => { onClose(); onExport(session); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 14h8M8 2v9M5 8l3 3 3-3" />
          </svg>
          {t('conv.export')}
        </button>
      )}

      <div className="my-1 border-t border-border-subtle" />

      <button
        onClick={() => { onClose(); onDelete(session); }}
        className="w-full flex items-center gap-2 px-3 py-1.5
          text-xs text-red-500 hover:bg-red-500/10 transition-smooth"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" />
        </svg>
        {t('conv.delete')}
      </button>
      </div>

      {groupMenuOpen && availableGroups && onAddToGroup && (
        <div
          ref={groupSubmenuRef}
          role="menu"
          data-testid="session-group-submenu"
          data-placement={`${groupMenuPosition.horizontal}-${groupMenuPosition.vertical}`}
          onMouseEnter={cancelGroupMenuClose}
          onMouseLeave={scheduleGroupMenuClose}
          className="fixed z-[10000] min-w-[210px] max-w-[280px] py-1.5
            rounded-lg bg-bg-card border border-border-subtle shadow-xl
            overflow-y-auto overscroll-contain animate-fade-in"
          style={{
            left: groupMenuPosition.left,
            top: groupMenuPosition.top,
            maxHeight: 'calc(100vh - 16px)',
          }}
        >
          <div className="px-3 py-1 text-[10px] font-medium text-text-tertiary
            border-b border-border-subtle select-none">
            选择任务组
          </div>
          {availableGroups.map((group) => (
            <button
              key={group.id}
              role="menuitem"
              onClick={() => {
                onClose();
                onAddToGroup(session, group.id);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs
                text-text-primary hover:bg-bg-secondary transition-smooth"
              title={group.label}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                strokeLinejoin="round" className="text-text-tertiary flex-shrink-0">
                <rect x="3" y="3" width="10" height="10" rx="2.5" />
              </svg>
              <span className="truncate">{group.label}</span>
            </button>
          ))}
        </div>
      )}
    </>,
    document.body,
  );
}

/** Project-level (workspace) context menu */
interface ProjectContextMenuProps {
  x: number;
  y: number;
  project: string;
  onNewSession: (project: string) => void;
  onCreateGroup?: (project: string) => void;
  onDeleteAll: (project: string) => void;
  onSelectMode?: (project: string) => void;
  onClose: () => void;
}

export function ProjectContextMenu({
  x,
  y,
  project,
  onNewSession,
  onCreateGroup,
  onDeleteAll,
  onSelectMode,
  onClose,
}: ProjectContextMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[170px] py-1.5 rounded-lg
        bg-bg-card border border-border-subtle shadow-xl animate-fade-in"
      style={{ left: x, top: y }}
    >
      <button onClick={() => { onClose(); onNewSession(project); }} className={itemCls}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t('conv.newChat')}
      </button>

      {onCreateGroup && (
        <button onClick={() => { onClose(); onCreateGroup(project); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="2.5" width="11" height="11" rx="3" />
            <path d="M8 5.5v5M5.5 8h5" />
          </svg>
          创建任务组
        </button>
      )}

      {onSelectMode && (
        <button onClick={() => { onClose(); onSelectMode(project); }} className={itemCls}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="5" height="5" rx="1" />
            <rect x="9" y="2" width="5" height="5" rx="1" />
            <rect x="2" y="9" width="5" height="5" rx="1" />
            <rect x="9" y="9" width="5" height="5" rx="1" />
          </svg>
          {t('conv.selectMode')}
        </button>
      )}

      <div className="my-1 border-t border-border-subtle" />

      <button
        onClick={() => { onClose(); onDeleteAll(project); }}
        className="w-full flex items-center gap-2 px-3 py-1.5
          text-xs text-red-500 hover:bg-red-500/10 transition-smooth"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" />
        </svg>
        {t('conv.deleteAll')}
      </button>
    </div>,
    document.body,
  );
}

/** Group-level context menu (rename / delete a task group) */
interface GroupContextMenuProps {
  x: number;
  y: number;
  groupId: string;
  onRename: (groupId: string) => void;
  onDelete: (groupId: string) => void;
  onClose: () => void;
}

export function GroupContextMenu({
  x,
  y,
  groupId,
  onRename,
  onDelete,
  onClose,
}: GroupContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[150px] py-1.5 rounded-lg
        bg-bg-card border border-border-subtle shadow-xl animate-fade-in"
      style={{ left: x, top: y }}
    >
      <button onClick={() => { onClose(); onRename(groupId); }} className={itemCls}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
        </svg>
        重命名任务组
      </button>

      <div className="my-1 border-t border-border-subtle" />

      <button
        onClick={() => { onClose(); onDelete(groupId); }}
        className="w-full flex items-center gap-2 px-3 py-1.5
          text-xs text-red-500 hover:bg-red-500/10 transition-smooth"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" />
        </svg>
        删除任务组
      </button>
    </div>,
    document.body,
  );
}
