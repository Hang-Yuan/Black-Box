import type { ComponentProps } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SessionItem } from './SessionItem';

type SessionItemProps = ComponentProps<typeof SessionItem>;

interface SortableSessionItemProps extends SessionItemProps {
  dragEnabled: boolean;
  groupId: string | null;
}

/**
 * Adds a small, explicit drag handle around an ordinary conversation row.
 * Keeping the activator separate preserves click-to-open, double-click rename,
 * context menus, and multi-select semantics on SessionItem itself.
 */
export function SortableSessionItem({
  dragEnabled,
  groupId,
  ...sessionItemProps
}: SortableSessionItemProps) {
  const { session } = sessionItemProps;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: session.id,
    disabled: !dragEnabled,
    data: { kind: 'session', sessionId: session.id, groupId },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`relative group/session-drag ${isDragging ? 'z-20 opacity-65' : ''}`}
      data-session-drag-id={session.id}
    >
      <SessionItem {...sessionItemProps} />
      {dragEnabled && (
        <span
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
          className={`absolute left-1 top-1/2 z-10 -translate-y-1/2 touch-none select-none
            cursor-grab rounded-sm p-0.5 text-text-tertiary/70 transition-opacity
            hover:text-text-primary active:cursor-grabbing
            ${isDragging
              ? 'opacity-100'
              : 'opacity-0 group-hover/session-drag:opacity-100 focus:opacity-100'}`}
          title="拖动对话"
          aria-label={`拖动对话：${sessionItemProps.displayName || session.preview}`}
        >
          <svg width="7" height="11" viewBox="0 0 7 11" fill="currentColor" aria-hidden>
            <circle cx="1.5" cy="1.5" r="1" />
            <circle cx="5.5" cy="1.5" r="1" />
            <circle cx="1.5" cy="5.5" r="1" />
            <circle cx="5.5" cy="5.5" r="1" />
            <circle cx="1.5" cy="9.5" r="1" />
            <circle cx="5.5" cy="9.5" r="1" />
          </svg>
        </span>
      )}
    </div>
  );
}
