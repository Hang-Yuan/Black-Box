import type { FileNode, FileSearchMatch } from '../lib/tauri-bridge';

/** 已知代码 / 配置 / 文档 / 图片文件扩展名——聊天里的「文件路径」识别共用这一份。 */
export const KNOWN_FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl',
  'toml', 'yaml', 'yml', 'py', 'pyi', 'rs', 'go', 'html', 'htm', 'css',
  'scss', 'sass', 'less', 'vue', 'svelte', 'sh', 'bash', 'zsh', 'fish',
  'env', 'conf', 'cfg', 'ini', 'xml', 'sql', 'graphql', 'gql', 'proto',
  'lock', 'log', 'txt', 'csv', 'rb', 'php', 'java', 'kt', 'swift', 'c',
  'cpp', 'h', 'hpp', 'cs', 'r', 'lua', 'zig', 'ex', 'exs', 'erl', 'ml',
  'mli', 'tf', 'hcl', 'dockerfile', 'makefile', 'png', 'jpg', 'jpeg',
  'gif', 'svg', 'webp', 'ico', 'wasm', 'map', 'pdf', 'doc', 'docx',
  'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'tar', 'gz', 'rar', '7z',
]);

/** 明确的路径前缀：绝对/相对/盘符/隐藏目录（.claude/ .github/）/常见项目目录。
 *  命中前缀即视为路径，扩展名可选（来自 #110 的前缀检测）。 */
const PATH_PREFIX_RE = /^(?:\/|\.\/|\.\.\/|[a-zA-Z]:[/\\]|\.[a-zA-Z][\w.-]*\/|src\/|lib\/|components\/|stores\/|hooks\/|utils\/|tests\/|__tests__\/)/;

export interface FileReferenceLocation {
  /** 1-based source line. */
  line?: number;
  /** 1-based inclusive source line. */
  endLine?: number;
  /** 1-based source column. */
  column?: number;
  /** Rendered Markdown heading id, without the leading '#'. */
  anchor?: string;
}

export interface ParsedFileReference extends FileReferenceLocation {
  raw: string;
  /** Absolute when a base/home can be inferred, otherwise normalized as supplied. */
  path: string;
  displayPath: string;
  kind: 'file' | 'folder';
}

export interface ParseFileReferenceOptions {
  /** Directory used to resolve relative paths. */
  basePath?: string;
  /** Current file, used by fragment-only references such as #L12 or #heading. */
  sourcePath?: string;
  /** Markdown link destinations are already explicit user intent. */
  explicit?: boolean;
}

const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L?(\d+))?$/i;
const LINE_SUFFIX_RE = /:(\d+)(?::(\d+))?$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function inferHomePath(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.replace(/\\/g, '/');
    const unixHome = normalized.match(/^(\/(?:Users|home)\/[^/]+)/);
    if (unixHome) return unixHome[1];
    const windowsHome = normalized.match(/^([A-Za-z]:\/Users\/[^/]+)/i);
    if (windowsHome) return windowsHome[1];
  }
  return '';
}

/** Normalize separators and dot segments without relying on Node's path module. */
export function normalizeFileReferencePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const drive = slashed.match(/^([A-Za-z]:)(?:\/|$)/)?.[1] ?? '';
  const isUnc = !drive && slashed.startsWith('//');
  const isAbsolute = !drive && !isUnc && slashed.startsWith('/');
  const prefix = drive ? `${drive}/` : isUnc ? '//' : isAbsolute ? '/' : '';
  const rest = drive
    ? slashed.slice(drive.length).replace(/^\/+/, '')
    : slashed.replace(/^\/+/, '');
  const segments: string[] = [];

  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!prefix) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (!joined) return prefix || '.';
  return `${prefix}${joined}`;
}

export function dirnamePath(path: string): string {
  const normalized = normalizeFileReferencePath(path);
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '';
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

/** GitHub-like stable heading id shared by Markdown rendering and anchor navigation. */
export function slugifyHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse one local file reference from chat or a Markdown preview.
 *
 * Supported location suffixes:
 * - `file.ts:12` / `file.ts:12:4`
 * - `file.ts#L12` / `file.ts#L12-L20`
 * - `README.md#安装说明` / fragment-only `#安装说明`
 */
export function parseFileReference(
  rawValue: string,
  options: ParseFileReferenceOptions = {},
): ParsedFileReference | null {
  const raw = rawValue.trim();
  // A local path cannot span Markdown lines. In particular, an untyped fenced
  // code block is passed to react-markdown's `code` renderer without a
  // language class; rejecting newlines here prevents an entire directory tree
  // from being collapsed into one giant clickable "file" chip.
  if (!raw || /[\r\n]/.test(raw)) return null;

  let value = raw;
  if (value.startsWith('<') && value.endsWith('>')) {
    value = value.slice(1, -1).trim();
  }
  if (
    URI_SCHEME_RE.test(value)
    && !/^file:\/\//i.test(value)
    && !/^[A-Za-z]:[/\\]/.test(value)
  ) return null;

  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\//i, '');
    // file:///Users/x -> /Users/x; file://C:/Users/x -> C:/Users/x
    if (!value.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(value)) value = `/${value}`;
  }

  let fragment = '';
  const hashIndex = value.indexOf('#');
  if (hashIndex >= 0) {
    fragment = safeDecode(value.slice(hashIndex + 1));
    value = value.slice(0, hashIndex);
  }

  value = safeDecode(value).trim();
  const displayPath = value || options.sourcePath || '';
  let line: number | undefined;
  let endLine: number | undefined;
  let column: number | undefined;
  let anchor: string | undefined;

  const lineFragment = fragment.match(LINE_FRAGMENT_RE);
  if (lineFragment) {
    line = Number(lineFragment[1]);
    endLine = lineFragment[2] ? Number(lineFragment[2]) : undefined;
  } else if (fragment) {
    anchor = fragment.replace(/^user-content-/, '');
  }

  const suffix = value.match(LINE_SUFFIX_RE);
  if (suffix && !value.endsWith('/')) {
    line = Number(suffix[1]);
    column = suffix[2] ? Number(suffix[2]) : undefined;
    value = value.slice(0, -suffix[0].length);
  }

  if (!value && options.sourcePath) value = options.sourcePath;
  if (!value || line === 0 || endLine === 0 || column === 0) return null;

  const hadTrailingSlash = /[/\\]$/.test(value);
  const pathLike = PATH_PREFIX_RE.test(value.replace(/\\/g, '/'))
    || value.startsWith('~/')
    || value.includes('/')
    || value.includes('\\')
    || hadTrailingSlash;
  const extension = value.split(/[/\\]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  const knownExtension = KNOWN_FILE_EXTENSIONS.has(extension);
  const looksLikeHost = /^[^/\s]+\.[a-z]{2,}(?:[/?]|$)/i.test(value);
  if (!pathLike && !knownExtension && !(options.explicit && !looksLikeHost)) return null;

  if (value.startsWith('~/')) {
    const home = inferHomePath(options.basePath, options.sourcePath);
    if (home) value = `${home}/${value.slice(2)}`;
  }

  const absolute = value.startsWith('/')
    || value.startsWith('//')
    || /^[A-Za-z]:[/\\]/.test(value)
    || value.startsWith('~/');
  const base = options.basePath || (options.sourcePath ? dirnamePath(options.sourcePath) : '');
  const resolved = normalizeFileReferencePath(!absolute && base ? `${base}/${value}` : value);

  return {
    raw,
    path: normalizePath(resolved),
    displayPath,
    kind: hadTrailingSlash ? 'folder' : 'file',
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
    ...(column ? { column } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

/**
 * 判断一段反引号内的文本是不是路径，是文件还是文件夹。
 *
 * 与 parseFileReference 共用规则：支持中文、空格、绝对/相对/隐藏目录路径，
 * 同时用明确路径结构或已知扩展名排除 useState / Math.PI 等普通行内代码。
 */
export function classifyPathToken(text: string): 'file' | 'folder' | null {
  return parseFileReference(text)?.kind ?? null;
}

/** 把路径文本解析成绝对路径（相对路径拼到 base 下），并去掉末尾斜杠，便于和文件树节点匹配。 */
export function resolvePathToken(text: string, base: string): string {
  return parseFileReference(text, { basePath: base })?.path
    ?? normalizeFileReferencePath(text.trim().replace(/\/+$/, ''));
}

/** 去掉路径末尾的斜杠（一个或多个）；根 '/' 本身保留。 */
export function normalizePath(p: string): string {
  if (p === '/') return p;
  return p.replace(/\/+$/, '');
}

/**
 * 算出「要让 targetPath 在文件树里可见、需要展开哪些文件夹」。
 *
 * 纯函数：返回 targetPath 在 rootPath 之下的所有祖先目录；若 targetIsDir，
 * 连 targetPath 自身也算进去（点文件夹＝把它打开）。抽成纯函数是为了能在
 * node 环境直接单测——中文 / 空格 / 末尾斜杠 / 不在根目录下，这些边界都在这里收口。
 *
 * - targetPath 不在 rootPath 之下 → 空数组（无法定位）。
 * - targetPath 就是 rootPath → 空数组（根本身不需要展开）。
 * - 顶层文件（直接在 root 下）→ 空数组（没有需要展开的祖先）。
 * - 始终返回新数组，不改动入参。
 */
export function computeRevealExpansions(
  targetPath: string,
  rootPath: string,
  targetIsDir: boolean,
): string[] {
  const target = normalizePath(targetPath);
  const root = normalizePath(rootPath);
  if (!root || !target) return [];
  if (target === root) return [];
  if (!target.startsWith(root + '/')) return [];

  const rel = target.slice(root.length + 1);
  const parts = rel.split('/').filter(Boolean);
  const result: string[] = [];
  let cur = root;
  // 祖先目录＝除最后一段外的每一级
  for (let i = 0; i < parts.length - 1; i++) {
    cur = `${cur}/${parts[i]}`;
    result.push(cur);
  }
  // 目标本身是文件夹 → 一并展开（"打开"它）
  if (targetIsDir) result.push(target);
  return result;
}

/**
 * 在文件树里按绝对路径查找节点（用来判断目标是文件还是文件夹）。
 * 树只加载到有限深度，找不到时返回 null（调用方回退到「末尾斜杠」判断）。
 */
export function findNodeByPath(tree: FileNode[], path: string): FileNode | null {
  const target = normalizePath(path);
  for (const node of tree) {
    const nodePath = normalizePath(node.path);
    if (nodePath === target) return node;
    if (node.is_dir && node.children && target.startsWith(nodePath + '/')) {
      const found = findNodeByPath(node.children, target);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Recover a moved/renamed reference by its final path segment, but only when
 * that basename is unique in the visible tree. This keeps historical chat
 * references useful after a workspace or parent folder is renamed without
 * guessing when two files share the same name.
 */
export function findUniqueNodeByBasename(tree: FileNode[], path: string): FileNode | null {
  const basename = normalizePath(path).split('/').pop()?.trim();
  if (!basename) return null;

  let match: FileNode | null = null;
  let ambiguous = false;
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.name === basename) {
        if (match) {
          ambiguous = true;
          return;
        }
        match = node;
      }
      if (node.children?.length) visit(node.children);
      if (ambiguous) return;
    }
  };
  visit(tree);
  return ambiguous ? null : match;
}

const RECOVERY_RESIDUE_SEGMENT_RE = /^(?:_?archives?|_?backups?|bak|fixtures?|harness|migration|smoke|tests?|tmp)(?:[_-].*)?$/i;

function suffixOverlap(left: string, right: string): number {
  const a = normalizePath(left).split('/').filter(Boolean);
  const b = normalizePath(right).split('/').filter(Boolean);
  let count = 0;
  while (
    count < a.length
    && count < b.length
    && a[a.length - 1 - count] === b[b.length - 1 - count]
  ) count += 1;
  return count;
}

/**
 * Choose a deterministic active file from a complete workspace basename
 * search. Historical chat often contains only `README.md`-style names. Prefer
 * the candidate that preserves the longest supplied suffix, then live/shallow
 * paths over archive/test residue. A genuine tie stays unresolved so the
 * preview never opens an arbitrary file.
 */
export function findBestWorkspaceSearchMatch(
  matches: FileSearchMatch[],
  referencedPath: string,
  expectedKind: 'file' | 'folder',
): FileSearchMatch | null {
  const basename = normalizePath(referencedPath).split('/').pop()?.trim();
  if (!basename) return null;

  const ranked = matches
    .filter((match) => match.name === basename)
    .filter((match) => match.is_dir === (expectedKind === 'folder'))
    .map((match) => {
      const relativeSegments = normalizePath(match.relative_dir || '.').split('/').filter(
        (segment) => segment && segment !== '.',
      );
      return {
        match,
        overlap: suffixOverlap(referencedPath, match.path),
        residue: relativeSegments.filter((segment) => RECOVERY_RESIDUE_SEGMENT_RE.test(segment)).length,
        depth: relativeSegments.length + 1,
      };
    })
    .sort((a, b) => (
      b.overlap - a.overlap
      || a.residue - b.residue
      || a.depth - b.depth
      || a.match.path.localeCompare(b.match.path)
    ));

  const best = ranked[0];
  if (!best) return null;
  const tied = ranked[1]
    && ranked[1].overlap === best.overlap
    && ranked[1].residue === best.residue
    && ranked[1].depth === best.depth;
  return tied ? null : best.match;
}

/** Preferred landing documents when a chat reference points to a directory. */
export const DIRECTORY_LANDING_FILE_NAMES = [
  '_overview.md',
  '_index.md',
  'README.md',
  'SKILL.md',
  'AGENTS.md',
  'CLAUDE.md',
  'index.md',
  'index.html',
  'index.ts',
  'index.tsx',
  'index.js',
] as const;

/**
 * Choose a real file to preview for a directory reference. Project overview
 * files come first because they are the directory entry points in this
 * workspace; a directory with no landing document remains expanded in the
 * Files panel instead of being opened as a fake one-line file.
 */
export function findDirectoryLandingFile(node: FileNode): FileNode | null {
  if (!node.is_dir || !node.children?.length) return null;
  for (const name of DIRECTORY_LANDING_FILE_NAMES) {
    const candidate = node.children.find((child) => !child.is_dir && child.name === name);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * 容错：把前缀可能不准的绝对路径«对齐»回真实 rootPath 下。
 *
 * AI 在聊天里给的绝对全路径，前缀常和真实文件系统不一致——iCloud 的
 * `com~apple~CloudDocs` 会被写成 `com-apple-CloudDocs`、甚至整段缺失。
 * 这类路径直接拿去和文件树匹配会失败（点了不展开 / 不高亮）。
 *
 * 策略：若 target 不在 root 之下，就用 root 的最后一段（工作区名）当锚点，
 * 在 target 里找到它、截取其后的相对部分，拼回真实 root。对不上则原样返回。
 * 相对路径、已在 root 下的绝对路径都不受影响。
 */
export function reconcilePathToRoot(target: string, root: string): string {
  const t = normalizePath(target);
  const r = normalizePath(root);
  if (!r || t === r || t.startsWith(r + '/')) return t;
  const rootName = r.split('/').pop() || '';
  if (!rootName) return t;
  const anchor = t.indexOf(`/${rootName}/`);
  if (anchor === -1) return t;
  return `${r}/${t.slice(anchor + rootName.length + 2)}`;
}
