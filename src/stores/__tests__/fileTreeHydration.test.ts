import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../lib/tauri-bridge';
import { hydrateFolderChildren, reconcileFileTree } from '../fileTreeHydration';

function dir(path: string, children: FileNode[] = [], truncated = false): FileNode {
  return {
    name: path.split('/').pop() || path,
    path,
    is_dir: true,
    children,
    children_truncated: truncated,
  };
}

describe('file-tree lazy depth hydration', () => {
  it('extends a truncated tree beyond ten levels without rebuilding its ancestors', () => {
    let tree: FileNode[] = [dir('/root/l0', [], true)];
    for (let depth = 0; depth < 11; depth += 1) {
      const parent = `/root/${Array.from({ length: depth + 1 }, (_, i) => `l${i}`).join('/')}`;
      const childPath = `${parent}/l${depth + 1}`;
      tree = hydrateFolderChildren(tree, parent, [dir(childPath, [], depth < 10)]);
    }
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('l11');
    expect(serialized).not.toContain('"children_truncated":true');
  });

  it('returns the original tree when the target folder is no longer present', () => {
    const tree = [dir('/root/kept')];
    expect(hydrateFolderChildren(tree, '/root/missing', [])).toBe(tree);
  });

  it('keeps hydrated descendants and stable identities during a shallow refresh', () => {
    const loadedChild = { name: 'note.md', path: '/root/Dev/note.md', is_dir: false, children: null };
    const loadedFolder = dir('/root/Dev', [loadedChild], false);
    const current = [loadedFolder, { name: 'README.md', path: '/root/README.md', is_dir: false, children: null }];
    const incoming = [dir('/root/Dev', [], true), current[1]];

    const reconciled = reconcileFileTree(current, incoming);

    expect(reconciled).toBe(current);
    expect(reconciled[0]).toBe(loadedFolder);
    expect(reconciled[0].children).toEqual([loadedChild]);
    expect(reconciled[0].children_truncated).toBe(false);
  });

  it('adds and removes shallow entries without discarding hydrated siblings', () => {
    const loadedFolder = dir('/root/Dev', [dir('/root/Dev/app', [], true)], false);
    const removed = { name: 'old.md', path: '/root/old.md', is_dir: false, children: null };
    const added = { name: 'new.md', path: '/root/new.md', is_dir: false, children: null };

    const reconciled = reconcileFileTree(
      [loadedFolder, removed],
      [dir('/root/Dev', [], true), added],
    );

    expect(reconciled).toEqual([loadedFolder, added]);
    expect(reconciled[0]).toBe(loadedFolder);
  });

  it('returns the original tree for an identical fresh shallow snapshot', () => {
    const current = [
      dir('/root/Dev', [], true),
      { name: 'README.md', path: '/root/README.md', is_dir: false, children: null },
    ];
    const incoming = [
      dir('/root/Dev', [], true),
      { name: 'README.md', path: '/root/README.md', is_dir: false, children: null },
    ];

    expect(reconcileFileTree(current, incoming)).toBe(current);
  });
});
