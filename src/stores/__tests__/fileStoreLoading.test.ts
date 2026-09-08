import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  readFileTree: vi.fn(),
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
});
