import { useState, useRef, useEffect, useCallback } from 'react';
import { SessionListItem } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { t as tStatic } from '../../lib/i18n';
import { formatSessionTime } from '../../lib/session-time';

/** Renders snippet text with query matches highlighted in accent color */
function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query || query.length < 2) return <span className="line-clamp-3">{text}</span>;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const parts: { text: string; highlight: boolean }[] = [];
  let lastEnd = 0;
  let idx = lower.indexOf(qLower);
  while (idx !== -1) {
    if (idx > lastEnd) parts.push({ text: text.slice(lastEnd, idx), highlight: false });
    parts.push({ text: text.slice(idx, idx + query.length), highlight: true });
    lastEnd = idx + query.length;
    idx = lower.indexOf(qLower, lastEnd);
  }
  if (lastEnd < text.length) parts.push({ text: text.slice(lastEnd), highlight: false });
  if (parts.length === 0) return <span className="line-clamp-3">{text}</span>;
  return (
    <span className="line-clamp-3">
      {parts.map((p, i) => p.highlight
        ? <mark key={i} className="bg-amber-300/60 dark:bg-amber-500/40 text-inherit rounded-sm px-px">{p.text}</mark>
        : <span key={i}>{p.text}</span>
      )}
    </span>
  );
}

interface SessionItemProps {
  session: SessionListItem;
  isSelected: boolean;
  isRunning: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  displayName: string;
  multiSelect?: boolean;
  isChecked?: boolean;
  onSelect: (session: SessionListItem) => void;
  onContextMenu: (e: React.MouseEvent, session: SessionListItem) => void;
  onRename: (sessionId: string, newName: string) => void;
  onToggleCheck?: (sessionId: string, shiftKey?: boolean) => void;
  contentSnippet?: string;
  matchCount?: number;
  searchQuery?: string;
  triggerRename?: boolean;
  onRenameDone?: () => void;
  /** Left-indent preset: 'normal' aligns with the workspace path (pl-7);
   *  'group' is the compact inset used inside a task-group card. */
  inset?: 'normal' | 'group';
}

export function SessionItem({
  session,
  isSelected,
  isRunning,
  isPinned,
  isArchived,
  displayName: name,
  multiSelect,
  isChecked,
  onSelect,
  onContextMenu,
  onRename,
  contentSnippet,
  matchCount,
  searchQuery,
  onToggleCheck,
  triggerRename,
  onRenameDone,
  inset = 'normal',
}: SessionItemProps) {
  const t = useT();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Animate title changes (AI-generated titles)
  const [titleAnimating, setTitleAnimating] = useState(false);
  const prevNameRef = useRef(name);
  useEffect(() => {
    if (prevNameRef.current !== name && prevNameRef.current !== '' && name !== '') {
      setTitleAnimating(true);
      const timer = setTimeout(() => setTitleAnimating(false), 600);
      prevNameRef.current = name;
      return () => clearTimeout(timer);
    }
    prevNameRef.current = name;
  }, [name]);

  const startRename = useCallback(() => {
    setIsRenaming(true);
    setRenameValue(name);
  }, [name]);

  useEffect(() => {
    if (triggerRename) {
      startRename();
      onRenameDone?.();
    }
  }, [triggerRename, startRename, onRenameDone]);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const handleRenameConfirm = useCallback(() => {
    if (renameValue.trim()) {
      onRename(session.id, renameValue.trim());
    }
    setIsRenaming(false);
    setRenameValue('');
  }, [renameValue, session.id, onRename]);

  const handleRenameCancel = useCallback(() => {
    setIsRenaming(false);
    setRenameValue('');
  }, []);

  return (
    <button
      {...(import.meta.env.DEV && { 'data-testid': `session-item-${session.id}` })}
      onClick={(e) => {
        if (multiSelect && onToggleCheck) {
          onToggleCheck(session.id, e.shiftKey);
        } else if (e.shiftKey && onToggleCheck) {
          // Shift+click outside multiSelect mode: auto-enter multiSelect
          onToggleCheck(session.id, false);
        } else {
          onSelect(session);
        }
      }}
      onDoubleClick={(e) => {
        if (multiSelect) return;
        e.preventDefault();
        e.stopPropagation();
        startRename();
      }}
      onContextMenu={(e) => onContextMenu(e, session)}
      className={`relative w-full text-left ${inset === 'group' ? 'pl-4' : 'pl-6'} pr-2.5 py-[5px] rounded-md
        transition-smooth group hover:bg-bg-secondary
        ${isArchived ? 'opacity-50' : ''}`}
    >
      {isSelected && (
        <span className="absolute left-1 top-1/2 -translate-y-1/2 w-[2px] h-3.5 rounded-full
          bg-accent" />
      )}
      <div className="flex items-center gap-2">
        {multiSelect && (
          <input
            type="checkbox"
            checked={isChecked || false}
            onChange={(e) => onToggleCheck?.(session.id, (e.nativeEvent as MouseEvent).shiftKey)}
            onClick={(e) => e.stopPropagation()}
            className="flex-shrink-0 w-3.5 h-3.5 rounded border-border-subtle
              accent-accent cursor-pointer"
          />
        )}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') handleRenameConfirm();
              if (e.key === 'Escape') handleRenameCancel();
            }}
            onBlur={handleRenameConfirm}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-text-primary leading-snug font-normal
              flex-1 min-w-0 bg-bg-secondary border border-border-focus rounded-md
              px-1.5 py-0.5 outline-none"
          />
        ) : (
          <div className={`text-xs truncate leading-snug font-normal flex-1 min-w-0
            ${name ? 'text-text-primary' : 'text-text-muted italic'}
            ${titleAnimating ? 'animate-title-update' : ''}`}>
            {isPinned && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                className="inline-block mr-1 -mt-0.5 text-accent">
                <path d="M9.5 2L14 6.5L8.5 12L6 14L4.5 11.5L2 9.5L4 7.5L9.5 2z" />
              </svg>
            )}
            {name || (session.path === '' ? t('conv.newChat') : t('conv.empty'))}
          </div>
        )}
        <span className="text-[10px] text-text-tertiary flex-shrink-0">
          {formatSessionTime(session.modifiedAt, tStatic)}
        </span>
        {isRunning && (
          <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-success
            animate-pulse-soft" />
        )}
      </div>
      {contentSnippet && (
        <div className="flex gap-1 mt-px text-[10px] text-text-muted leading-relaxed">
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            className="flex-shrink-0 mt-[3px] text-accent/40">
            <circle cx="7" cy="7" r="5" />
            <path d="M14 14l-3-3" />
          </svg>
          <div className="min-w-0">
            {matchCount != null && matchCount > 1 && (
              <span className="text-accent/60 font-medium mr-1">{matchCount}x</span>
            )}
            <HighlightedSnippet text={contentSnippet} query={searchQuery || ''} />
          </div>
        </div>
      )}
    </button>
  );
}
