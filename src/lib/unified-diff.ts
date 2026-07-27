export type UnifiedDiffLineKind = 'meta' | 'hunk' | 'context' | 'add' | 'remove';

export interface UnifiedDiffLine {
  index: number;
  kind: UnifiedDiffLineKind;
  raw: string;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse bounded unified diff text into stable old/new line coordinates. */
export function parseUnifiedDiff(patch: string): UnifiedDiffLine[] {
  if (!patch) return [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  return patch.split('\n').map((raw, index): UnifiedDiffLine => {
    const hunk = raw.match(HUNK_RE);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { index, kind: 'hunk', raw, content: raw, oldLine: null, newLine: null };
    }

    if (raw.startsWith('diff --git ') || raw.startsWith('index ')
      || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      if (raw.startsWith('diff --git ')) inHunk = false;
      return { index, kind: 'meta', raw, content: raw, oldLine: null, newLine: null };
    }
    if (!inHunk || raw.startsWith('\\ No newline at end of file')) {
      return { index, kind: 'meta', raw, content: raw, oldLine: null, newLine: null };
    }

    if (raw.startsWith('+')) {
      const line = { index, kind: 'add' as const, raw, content: raw.slice(1), oldLine: null, newLine };
      newLine += 1;
      return line;
    }
    if (raw.startsWith('-')) {
      const line = { index, kind: 'remove' as const, raw, content: raw.slice(1), oldLine, newLine: null };
      oldLine += 1;
      return line;
    }
    if (raw.startsWith(' ')) {
      const line = { index, kind: 'context' as const, raw, content: raw.slice(1), oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return line;
    }
    return { index, kind: 'meta', raw, content: raw, oldLine: null, newLine: null };
  });
}

export function reviewCoordinate(line: UnifiedDiffLine): { side: 'old' | 'new'; line: number } | null {
  if (line.kind === 'remove' && line.oldLine != null) return { side: 'old', line: line.oldLine };
  if ((line.kind === 'add' || line.kind === 'context') && line.newLine != null) {
    return { side: 'new', line: line.newLine };
  }
  return null;
}
