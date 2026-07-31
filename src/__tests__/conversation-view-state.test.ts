import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearConversationViewStateForTests,
  loadChatScrollPosition,
  loadFileScrollPosition,
  loadFileTreeScrollPosition,
  saveChatScrollPosition,
  saveFileScrollPosition,
  saveFileTreeScrollPosition,
} from '../lib/conversation-view-state';
import {
  restoreConversationFileState,
  saveConversationFileState,
  useFileStore,
} from '../stores/fileStore';

describe('conversation reading position', () => {
  beforeEach(() => {
    clearConversationViewStateForTests();
    useFileStore.setState({
      rootPath: '',
      tree: [],
      expandedFolders: new Set(),
      loadingFolders: new Set(),
      previewSnapshots: {},
      explorerSnapshots: {},
    });
  });

  it('keeps independent chat positions for each conversation', () => {
    saveChatScrollPosition('session-a', { top: 420, atBottom: false });
    saveChatScrollPosition('session-b', { top: 0, atBottom: true });
    expect(loadChatScrollPosition('session-a')).toEqual({ top: 420, atBottom: false });
    expect(loadChatScrollPosition('session-b')).toEqual({ top: 0, atBottom: true });
  });

  it('keeps file positions scoped by conversation, file, and mode', () => {
    saveFileScrollPosition('session-a', '/tmp/report.md', 'preview', 360);
    saveFileScrollPosition('session-a', '/tmp/report.md', 'source', 48);
    saveFileScrollPosition('session-b', '/tmp/report.md', 'preview', 900);
    expect(loadFileScrollPosition('session-a', '/tmp/report.md', 'preview')).toBe(360);
    expect(loadFileScrollPosition('session-a', '/tmp/report.md', 'source')).toBe(48);
    expect(loadFileScrollPosition('session-b', '/tmp/report.md', 'preview')).toBe(900);
  });

  it('keeps file-tree positions scoped by conversation and project root', () => {
    saveFileTreeScrollPosition('session-a', '/tmp/project', 680);
    saveFileTreeScrollPosition('session-b', '/tmp/project', 120);
    saveFileTreeScrollPosition('session-a', '/tmp/other', 42);
    expect(loadFileTreeScrollPosition('session-a', '/tmp/project')).toBe(680);
    expect(loadFileTreeScrollPosition('session-b', '/tmp/project')).toBe(120);
    expect(loadFileTreeScrollPosition('session-a', '/tmp/other')).toBe(42);
  });

  it('restores each conversation open document and unsaved edit buffer', () => {
    useFileStore.setState({
      selectedFile: '/tmp/report.md',
      fileContent: '# original',
      previewMode: 'edit',
      previewLocation: { line: 12, requestId: 1 },
      editContent: '# unsaved',
      revealTarget: '/tmp/report.md',
      previewSnapshots: {},
    });
    useFileStore.getState().savePreviewState('session-a');

    useFileStore.setState({
      selectedFile: '/tmp/other.md',
      fileContent: '# other',
      previewMode: 'preview',
      previewLocation: null,
      editContent: null,
      revealTarget: '/tmp/other.md',
    });
    useFileStore.getState().savePreviewState('session-b');

    useFileStore.getState().restorePreviewState('session-a');
    expect(useFileStore.getState()).toMatchObject({
      selectedFile: '/tmp/report.md',
      fileContent: '# original',
      previewMode: 'edit',
      previewLocation: null,
      editContent: '# unsaved',
      revealTarget: '/tmp/report.md',
    });

    useFileStore.getState().restorePreviewState('session-b');
    expect(useFileStore.getState()).toMatchObject({
      selectedFile: '/tmp/other.md',
      fileContent: '# other',
      previewMode: 'preview',
      previewLocation: null,
      editContent: null,
      revealTarget: '/tmp/other.md',
    });
  });

  it('restores each conversation file-tree root and expanded folders', () => {
    useFileStore.setState({
      rootPath: '/tmp/project-a',
      expandedFolders: new Set(['/tmp/project-a/docs', '/tmp/project-a/src']),
      explorerSnapshots: {},
    });
    useFileStore.getState().saveExplorerState('session-a');

    useFileStore.setState({
      rootPath: '/tmp/project-b',
      expandedFolders: new Set(['/tmp/project-b/research']),
    });
    useFileStore.getState().saveExplorerState('session-b');

    useFileStore.getState().restoreExplorerState('session-a');
    expect(useFileStore.getState().rootPath).toBe('/tmp/project-a');
    expect(Array.from(useFileStore.getState().expandedFolders)).toEqual([
      '/tmp/project-a/docs',
      '/tmp/project-a/src',
    ]);

    useFileStore.getState().restoreExplorerState('session-b');
    expect(useFileStore.getState().rootPath).toBe('/tmp/project-b');
    expect(Array.from(useFileStore.getState().expandedFolders)).toEqual([
      '/tmp/project-b/research',
    ]);
  });

  it('switches preview and explorer state as one conversation transaction', () => {
    useFileStore.setState({
      selectedFile: '/tmp/project-a/report.md',
      fileContent: 'draft A',
      previewMode: 'edit',
      editContent: 'draft A edited',
      revealTarget: '/tmp/project-a/report.md',
      rootPath: '/tmp/project-a',
      expandedFolders: new Set(['/tmp/project-a/docs']),
    });
    saveConversationFileState('session-a');

    useFileStore.setState({
      selectedFile: '/tmp/project-b/notes.md',
      fileContent: 'notes B',
      previewMode: 'preview',
      editContent: null,
      revealTarget: '/tmp/project-b/notes.md',
      rootPath: '/tmp/project-b',
      expandedFolders: new Set(['/tmp/project-b/src']),
    });
    saveConversationFileState('session-b');

    restoreConversationFileState('session-a');
    expect(useFileStore.getState().selectedFile).toBe('/tmp/project-a/report.md');
    expect(useFileStore.getState().editContent).toBe('draft A edited');
    expect(useFileStore.getState().rootPath).toBe('/tmp/project-a');
    expect(Array.from(useFileStore.getState().expandedFolders)).toEqual([
      '/tmp/project-a/docs',
    ]);
  });
});
