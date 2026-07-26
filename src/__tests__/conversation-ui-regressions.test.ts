import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('conversation archive regressions', () => {
  const list = source('components/conversations/ConversationList.tsx');
  const group = source('components/conversations/SessionGroup.tsx');
  const taskGroup = source('components/conversations/TaskGroup.tsx');

  it('provides a first-class active/archive switch and archive/restore action', () => {
    expect(list).toContain('data-testid="conversation-view-toggle"');
    expect(list).toContain('handleToggleArchive');
    expect(list).toContain('handleBatchArchive');
    expect(list).toContain('groupsForConversationView');
  });

  it('preserves task groups in read-only history and starts them collapsed', () => {
    expect(list).toContain('setArchiveExpandedGroups(new Set())');
    expect(list).toContain("readOnly={conversationView === 'archived'}");
    expect(group).toContain('readOnly={readOnly}');
    expect(taskGroup).toContain('useSortable({ id: group.id, disabled: readOnly })');
    expect(group).toContain("{!readOnly && (\n          <span className=\"text-[10px]");
    expect(taskGroup).toContain("{!readOnly && (\n          <span className=\"text-[11px]");
  });

  it('shows only the leaf workspace name without parent hints or duplicate paths', () => {
    expect(list).toContain('export function projectLabel(project: string)');
    expect(list).not.toContain('parentHint');
    expect(list).not.toContain('isDuplicate');
    expect(group).not.toContain('projectPath');
  });
});

describe('compact switch geometry', () => {
  const agents = source('components/agents/AgentPanel.tsx');
  const automations = source('components/settings/AutomationsTab.tsx');

  it('anchors the knob before translating it by the exact inner-track width', () => {
    for (const ui of [agents, automations]) {
      expect(ui).toContain('absolute left-0.5 top-0.5 h-4 w-4');
      expect(ui).toContain('translateX(${');
      expect(ui).toContain('? 16 : 0}px)');
      expect(ui).not.toContain('translate-x-[18px]');
    }
  });
});

describe('top status model and unbounded visible file depth', () => {
  const chat = source('components/chat/ChatPanel.tsx');
  const modelSelector = source('components/chat/ModelSelector.tsx');
  const explorer = source('components/files/FileExplorer.tsx');
  const store = source('stores/fileStore.ts');

  it('shows the resolved concrete model in the header', () => {
    expect(chat).toContain('data-testid="current-resolved-model"');
    expect(chat).toContain('getResolvedModelDisplayName(resolvedHeaderModel)');
    expect(chat).toContain('<ProviderQuickSelector compact={secondaryPanelOpen} />');
    expect(chat).not.toContain('workingDirectory.split(/[\\\\/]/).pop()');
    expect(chat.indexOf('data-testid="current-resolved-model"'))
      .toBeLessThan(chat.indexOf('title={t(\'agents.toggle\')}'));
  });

  it('keeps the right-side controls compact at the minimum supported window width', () => {
    for (const path of [
      'components/chat/WorkflowControl.tsx',
      'components/chat/LoopControl.tsx',
      'components/chat/GoalControl.tsx',
    ]) {
      expect(source(path)).toContain('max-[1040px]:hidden');
      expect(source(path)).toContain('hidden max-[1040px]:inline');
    }
  });

  it('keeps the main/auxiliary model menu exclusive with every top-level popover', () => {
    expect(modelSelector).toContain("subscribeHeaderPopover('model'");
    expect(modelSelector).toContain("announceHeaderPopover('model')");
    expect(modelSelector).toContain('data-testid\': \'model-menu');
    expect(modelSelector).toContain('aria-haspopup="menu"');
  });

  it('hydrates a truncated folder whenever the user expands it', () => {
    expect(explorer).toContain('node.children_truncated');
    expect(explorer).toContain('loadFolderChildren(node.path)');
    expect(store).toContain('hydrateFolderChildren(get().tree, path, children)');
  });

  it('searches the full workspace independently of the currently hydrated tree', () => {
    const bridge = source('lib/tauri-bridge.ts');
    const backend = source('../src-tauri/src/lib.rs');
    expect(explorer).toContain('bridge.searchFileTree(searchRoot, query, showHiddenFiles, 200)');
    expect(explorer).not.toContain('collectMatches(filteredTree');
    expect(explorer).toContain('void openFileReference(node.path)');
    expect(explorer).toContain('deepSearch.skipped_directories > 0');
    expect(bridge).toContain("invoke<FileSearchResponse>('search_file_tree'");
    expect(backend).toContain('fn search_file_tree_recursive(');
    expect(backend).toContain('FILE_SEARCH_ENTRY_LIMIT');
    expect(backend).toContain('file_type.is_dir()');
  });

  it('keeps multiline structure trees as code and previews directory landing files', () => {
    const reveal = source('stores/fileReveal.ts');
    const store = source('stores/fileStore.ts');
    expect(reveal).toContain("if (!raw || /[\\r\\n]/.test(raw)) return null");
    expect(store).toContain('findUniqueNodeByBasename(get().tree, target)');
    expect(store).toContain('const landingFile = findDirectoryLandingFile(targetNode)');
    expect(store).toContain('await get().selectFile(landingFile.path, location)');
    expect(store).toContain("if (parsed.kind === 'folder') return true");
  });

  it('keeps task groups in a viewport-aware submenu instead of stretching the main menu', () => {
    const menu = source('components/conversations/SessionContextMenu.tsx');
    expect(menu).toContain('data-testid="session-group-submenu-trigger"');
    expect(menu).toContain('data-testid="session-group-submenu"');
    expect(menu).toContain('placeContextMenu(');
    expect(menu).toContain('placeSubmenu(');
    expect(menu).toContain("maxHeight: 'calc(100vh - 16px)'");
    expect(menu.indexOf('data-testid="session-group-submenu-trigger"'))
      .toBeLessThan(menu.indexOf("{t('conv.delete')}"));
  });
});
