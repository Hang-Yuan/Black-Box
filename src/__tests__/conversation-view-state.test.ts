import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearConversationViewStateForTests,
  loadChatScrollPosition,
  loadFileScrollPosition,
  saveChatScrollPosition,
  saveFileScrollPosition,
} from '../lib/conversation-view-state';
import { useFileStore } from '../stores/fileStore';

describe('conversation reading position', () => {
  beforeEach(clearConversationViewStateForTests);

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
});
