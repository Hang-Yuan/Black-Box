import type { FileNode } from '../lib/tauri-bridge';

/**
 * Replace one lazily truncated folder with a freshly scanned subtree while
 * preserving object identity everywhere else. This keeps large workspaces
 * bounded on first load but removes any visible nesting limit.
 */
export function hydrateFolderChildren(
  nodes: FileNode[],
  folderPath: string,
  children: FileNode[],
): FileNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.path === folderPath && node.is_dir) {
      changed = true;
      return { ...node, children, children_truncated: false };
    }
    if (!node.children?.length) return node;
    const hydratedChildren = hydrateFolderChildren(node.children, folderPath, children);
    if (hydratedChildren === node.children) return node;
    changed = true;
    return { ...node, children: hydratedChildren };
  });
  return changed ? next : nodes;
}
