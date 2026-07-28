import { create } from 'zustand';
import { bridge, FileNode, RecentProject } from '../lib/tauri-bridge';
import {
  computeRevealExpansions,
  DIRECTORY_LANDING_FILE_NAMES,
  findBestWorkspaceSearchMatch,
  findDirectoryLandingFile,
  findNodeByPath,
  findUniqueNodeByBasename,
  normalizeFileReferencePath,
  parseFileReference,
  reconcilePathToRoot,
  type FileReferenceLocation,
  type ParsedFileReference,
} from './fileReveal';
import { hydrateFolderChildren } from './fileTreeHydration';

export type FileChangeKind = 'created' | 'modified' | 'removed';
export type PreviewMode = 'preview' | 'source' | 'edit';

export interface FilePreviewLocation extends FileReferenceLocation {
  /** Makes repeated clicks on the same location observable by the preview. */
  requestId: number;
}

interface PendingFileNavigation {
  path: string;
  location?: FileReferenceLocation;
}

interface FilePreviewSnapshot {
  selectedFile: string;
  fileContent: string | null;
  previewMode: PreviewMode;
  editContent: string | null;
  revealTarget: string | null;
}

// Batch buffer for markFileChanged — collect changes within a single frame, flush once via rAF
const _pendingChanges = new Map<string, FileChangeKind>();
let _changeFlushRaf = 0;
let _previewLocationRequestId = 0;
const _folderLoadPromises = new Map<string, Promise<void>>();

interface FileState {
  tree: FileNode[];
  isLoading: boolean;
  selectedFile: string | null;
  fileContent: string | null;
  isLoadingContent: boolean;
  previewMode: PreviewMode;
  previewLocation: FilePreviewLocation | null;
  rootPath: string;

  // 文件树展开状态（提到全局：让「聊天点击路径 → 定位」能驱动文件树展开）
  expandedFolders: Set<string>;
  loadingFolders: Set<string>;
  // 当前被定位高亮的路径（文件或文件夹，与「预览选中」解耦）
  revealTarget: string | null;
  previewSnapshots: Record<string, FilePreviewSnapshot>;

  // Editing state
  editContent: string | null;     // buffer for edits (null = not dirty)
  isSaving: boolean;

  // Unsaved changes navigation guard
  pendingNavigation: PendingFileNavigation | null;
  showUnsavedDialog: boolean;

  // Project management
  recentProjects: RecentProject[];
  isLoadingProjects: boolean;

  // File change tracking
  changedFiles: Map<string, FileChangeKind>;

  // Directory missing detection
  directoryMissing: boolean;

  // External drag-drop state
  isDragOverTree: boolean;

  loadTree: (path: string) => Promise<void>;
  /** Refresh the tree without clearing change markers. Optional path overrides rootPath. */
  refreshTree: (overridePath?: string) => Promise<void>;
  selectFile: (path: string, location?: FileReferenceLocation) => Promise<void>;
  clearSelection: () => void;
  closePreview: () => void;
  savePreviewState: (sessionId: string) => void;
  restorePreviewState: (sessionId: string) => void;
  setPreviewMode: (mode: PreviewMode) => void;
  setEditContent: (content: string) => void;
  saveFile: () => Promise<void>;
  discardEdits: () => void;
  setRootPath: (path: string) => void;
  fetchRecentProjects: () => Promise<void>;
  /** Reload the currently previewed file content without toggling selection */
  reloadContent: () => Promise<void>;
  markFileChanged: (path: string, kind: FileChangeKind) => void;
  clearChangedFiles: () => void;
  // Unsaved changes actions
  confirmDiscard: () => void;
  confirmSaveAndSwitch: () => Promise<void>;
  cancelNavigation: () => void;
  // New file/folder actions
  createFile: (parentDir: string, name: string) => Promise<void>;
  createFolder: (parentDir: string, name: string) => Promise<void>;
  // External drag state
  setDragOverTree: (v: boolean) => void;
  // 展开/折叠单个文件夹
  toggleFolder: (path: string) => void;
  /** Hydrate a backend depth-boundary folder on demand. */
  loadFolderChildren: (path: string) => Promise<void>;
  /** Expand, select and preview a local reference from chat/Markdown. */
  openFileReference: (
    reference: ParsedFileReference | string,
    rootHint?: string,
  ) => Promise<boolean>;
  // 定位到某路径：展开其所有父目录（文件夹则连自身）并高亮
  revealPath: (path: string) => void;
}

export const useFileStore = create<FileState>()((set, get) => ({
  tree: [],
  isLoading: false,
  selectedFile: null,
  fileContent: null,
  isLoadingContent: false,
  previewMode: 'preview' as PreviewMode,
  previewLocation: null,
  rootPath: '',
  editContent: null,
  isSaving: false,
  pendingNavigation: null,
  showUnsavedDialog: false,
  recentProjects: [],
  isLoadingProjects: false,
  changedFiles: new Map(),
  directoryMissing: false,
  isDragOverTree: false,
  expandedFolders: new Set<string>(),
  loadingFolders: new Set<string>(),
  revealTarget: null,
  previewSnapshots: {},

  loadTree: async (path: string) => {
    if (!path) return;
    const prevRoot = get().rootPath;
    const isNewDir = path !== prevRoot;
    // Always show loading on first load or directory change
    set({
      rootPath: path,
      isLoading: true,
      // Clear stale tree immediately when switching directories
      ...(isNewDir ? { tree: [], expandedFolders: new Set<string>(), loadingFolders: new Set<string>() } : {}),
    });
    try {
      const tree = await bridge.readFileTree(path, 8);
      // Guard: only apply if rootPath hasn't changed during async load
      if (get().rootPath === path) {
        set({ tree, isLoading: false, changedFiles: new Map(), directoryMissing: false });
      }
    } catch (err) {
      if (get().rootPath === path) {
        const missing = String(err).includes('does not exist');
        set({ isLoading: false, directoryMissing: missing });
      }
    }
  },

  refreshTree: async (overridePath?: string) => {
    const dir = overridePath || get().rootPath;
    if (!dir) return;
    try {
      const tree = await bridge.readFileTree(dir, 8);
      // Sync rootPath if override was used and differs
      if (overridePath && overridePath !== get().rootPath) {
        set({ tree, rootPath: overridePath });
      } else {
        set({ tree });
      }
    } catch (err) {
      if (String(err).includes('does not exist')) {
        set({ directoryMissing: true, tree: [] });
      }
    }
  },

  selectFile: async (path: string, location?: FileReferenceLocation) => {
    const { selectedFile, editContent, fileContent } = get();
    const isDirty = editContent !== null && editContent !== fileContent;

    // If dirty and trying to navigate to a different file, show dialog
    if (isDirty && path !== selectedFile) {
      set({ pendingNavigation: { path, location }, showUnsavedDialog: true });
      return;
    }

    const previewLocation = location === undefined
      ? null
      : { ...location, requestId: ++_previewLocationRequestId };

    // Toggle selection: click again to deselect
    if (selectedFile === path) {
      if (location !== undefined) {
        set({
          previewMode: location.line ? 'source' : 'preview',
          previewLocation,
          revealTarget: path,
        });
        return;
      }
      set({
        selectedFile: null,
        fileContent: null,
        isLoadingContent: false,
        editContent: null,
        revealTarget: null,
        previewLocation: null,
      });
    } else {
      set({
        selectedFile: path,
        fileContent: null,
        isLoadingContent: true,
        previewMode: location?.line ? 'source' : 'preview',
        previewLocation,
        editContent: null,
        revealTarget: path,
      });

      // Binary-preview files: skip text reading, render with file:// URL in FilePreview
      const ext = path.split('.').pop()?.toLowerCase() || '';
      const BINARY_PREVIEW = new Set([
        'png','jpg','jpeg','gif','webp','bmp','ico',
        'pdf','mp4','webm','mov','avi',
        'mp3','wav','ogg','aac','m4a',
      ]);

      if (BINARY_PREVIEW.has(ext)) {
        // Load binary files as base64 data URL for rendering in webview
        try {
          const dataUrl = await bridge.readFileBase64(path);
          if (get().selectedFile === path) {
            set({ fileContent: dataUrl, isLoadingContent: false });
          }
        } catch {
          if (get().selectedFile === path) {
            set({ fileContent: null, isLoadingContent: false });
          }
        }
      } else {
        try {
          const content = await bridge.readFileContent(path);
          // Only update if selectedFile hasn't changed during the async call
          if (get().selectedFile === path) {
            set({ fileContent: content, isLoadingContent: false });
          }
        } catch {
          // File read failed — might be a directory. Try common index files.
          const dirPath = path.replace(/\/$/, '');
          const candidates = [...DIRECTORY_LANDING_FILE_NAMES];
          let found = false;
          for (const file of candidates) {
            if (get().selectedFile !== path) break; // user navigated away
            try {
              const indexPath = `${dirPath}/${file}`;
              const content = await bridge.readFileContent(indexPath);
              if (get().selectedFile === path) {
                set({ selectedFile: indexPath, fileContent: content, isLoadingContent: false });
              }
              found = true;
              break;
            } catch {
              // try next candidate
            }
          }
          if (!found && get().selectedFile === path) {
            set({ fileContent: '// Error loading file', isLoadingContent: false });
          }
        }
      }
    }
  },

  clearSelection: () => set({
    selectedFile: null,
    fileContent: null,
    isLoadingContent: false,
    editContent: null,
    previewLocation: null,
  }),

  closePreview: () => set({
    selectedFile: null,
    fileContent: null,
    isLoadingContent: false,
    editContent: null,
    previewLocation: null,
  }),

  savePreviewState: (sessionId: string) => set((state) => {
    if (!state.selectedFile) {
      const previewSnapshots = { ...state.previewSnapshots };
      delete previewSnapshots[sessionId];
      return { previewSnapshots };
    }
    return {
      previewSnapshots: {
        ...state.previewSnapshots,
        [sessionId]: {
          selectedFile: state.selectedFile,
          fileContent: state.fileContent,
          previewMode: state.previewMode,
          editContent: state.editContent,
          revealTarget: state.revealTarget,
        },
      },
    };
  }),

  restorePreviewState: (sessionId: string) => set((state) => {
    const snapshot = state.previewSnapshots[sessionId];
    if (!snapshot) {
      return {
        selectedFile: null,
        fileContent: null,
        isLoadingContent: false,
        editContent: null,
        previewLocation: null,
        revealTarget: null,
        pendingNavigation: null,
        showUnsavedDialog: false,
      };
    }
    return {
      selectedFile: snapshot.selectedFile,
      fileContent: snapshot.fileContent,
      isLoadingContent: false,
      previewMode: snapshot.previewMode,
      // A line/anchor reference is a one-shot navigation instruction. Returning
      // to a conversation restores the reader's later scroll position instead.
      previewLocation: null,
      editContent: snapshot.editContent,
      revealTarget: snapshot.revealTarget,
      pendingNavigation: null,
      showUnsavedDialog: false,
    };
  }),

  setPreviewMode: (mode: PreviewMode) => {
    const state = get();
    if (mode === 'edit') {
      // Entering edit mode: initialize editContent from fileContent
      set({ previewMode: mode, editContent: state.fileContent, previewLocation: null });
    } else {
      set({ previewMode: mode, previewLocation: null });
    }
  },

  setEditContent: (content: string) => set({ editContent: content }),

  saveFile: async () => {
    const { selectedFile, editContent } = get();
    if (!selectedFile || editContent === null) return;
    set({ isSaving: true });
    try {
      await bridge.writeFileContent(selectedFile, editContent);
      // Update fileContent to match saved content
      set({ fileContent: editContent, editContent: null, isSaving: false, previewMode: 'preview' });
    } catch {
      set({ isSaving: false });
    }
  },

  discardEdits: () => {
    set({ editContent: null, previewMode: 'preview' });
  },

  setRootPath: (path: string) => set({ rootPath: path }),

  fetchRecentProjects: async () => {
    set({ isLoadingProjects: true });
    try {
      const projects = await bridge.listRecentProjects();
      set({ recentProjects: projects, isLoadingProjects: false });
    } catch {
      set({ isLoadingProjects: false });
    }
  },

  reloadContent: async () => {
    const path = get().selectedFile;
    if (!path) return;
    // Don't reload while user is editing
    if (get().editContent !== null) return;
    try {
      const ext = path.split('.').pop()?.toLowerCase() || '';
      const BINARY_PREVIEW = new Set([
        'png','jpg','jpeg','gif','webp','bmp','ico',
        'pdf','mp4','webm','mov','avi',
        'mp3','wav','ogg','aac','m4a',
      ]);
      if (BINARY_PREVIEW.has(ext)) {
        const dataUrl = await bridge.readFileBase64(path);
        if (get().selectedFile === path) set({ fileContent: dataUrl });
      } else {
        const content = await bridge.readFileContent(path);
        if (get().selectedFile === path) set({ fileContent: content });
      }
    } catch {
      // Silently fail — keep existing content
    }
  },

  markFileChanged: (path: string, kind: FileChangeKind) => {
    _pendingChanges.set(path, kind);
    if (!_changeFlushRaf) {
      _changeFlushRaf = requestAnimationFrame(() => {
        _changeFlushRaf = 0;
        if (_pendingChanges.size === 0) return;
        const next = new Map(get().changedFiles);
        for (const [p, k] of _pendingChanges) {
          next.set(p, k);
        }
        _pendingChanges.clear();
        set({ changedFiles: next });
      });
    }
  },

  clearChangedFiles: () => set({ changedFiles: new Map() }),

  // --- Unsaved changes dialog actions ---

  confirmDiscard: () => {
    const pending = get().pendingNavigation;
    set({ editContent: null, showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending.path, pending.location);
  },

  confirmSaveAndSwitch: async () => {
    const pending = get().pendingNavigation;
    await get().saveFile();
    set({ showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending.path, pending.location);
  },

  cancelNavigation: () => {
    set({
      pendingNavigation: null,
      showUnsavedDialog: false,
      revealTarget: get().selectedFile,
    });
  },

  // --- New file/folder actions ---

  createFile: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.writeFileContent(path, '');
      await get().refreshTree();
      get().selectFile(path);
    } catch {
      // Silently fail
    }
  },

  createFolder: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.createDirectory(path);
      await get().refreshTree();
    } catch {
      // Silently fail
    }
  },

  // --- External drag state ---

  setDragOverTree: (v: boolean) => set({ isDragOverTree: v }),

  // --- 文件树展开 / 定位 ---

  toggleFolder: (path: string) => {
    const next = new Set(get().expandedFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expandedFolders: next });
  },

  loadFolderChildren: async (path: string) => {
    if (!path) return;
    const existing = _folderLoadPromises.get(path);
    if (existing) return existing;

    const task = (async () => {
      const rootAtStart = get().rootPath;
      const loading = new Set(get().loadingFolders);
      loading.add(path);
      set({ loadingFolders: loading });
      try {
        // Each expansion gets another bounded window. Repeating this at later
        // boundaries supports arbitrary depth without scanning an entire large
        // workspace during startup.
        const children = await bridge.readFileTree(path, 8);
        if (get().rootPath === rootAtStart) {
          set({ tree: hydrateFolderChildren(get().tree, path, children) });
        }
      } finally {
        const next = new Set(get().loadingFolders);
        next.delete(path);
        set({ loadingFolders: next });
        _folderLoadPromises.delete(path);
      }
    })();

    _folderLoadPromises.set(path, task);
    return task;
  },

  openFileReference: async (reference, rootHint) => {
    const fallbackRoot = rootHint || get().rootPath;
    const parsed = typeof reference === 'string'
      ? parseFileReference(reference, { basePath: fallbackRoot, explicit: true })
      : reference;
    if (!parsed) return false;

    if (fallbackRoot && (get().rootPath !== fallbackRoot || get().tree.length === 0)) {
      await get().loadTree(fallbackRoot);
    }

    let parsedPath = parsed.path;
    if (parsedPath.startsWith('~/')) {
      try {
        parsedPath = `${(await bridge.getHomeDir()).replace(/\/$/, '')}/${parsedPath.slice(2)}`;
      } catch {
        // Keep the unresolved form; selectFile will surface its normal read error.
      }
    }

    const rootPath = get().rootPath;
    let target = reconcilePathToRoot(parsedPath, rootPath);
    let targetNode = findNodeByPath(get().tree, target);

    // Historical messages can outlive workspace/parent-folder renames, and a
    // bare filename is commonly deeper than the bounded startup tree. Ask the
    // backend for a complete basename search before considering the visible
    // tree. Archive/test residue ranks below a unique active path.
    if (!targetNode) {
      let deepSearchFailed = false;
      try {
        const basename = normalizeFileReferencePath(target).split('/').pop() || '';
        const response = basename && rootPath
          ? await bridge.searchFileTree(rootPath, basename, true, 500)
          : null;
        const recovered = response && !response.truncated
          ? findBestWorkspaceSearchMatch(response.matches, target, parsed.kind)
          : null;
        if (recovered) {
          target = recovered.path;
          targetNode = {
            name: recovered.name,
            path: recovered.path,
            is_dir: recovered.is_dir,
            children: recovered.is_dir ? [] : null,
          };
        }
      } catch {
        deepSearchFailed = true;
      }

      // Offline/backend failure fallback: the visible tree is safe only when
      // it contains exactly one basename match.
      if (!targetNode && deepSearchFailed) {
        const recovered = findUniqueNodeByBasename(get().tree, target);
        if (recovered) {
          target = recovered.path;
          targetNode = recovered;
        }
      }
    }

    // Never feed an unresolved reference into the preview. That was the source
    // of the one-line "// Error loading file" tab for bare historical names.
    if (!targetNode) return false;

    const targetIsDirectory = targetNode?.is_dir || parsed.kind === 'folder';
    const toExpand = computeRevealExpansions(target, rootPath, targetIsDirectory);

    // Expand sequentially so every depth-boundary node can hydrate before its
    // descendant is searched. This supports paths deeper than readFileTree's
    // bounded startup depth.
    for (const ancestor of toExpand) {
      const expanded = new Set(get().expandedFolders);
      expanded.add(ancestor);
      set({ expandedFolders: expanded });

      const node = findNodeByPath(get().tree, ancestor);
      if (node?.is_dir && node.children_truncated) {
        try {
          await get().loadFolderChildren(ancestor);
        } catch {
          // Keep the best-effort expansion/highlight even if lazy hydration fails.
        }
      }
    }

    targetNode = findNodeByPath(get().tree, target) ?? targetNode;
    if (targetNode?.is_dir) {
      const expanded = new Set(get().expandedFolders);
      expanded.add(target);
      set({ expandedFolders: expanded });
    }
    set({ revealTarget: target });

    const location = {
      ...(parsed.line ? { line: parsed.line } : {}),
      ...(parsed.endLine ? { endLine: parsed.endLine } : {}),
      ...(parsed.column ? { column: parsed.column } : {}),
      ...(parsed.anchor ? { anchor: parsed.anchor } : {}),
    };

    if (targetNode?.is_dir) {
      const landingFile = findDirectoryLandingFile(targetNode);
      if (landingFile) {
        await get().selectFile(landingFile.path, location);
      }
      // Directories without a landing document stay expanded in the Files
      // panel. Never feed a directory path into the text-file preview.
      return true;
    }

    // A syntactically explicit folder that is not present in the loaded tree
    // should still never become a fake one-line "// Error loading file" tab.
    if (parsed.kind === 'folder') return true;

    await get().selectFile(target, location);
    return true;
  },

  revealPath: (path: string) => {
    const { tree, rootPath, expandedFolders } = get();
    // 容错：AI 给的绝对全路径前缀可能和真实文件系统不一致（iCloud 的
    // com~apple~CloudDocs 常被写成 com-apple-CloudDocs 或整段缺失）→ 按工作区名对齐回真实 rootPath。
    const target = reconcilePathToRoot(path, rootPath);
    // 判断目标是文件还是文件夹：先在已加载的树里查，查不到回退到「末尾斜杠」
    const node = findNodeByPath(tree, target);
    const isDir = node ? node.is_dir : /\/$/.test(path);
    const toExpand = computeRevealExpansions(target, rootPath, isDir);
    const next = new Set(expandedFolders);
    for (const p of toExpand) next.add(p);
    set({ expandedFolders: next, revealTarget: target });
  },
}));
