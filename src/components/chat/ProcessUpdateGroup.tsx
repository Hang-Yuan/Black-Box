import { useMemo } from 'react';
import type { ChatMessage } from '../../stores/chatStore';
import { processUpdatePreview } from '../../lib/conversation-presentation';
import { useT } from '../../lib/i18n';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';

interface Props {
  messages: readonly ChatMessage[];
  active: boolean;
  basePath?: string;
}

export function ProcessUpdateGroup({ messages, active, basePath }: Props) {
  const t = useT();
  const preview = useMemo(
    () => processUpdatePreview(messages[messages.length - 1]?.content ?? ''),
    [messages],
  );
  const label = (active ? t('chat.processRunning') : t('chat.processUpdates'))
    .replace('{count}', String(messages.length));

  return (
    <details
      data-testid="process-update-group"
      data-active={active ? 'true' : 'false'}
      className="group ml-[72px] mr-[72px]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-left select-none">
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="flex-shrink-0 text-text-tertiary transition-transform group-open:rotate-90"
        >
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${active ? 'animate-pulse-soft bg-accent' : 'bg-text-tertiary/50'}`} />
        <span className="flex-shrink-0 text-[11px] font-medium text-text-muted">{label}</span>
        {preview && (
          <span className="min-w-0 truncate text-[11px] text-text-tertiary">{preview}</span>
        )}
      </summary>
      <div className="ml-4 mt-1 space-y-4 border-l border-border-subtle pl-4 text-sm text-text-muted">
        {messages.map((message) => (
          <div key={message.id} className="leading-relaxed">
            <MarkdownRenderer content={message.content} basePath={message.cwd || basePath} />
          </div>
        ))}
      </div>
    </details>
  );
}
