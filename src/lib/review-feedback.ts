import type { ReviewComment } from '../stores/reviewStore';

const MAX_FEEDBACK_COMMENTS = 100;
const MAX_FEEDBACK_LENGTH = 40_000;

export function formatReviewFeedback(
  comments: ReviewComment[],
  language: 'zh' | 'en' = 'zh',
): string {
  const active = comments
    .filter((comment) => !comment.resolved)
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath)
      || a.line - b.line
      || a.createdAt - b.createdAt)
    .slice(0, MAX_FEEDBACK_COMMENTS);
  if (active.length === 0) return '';

  const header = language === 'zh'
    ? '请处理以下代码审查意见。先核对当前代码与行号；若代码已经变化，请按文件和摘录定位，不要机械套用旧行号。完成后逐条说明处理结果并运行相关验证。'
    : 'Please address the following code-review comments. Verify the current code and line numbers first; if the patch moved, locate the code by file and excerpt instead of applying stale coordinates mechanically. Report each resolution and run relevant checks.';
  const sideLabel = (comment: ReviewComment) => language === 'zh'
    ? (comment.side === 'new' ? '新版本' : '旧版本')
    : (comment.side === 'new' ? 'new' : 'old');
  const bodyLabel = language === 'zh' ? '意见：' : 'Comment:';

  const sections = active.map((comment, index) => {
    const excerpt = comment.lineText
      ? `\n   > ${comment.lineText.replace(/\n/g, '\n   > ')}`
      : '';
    return `${index + 1}. ${comment.displayPath} — ${sideLabel(comment)} ${language === 'zh' ? '第' : 'line '}${comment.line}${language === 'zh' ? ' 行' : ''}${excerpt}\n   ${bodyLabel} ${comment.body}`;
  });
  return `${header}\n\n${sections.join('\n\n')}`.slice(0, MAX_FEEDBACK_LENGTH);
}
