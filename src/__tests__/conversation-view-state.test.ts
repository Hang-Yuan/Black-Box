import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearConversationViewStateForTests,
  loadChatScrollPosition,
  loadConversationPanelState,
  loadFileScrollPosition,
  loadFileTreeScrollPosition,
  moveConversationViewState,
  saveChatScrollPosition,
  saveConversationPanelState,
  saveFileScrollPosition,
  saveFileTreeScrollPosition,
} from '../lib/conversation-view-state';
import {
  restoreConversationFileState,
  saveConversationFileState,
  moveConversationFileState,
  switchConversationFileState,
  useFileStore,
} from '../stores/fileStore';
import { useSettingsStore } from '../stores/settingsStore';

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
    useSettingsStore.setState({
      secondaryPanelOpen: false,
      secondaryPanelTab: 'files',
      secondaryPanelWidth: 300,
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

  it('keeps the right panel open state, tab, and width per conversation', () => {
    saveConversationPanelState('session-a', { open: true, tab: 'activity', width: 420 });
    saveConversationPanelState('session-b', { open: false, tab: 'files', width: 300 });
    expect(loadConversationPanelState('session-a')).toEqual({
      open: true,
      tab: 'activity',
      width: 420,
    });
    expect(loadConversationPanelState('session-b')).toEqual({
      open: false,
      tab: 'files',
      width: 300,
    });
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
    useSettingsStore.setState({
      secondaryPanelOpen: true,
      secondaryPanelTab: 'activity',
      secondaryPanelWidth: 410,
    });
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

    useSettingsStore.setState({
      secondaryPanelOpen: false,
      secondaryPanelTab: 'files',
      secondaryPanelWidth: 320,
    });
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
    expect(useSettingsStore.getState()).toMatchObject({
      secondaryPanelOpen: true,
      secondaryPanelTab: 'activity',
      secondaryPanelWidth: 410,
    });
  });

  it('starts a fresh conversation without leaking or deleting the source preview', () => {
    useFileStore.setState({
      selectedFile: '/tmp/project-a/report.md',
      fileContent: 'source document',
      previewMode: 'preview',
      editContent: null,
      revealTarget: '/tmp/project-a/report.md',
      rootPath: '/tmp/project-a',
      expandedFolders: new Set(['/tmp/project-a/docs']),
    });

    switchConversationFileState('session-a', 'draft-new');
    expect(useFileStore.getState().selectedFile).toBeNull();

    // Closing the empty draft must not overwrite session-a's saved document.
    useFileStore.getState().closePreview();
    switchConversationFileState('draft-new', 'session-a');
    expect(useFileStore.getState()).toMatchObject({
      selectedFile: '/tmp/project-a/report.md',
      fileContent: 'source document',
      rootPath: '/tmp/project-a',
    });
    expect(Array.from(useFileStore.getState().expandedFolders)).toEqual([
      '/tmp/project-a/docs',
    ]);
  });

  it('moves every reading surface from a draft id to its durable session id', () => {
    saveChatScrollPosition('draft-a', { top: 720, atBottom: false });
    saveFileScrollPosition('draft-a', '/tmp/report.md', 'preview', 380);
    saveFileTreeScrollPosition('draft-a', '/tmp/project', 144);
    saveConversationPanelState('draft-a', { open: true, tab: 'files', width: 440 });
    useFileStore.setState({
      selectedFile: '/tmp/report.md',
      fileContent: '# report',
      previewMode: 'preview',
      editContent: null,
      revealTarget: '/tmp/report.md',
      rootPath: '/tmp/project',
      expandedFolders: new Set(['/tmp/project/docs']),
    });
    saveConversationFileState('draft-a');

    moveConversationFileState('draft-a', 'session-real');

    expect(loadChatScrollPosition('session-real')).toEqual({ top: 720, atBottom: false });
    expect(loadFileScrollPosition('session-real', '/tmp/report.md', 'preview')).toBe(380);
    expect(loadFileTreeScrollPosition('session-real', '/tmp/project')).toBe(144);
    expect(loadConversationPanelState('session-real')).toEqual({
      open: true,
      tab: 'files',
      width: 440,
    });
    restoreConversationFileState('session-real');
    expect(useFileStore.getState().selectedFile).toBe('/tmp/report.md');
    expect(useFileStore.getState().rootPath).toBe('/tmp/project');

    // The lower-level mover is idempotent for callers that only own view maps.
    moveConversationViewState('session-real', 'session-real');
    expect(loadChatScrollPosition('session-real')?.top).toBe(720);
  });
});
