import { useMemo, useState } from 'react';
import type { AutomationWorktreeFileDiff } from '../../lib/tauri-bridge';
import { parseUnifiedDiff, reviewCoordinate, type UnifiedDiffLine } from '../../lib/unified-diff';
import { useReviewStore } from '../../stores/reviewStore';
import { useT } from '../../lib/i18n';

interface InlinePatchReviewProps {
  runId: string;
  baseCommit: string;
  diff: AutomationWorktreeFileDiff;
}

function lineTone(kind: UnifiedDiffLine['kind']): string {
  if (kind === 'add') return 'bg-success/[0.08] text-success';
  if (kind === 'remove') return 'bg-error/[0.08] text-error';
  if (kind === 'hunk') return 'bg-accent/[0.08] text-accent';
  if (kind === 'meta') return 'bg-bg-tertiary/40 text-text-tertiary';
  return 'text-text-muted';
}

export function InlinePatchReview({ runId, baseCommit, diff }: InlinePatchReviewProps) {
  const t = useT();
  const lines = useMemo(() => parseUnifiedDiff(diff.patch), [diff.patch]);
  const commentMap = useReviewStore((state) => state.comments);
  const comments = useMemo(() => Object.values(commentMap).filter(
    (comment) => comment.runId === runId && comment.path === diff.path,
  ), [commentMap, diff.path, runId]);
  const addComment = useReviewStore((state) => state.addComment);
  const removeComment = useReviewStore((state) => state.removeComment);
  const setResolved = useReviewStore((state) => state.setResolved);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commentsByCoordinate = useMemo(() => {
    const map = new Map<string, typeof comments>();
    for (const comment of comments) {
      const key = `${comment.side}:${comment.line}`;
      map.set(key, [...(map.get(key) || []), comment]);
    }
    return map;
  }, [comments]);

  const submit = (line: UnifiedDiffLine) => {
    const coordinate = reviewCoordinate(line);
    const body = draft.trim();
    if (!coordinate || !body) return;
    addComment({
      runId,
      baseCommit,
      path: diff.path,
      displayPath: diff.displayPath,
      side: coordinate.side,
      line: coordinate.line,
      lineText: line.content,
      body,
    });
    setDraft('');
    setActiveKey(null);
  };

  return (
    <div
      data-testid="inline-patch-review"
      className="max-h-96 overflow-auto rounded border border-border-subtle bg-bg-primary/70
        font-mono text-[10px] leading-4"
    >
      {lines.map((line) => {
        const coordinate = reviewCoordinate(line);
        const coordinateKey = coordinate ? `${coordinate.side}:${coordinate.line}` : null;
        const lineComments = coordinateKey ? commentsByCoordinate.get(coordinateKey) || [] : [];
        const active = coordinateKey === activeKey;
        return (
          <div key={line.index}>
            <div
              data-testid={coordinate ? `review-line-${coordinate.side}-${coordinate.line}` : undefined}
              className={`group flex min-w-max items-stretch ${lineTone(line.kind)}`}
            >
              <span className="w-10 flex-none select-none border-r border-border-subtle/60 px-1 text-right text-text-tertiary/60">
                {line.oldLine ?? ''}
              </span>
              <span className="w-10 flex-none select-none border-r border-border-subtle/60 px-1 text-right text-text-tertiary/60">
                {line.newLine ?? ''}
              </span>
              <span className="w-4 flex-none select-none text-center opacity-70">
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
              </span>
              <code className="min-w-0 flex-1 whitespace-pre pr-3">{line.content || ' '}</code>
              {coordinate && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveKey(active ? null : coordinateKey);
                    setDraft('');
                  }}
                  className={`sticky right-0 w-7 flex-none border-l border-border-subtle/60
                    bg-bg-card/95 text-accent transition-opacity
                    ${active || lineComments.length > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  title={t('review.addComment')}
                >
                  {lineComments.length > 0 ? lineComments.length : '+'}
                </button>
              )}
            </div>

            {lineComments.map((comment) => (
              <div
                key={comment.id}
                data-testid="inline-review-comment"
                className={`ml-20 border-l-2 px-3 py-2 font-sans text-[10px]
                  ${comment.resolved
                    ? 'border-success/40 bg-success/[0.04] text-text-tertiary'
                    : 'border-accent/50 bg-accent/[0.05] text-text-muted'}`}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => setResolved(comment.id, !comment.resolved)}
                    className="mt-0.5 flex-shrink-0 text-accent"
                    title={comment.resolved ? t('review.reopen') : t('review.resolve')}
                  >
                    {comment.resolved ? '✓' : '○'}
                  </button>
                  <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${comment.resolved ? 'line-through' : ''}`}>
                    {comment.body}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeComment(comment.id)}
                    className="flex-shrink-0 text-text-tertiary hover:text-error"
                    title={t('review.delete')}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}

            {active && coordinate && (
              <div className="ml-20 border-l-2 border-accent/50 bg-bg-card px-3 py-2 font-sans">
                <textarea
                  autoFocus
                  data-testid="inline-review-input"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value.slice(0, 4_000))}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(line);
                    if (event.key === 'Escape') {
                      setDraft('');
                      setActiveKey(null);
                    }
                  }}
                  placeholder={t('review.placeholder')}
                  className="min-h-16 w-full resize-y rounded border border-border-subtle bg-bg-secondary
                    px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent/50"
                />
                <div className="mt-1.5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setDraft(''); setActiveKey(null); }}
                    className="rounded px-2 py-1 text-[10px] text-text-tertiary hover:bg-bg-tertiary"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={!draft.trim()}
                    onClick={() => submit(line)}
                    className="rounded bg-accent/10 px-2 py-1 text-[10px] text-accent
                      hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('review.save')}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
