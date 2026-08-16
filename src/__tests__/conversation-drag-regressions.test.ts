import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('conversation drag-and-drop regressions', () => {
  const list = source('components/conversations/ConversationList.tsx');
  const workspace = source('components/conversations/SessionGroup.tsx');
  const taskGroup = source('components/conversations/TaskGroup.tsx');
  const sortableItem = source('components/conversations/SortableSessionItem.tsx');
  const store = source('stores/groupStore.ts');

  it('supports group-to-group, in-group, and ungrouped drops through one ledger action', () => {
    expect(workspace).toContain('onMoveSession(activeId, targetGroup.group.id, beforeSessionId)');
    expect(workspace).toContain('onMoveSession(activeId, null)');
    expect(list).toContain('useGroupStore.getState().moveSession(');
    expect(store).toContain('moveSession: (sessionId, targetGroupId, beforeSessionId) =>');
  });

  it('keeps conversation drag handles explicit and preserves ordinary row interactions', () => {
    expect(sortableItem).toContain('setActivatorNodeRef');
    expect(sortableItem).toContain('title="拖动对话"');
    expect(sortableItem).toContain('<SessionItem {...sessionItemProps} />');
    expect(taskGroup).toContain('<SortableSessionItem');
    expect(workspace).toContain('<SortableSessionItem');
  });

  it('makes ungrouped a visible detach target inside the active DndContext', () => {
    expect(workspace.indexOf('<DndContext')).toBeLessThan(workspace.indexOf('<UngroupedDropZone'));
    expect(workspace).toContain('拖到这里移出分组');
    expect(workspace).toContain('useDroppable({');
  });

  it('disables conversation moves for archive, search projections, and multi-select', () => {
    expect(list).toContain("conversationView === 'active' && !multiSelect && !searchQuery.trim()");
    expect(workspace).toContain('disabled: !enabled');
    expect(sortableItem).toContain('disabled: !dragEnabled');
    expect(taskGroup).toContain('dragEnabled={sessionDragEnabled}');
  });
});
