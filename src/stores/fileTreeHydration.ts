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

function sameNodeShell(left: FileNode, right: FileNode): boolean {
  return left.name === right.name
    && left.path === right.path
    && left.is_dir === right.is_dir
    && left.children_truncated === right.children_truncated;
}

/**
 * Reconcile a fresh shallow directory scan with the rendered tree.
 *
 * `readFileTree(path, 0)` deliberately returns directories as truncated
 * placeholders. Replacing the rendered nodes with those placeholders makes
 * every expanded directory disappear and hydrate again whenever the watcher
 * sees a create/remove event. Preserve already-hydrated descendants and reuse
 * unchanged node identities so structural refreshes do not flash the panel.
 */
export function reconcileFileTree(
  current: FileNode[],
  incoming: FileNode[],
): FileNode[] {
  const currentByPath = new Map(current.map((node) => [node.path, node]));
  let changed = current.length !== incoming.length;

  const next = incoming.map((fresh, index) => {
    const existing = currentByPath.get(fresh.path);
    if (!existing || existing.is_dir !== fresh.is_dir) {
      changed = true;
      return fresh;
    }

    let candidate = fresh;
    if (
      fresh.is_dir
      && fresh.children_truncated
      && existing.children_truncated === false
    ) {
      candidate = {
        ...fresh,
        children: existing.children,
        children_truncated: false,
      };
    }

    const sameDeferredChildren = candidate.is_dir
      && candidate.children_truncated === true
      && existing.children_truncated === true
      && (candidate.children?.length ?? 0) === 0
      && (existing.children?.length ?? 0) === 0;
    if (
      sameNodeShell(existing, candidate)
      && (existing.children === candidate.children || sameDeferredChildren)
    ) {
      if (current[index] !== existing) changed = true;
      return existing;
    }

    changed = true;
    return candidate;
  });

  return changed ? next : current;
}
