import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  readFileTree: vi.fn(),
  getFileSize: vi.fn(),
  readFileContent: vi.fn(),
  searchFileTree: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import { FILE_TREE_READ_DEPTH, useFileStore } from '../fileStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('file tree bounded loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileStore.setState({
      tree: [],
      rootPath: '',
      isLoading: false,
      directoryMissing: false,
      expandedFolders: new Set(),
      loadingFolders: new Set(),
    });
  });

  it('loads only one directory level for roots and expanded folders', async () => {
    bridgeMock.readFileTree.mockResolvedValue([]);

    await useFileStore.getState().loadTree('/workspace');
    await useFileStore.getState().loadFolderChildren('/workspace/Dev');

    expect(FILE_TREE_READ_DEPTH).toBe(0);
    expect(bridgeMock.readFileTree).toHaveBeenNthCalledWith(1, '/workspace', 0);
    expect(bridgeMock.readFileTree).toHaveBeenNthCalledWith(2, '/workspace/Dev', 0);
  });

  it('coalesces concurrent reads of the same root', async () => {
    const read = deferred<[]>();
    bridgeMock.readFileTree.mockReturnValue(read.promise);

    const initial = useFileStore.getState().loadTree('/workspace');
    const refresh = useFileStore.getState().refreshTree();
    expect(bridgeMock.readFileTree).toHaveBeenCalledTimes(1);

    read.resolve([]);
    await Promise.all([initial, refresh]);
    expect(useFileStore.getState()).toMatchObject({
      rootPath: '/workspace',
      isLoading: false,
      directoryMissing: false,
    });
  });

  it('keeps a hydrated tree visible when the same file panel remounts', async () => {
    const loadedFolder = {
      name: 'Dev',
      path: '/workspace/Dev',
      is_dir: true,
      children: [{ name: 'note.md', path: '/workspace/Dev/note.md', is_dir: false, children: null }],
      children_truncated: false,
    };
    useFileStore.setState({ rootPath: '/workspace', tree: [loadedFolder] });
    const read = deferred<Array<{ name: string; path: string; is_dir: boolean; children: never[]; children_truncated: boolean }>>();
    bridgeMock.readFileTree.mockReturnValue(read.promise);

    const loading = useFileStore.getState().loadTree('/workspace');
    expect(useFileStore.getState().isLoading).toBe(false);
    expect(useFileStore.getState().tree[0]).toBe(loadedFolder);

    read.resolve([{
      name: 'Dev',
      path: '/workspace/Dev',
      is_dir: true,
      children: [],
      children_truncated: true,
    }]);
    await loading;

    expect(useFileStore.getState().tree[0]).toBe(loadedFolder);
  });

  it('discards a late tree result after the root changes', async () => {
    const first = deferred<Array<{ name: string; path: string; is_dir: boolean }>>();
    const second = deferred<Array<{ name: string; path: string; is_dir: boolean }>>();
    bridgeMock.readFileTree
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const loadingFirst = useFileStore.getState().loadTree('/first');
    const loadingSecond = useFileStore.getState().loadTree('/second');
    second.resolve([{ name: 'current', path: '/second/current', is_dir: false }]);
    await loadingSecond;
    first.resolve([{ name: 'stale', path: '/first/stale', is_dir: false }]);
    await loadingFirst;

    expect(useFileStore.getState().rootPath).toBe('/second');
    expect(useFileStore.getState().tree).toEqual([
      { name: 'current', path: '/second/current', is_dir: false },
    ]);
  });

  it('refreshes only the visible parent affected by a structural event', async () => {
    const nestedFile = { name: 'old.md', path: '/workspace/Dev/old.md', is_dir: false, children: null };
    useFileStore.setState({
      rootPath: '/workspace',
      tree: [{
        name: 'Dev',
        path: '/workspace/Dev',
        is_dir: true,
        children: [nestedFile],
        children_truncated: false,
      }],
    });
    const added = { name: 'new.md', path: '/workspace/Dev/new.md', is_dir: false, children: null };
    bridgeMock.readFileTree.mockResolvedValue([nestedFile, added]);

    await useFileStore.getState().refreshChangedPaths(['/workspace/Dev/new.md']);

    expect(bridgeMock.readFileTree).toHaveBeenCalledWith('/workspace/Dev', 0);
    expect(useFileStore.getState().tree[0].children).toEqual([nestedFile, added]);
    expect(useFileStore.getState().loadingFolders.size).toBe(0);
  });

  it('does not scan an unexpanded parent after a structural event', async () => {
    useFileStore.setState({
      rootPath: '/workspace',
      tree: [{
        name: 'Dev',
        path: '/workspace/Dev',
        is_dir: true,
        children: [],
        children_truncated: true,
      }],
    });

    await useFileStore.getState().refreshChangedPaths(['/workspace/Dev/new.md']);

    expect(bridgeMock.readFileTree).not.toHaveBeenCalled();
  });

  it('opens an exact cwd-resolved file without a workspace-wide search', async () => {
    bridgeMock.readFileTree.mockResolvedValue([]);
    bridgeMock.getFileSize.mockResolvedValue(4096);
    bridgeMock.readFileContent.mockRejectedValue(new Error('binary file'));

    const opened = await useFileStore.getState().openFileReference({
      raw: 'q-01-袁黎明问卷.xlsx',
      displayPath: 'q-01-袁黎明问卷.xlsx',
      path: '/workspace/streams/08-l3-cells-draft/q-01-袁黎明问卷.xlsx',
      kind: 'file',
    }, '/workspace');

    expect(opened).toBe(true);
    expect(bridgeMock.getFileSize).toHaveBeenCalledWith(
      '/workspace/streams/08-l3-cells-draft/q-01-袁黎明问卷.xlsx',
    );
    expect(bridgeMock.searchFileTree).not.toHaveBeenCalled();
    expect(useFileStore.getState().selectedFile).toBe(
      '/workspace/streams/08-l3-cells-draft/q-01-袁黎明问卷.xlsx',
    );
  });
});
