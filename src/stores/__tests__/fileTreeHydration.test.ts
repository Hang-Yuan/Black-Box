import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../lib/tauri-bridge';
import { hydrateFolderChildren } from '../fileTreeHydration';

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
});
