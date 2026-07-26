import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { create } from 'zustand';
import { useChatStore, useActiveTab, isSessionBusy, type ChatMessage } from '../../stores/chatStore';
import { MessageBubble } from './MessageBubble';
import { ToolGroup } from './ToolGroup';
import { InputBar } from './InputBar';
import { ExportMenu } from '../conversations/ExportMenu';
import { useSettingsStore, mapSessionModeToPermissionMode } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useFileStore } from '../../stores/fileStore';
import { useAgentStore } from '../../stores/agentStore';
import { AgentPanel } from '../agents/AgentPanel';
// bridge import removed — spawn goes through sessionLifecycle module
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';
import { flushAndCaptureSpawnConfiguration, getResolvedModelDisplayName, is1MModel as isOneMillionModel, resolveModelOrError } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { spawnSession } from '../../lib/sessionLifecycle';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { SetupWizard } from '../setup/SetupWizard';
import { UserAvatar } from '../shared/UserAvatar';
import { useFindInPage } from '../../hooks/useFindInPage';
import { FindBar } from './FindBar';
import { formatElapsedCompact } from '../../lib/elapsed-time';
import { formatRetryDelaySeconds, isRateLimitRetry, type ApiRetryStatus } from '../../lib/api-retry';
import { TaskLocationControl } from './TaskLocationControl';
import { GoalControl } from './GoalControl';
import { ModeSelector } from './ModeSelector';
import { LoopControl } from './LoopControl';
import { WorkflowControl } from './WorkflowControl';
import { ProviderQuickSelector } from './ProviderQuickSelector';
import { usePlanStore } from '../../stores/planStore';
import { useForkStore } from '../../stores/forkStore';
import { getPlanProgress, type PersistentPlanItem } from '../../lib/plan-contract';
import { adoptCliSessionIdentity } from '../../lib/session-identity';
import { bridge } from '../../lib/tauri-bridge';
import { parseSessionMessages } from '../../lib/session-loader';
import { useComposerModeStore } from '../../stores/composerModeStore';
import type { TaskComposerMode } from '../../lib/composer-mode';
import { useCommandStore } from '../../stores/commandStore';

/** Shared plan panel toggle — used by ChatPanel (panel) and InputBar (button) */
export const usePlanPanelStore = create<{
  open: boolean;
  toggle: () => void;
  close: () => void;
}>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

function ForkBanner() {
  const t = useT();
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId);
  const record = useForkStore((state) => selectedSessionId ? state.forks[selectedSessionId] : undefined);
  const parentSession = useSessionStore((state) =>
    record ? state.sessions.find((session) => session.id === record.parentThreadId) : undefined,
  );
  const customPreviews = useSessionStore((state) => state.customPreviews);
  if (!record) return null;

  const parentName = customPreviews[record.parentThreadId]
    || parentSession?.preview
    || record.parentTitle
    || record.parentThreadId.slice(0, 8);
  const lineageLabel = record.forkPoint === 'checkpoint' && record.checkpointTurnIndex
    ? t('conv.forkedBeforeTurn')
      .replace('{name}', parentName)
      .replace('{n}', String(record.checkpointTurnIndex))
    : t('conv.forkedFrom').replace('{name}', parentName);

  return (
    <div
      data-testid="fork-banner"
      data-parent-thread-id={record.parentThreadId}
      className="flex items-center gap-2 border-b border-border-subtle bg-accent/[0.04]
        px-5 py-1.5 text-[10px] text-text-muted"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        className="flex-shrink-0 text-accent">
        <path d="M3 2v3.5A3.5 3.5 0 006.5 9H13" />
        <path d="M9.5 5.5L13 9l-3.5 3.5" />
      </svg>
      <span className="min-w-0 flex-1 truncate" title={parentName}>
        {lineageLabel}
      </span>
      <button
        type="button"
        data-testid="compare-fork-parent"
        disabled={!parentSession}
        onClick={() => {
          if (!parentSession) return;
          const settings = useSettingsStore.getState();
          if (settings.secondaryPanelOpen) settings.toggleSecondaryPanel();
          usePlanPanelStore.getState().close();
          useForkStore.getState().openComparison(record.parentThreadId);
        }}
        className="rounded-md px-2 py-0.5 text-accent hover:bg-accent/10
          disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('conv.compareSideBySide')}
      </button>
      <button
        type="button"
        data-testid="open-fork-parent"
        disabled={!parentSession}
        onClick={() => window.dispatchEvent(new CustomEvent('blackbox:open-session', {
          detail: { sessionId: record.parentThreadId },
        }))}
        className="rounded-md px-2 py-0.5 text-accent hover:bg-accent/10
          disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('conv.openParent')}
      </button>
    </div>
  );
}

function ConversationComparePane() {
  const t = useT();
  const comparisonThreadId = useForkStore((state) => state.comparisonThreadId);
  const closeComparison = useForkStore((state) => state.closeComparison);
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId);
  const session = useSessionStore((state) =>
    comparisonThreadId
      ? state.sessions.find((item) => item.id === comparisonThreadId)
      : undefined,
  );
  const customPreviews = useSessionStore((state) => state.customPreviews);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(460);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (comparisonThreadId && comparisonThreadId === selectedSessionId) {
      closeComparison();
    }
  }, [comparisonThreadId, selectedSessionId, closeComparison]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError('');
    if (!comparisonThreadId || !session?.path) return;
    setLoading(true);
    bridge.loadSession(session.path)
      .then((rawMessages) => {
        if (cancelled) return;
        setMessages(parseSessionMessages(rawMessages).messages);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [comparisonThreadId, session?.path]);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const onMove = (moveEvent: MouseEvent) => {
      const next = startWidth + (startX - moveEvent.clientX);
      setWidth(Math.max(320, Math.min(760, next)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  if (!comparisonThreadId || comparisonThreadId === selectedSessionId) return null;

  const title = session
    ? customPreviews[session.id] || session.preview || session.id.slice(0, 8)
    : comparisonThreadId.slice(0, 8);

  return (
    <aside
      data-testid="conversation-compare-pane"
      data-comparison-thread-id={comparisonThreadId}
      className="relative flex min-w-[320px] max-w-[65%] flex-col border-l
        border-border-subtle bg-bg-chat"
      style={{ width }}
    >
      <div
        data-testid="conversation-compare-resize"
        onMouseDown={startResize}
        className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize
          hover:bg-accent/30 active:bg-accent/50"
      />
      <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b
        border-border-subtle px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-text-primary" title={title}>{title}</div>
          <div className="text-[9px] text-text-tertiary">{t('conv.readOnlyComparison')}</div>
        </div>
        {session && (
          <button
            type="button"
            data-testid="open-comparison-session"
            onClick={() => window.dispatchEvent(new CustomEvent('blackbox:open-session', {
              detail: { sessionId: session.id },
            }))}
            className="rounded-md px-2 py-1 text-[10px] text-accent hover:bg-accent/10"
          >
            {t('conv.openComparison')}
          </button>
        )}
        <button
          type="button"
          data-testid="close-conversation-compare"
          onClick={closeComparison}
          aria-label={t('common.close')}
          className="rounded-md p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="py-8 text-center text-xs text-text-tertiary">{t('common.loading')}</div>
        ) : error ? (
          <div className="rounded-lg border border-error/20 bg-error/5 p-3 text-xs text-error">
            {t('conv.loadFailed')}: {error}
          </div>
        ) : messages.length === 0 ? (
          <div className="py-8 text-center text-xs text-text-tertiary">{t('conv.empty')}</div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Resizable right-side plan panel */
function PlanPanel({ planMessages, onClose }: {
  planMessages: ChatMessage[];
  onClose: () => void;
}) {
  const t = useT();
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const plan = usePlanStore((s) => selectedSessionId ? s.plans[selectedSessionId] : undefined);
  const [width, setWidth] = useState(420);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const widthRef = useRef(width);
  widthRef.current = width;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = widthRef.current;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging left edge → moving left = wider
      const delta = startX.current - ev.clientX;
      const newWidth = Math.max(280, Math.min(800, startW.current + delta));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <div
      className="absolute right-3 top-3 bottom-3 z-20
        bg-bg-card/80 backdrop-blur-xl border border-white/10 rounded-xl
        shadow-2xl shadow-black/20
        flex flex-col overflow-hidden"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize
          hover:bg-accent/20 active:bg-accent/30 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5
        border-b border-border-subtle bg-accent/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-accent">
            <path d="M2 3.5h10M2 7h8M2 10.5h5" />
          </svg>
          <span className="text-xs font-semibold text-text-primary">
            {t('plan.title')}
          </span>
          {plan && (() => {
            const progress = getPlanProgress(plan.items);
            return (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent font-medium">
                {progress.completed}/{progress.total}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-1">
          {plan && selectedSessionId && (
            <button
              data-testid="clear-persistent-plan"
              onClick={() => {
                if (window.confirm(t('plan.clearConfirm'))) {
                  usePlanStore.getState().clearPlan(selectedSessionId);
                }
              }}
              className="px-2 py-1 rounded-md text-[10px] text-text-tertiary
                hover:bg-bg-tertiary hover:text-text-primary transition-smooth cursor-pointer"
            >
              {t('plan.clear')}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-tertiary text-text-tertiary
              transition-smooth cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {plan ? (
          <PersistentPlanView items={plan.items} explanation={plan.explanation} updatedAt={plan.updatedAt} />
        ) : planMessages.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-4">
            {t('plan.none')}
          </p>
        ) : (
          planMessages.map((planMsg) => (
            <div key={planMsg.id} className="text-sm leading-relaxed">
              <MarkdownRenderer content={planMsg.planContent || planMsg.content || ''} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PersistentPlanView({ items, explanation, updatedAt }: {
  items: PersistentPlanItem[];
  explanation?: string;
  updatedAt: number;
}) {
  const t = useT();
  const progress = getPlanProgress(items);
  const percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <div data-testid="persistent-plan" className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] text-text-tertiary">
          <span>{t('plan.progress')}</span>
          <span>{progress.completed}/{progress.total} · {percent}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${percent}%` }} />
        </div>
      </div>

      {explanation && (
        <p className="text-xs leading-relaxed text-text-muted border-l-2 border-accent/40 pl-2">
          {explanation}
        </p>
      )}

      <div className="space-y-1.5">
        {items.map((item, index) => (
          <div
            key={`${index}-${item.step}`}
            data-plan-status={item.status}
            className={`flex items-start gap-2 rounded-lg px-2.5 py-2 border transition-colors
              ${item.status === 'in_progress'
                ? 'border-accent/30 bg-accent/10'
                : 'border-border-subtle/60 bg-bg-secondary/30'}`}
          >
            <span className="mt-0.5 flex-shrink-0">
              {item.status === 'completed' ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-success)" strokeWidth="1.5">
                  <circle cx="7" cy="7" r="5.5" /><path d="M4.5 7l1.7 1.8 3.5-3.7" />
                </svg>
              ) : item.status === 'in_progress' ? (
                <span className="block w-3.5 h-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              ) : (
                <span className="block w-3.5 h-3.5 rounded-full border border-border-strong" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-xs leading-relaxed ${item.status === 'completed' ? 'text-text-tertiary line-through' : 'text-text-primary'}`}>
                {item.step}
              </div>
              {item.status === 'in_progress' && item.activeForm && item.activeForm !== item.step && (
                <div className="mt-0.5 text-[10px] text-accent">{item.activeForm}</div>
              )}
            </div>
            <span className="text-[9px] text-text-tertiary whitespace-nowrap">
              {t(`plan.status.${item.status}`)}
            </span>
          </div>
        ))}
      </div>

      <div className="text-[9px] text-text-tertiary text-right">
        {t('plan.updated')} {new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

/** Format token count: "3.2k" for >=1000, raw number for <1000 */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Cycling typewriter text for thinking phase — like Claude Code website "Built for > coders" */
const THINKING_WORD_COUNT = 17;
const TYPING_SPEED = 80;      // ms per character (typing)
const DELETING_SPEED = 40;    // ms per character (deleting)
const PAUSE_DURATION = 2500;  // ms to hold full word
const TRANSITION_DELAY = 300; // ms between delete and next word

/** Fisher-Yates shuffle, always starts with index 0 ("思考中"/"Thinking") */
function shuffledOrder(count: number): number[] {
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = arr.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(Math.random() * i); // skip index 0
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function CyclingThinkingText() {
  const t = useT();
  const [order, setOrder] = useState(() => shuffledOrder(THINKING_WORD_COUNT));
  const [cursor, setCursor] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'pausing' | 'deleting' | 'waiting'>('typing');

  const wordIndex = order[cursor];
  const fullWord = t(`chat.thinkingCycle.${wordIndex}`);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (phase === 'typing') {
      if (displayText.length < fullWord.length) {
        timer = setTimeout(() => {
          setDisplayText(fullWord.slice(0, displayText.length + 1));
        }, TYPING_SPEED);
      } else {
        timer = setTimeout(() => setPhase('pausing'), 0);
      }
    } else if (phase === 'pausing') {
      timer = setTimeout(() => setPhase('deleting'), PAUSE_DURATION);
    } else if (phase === 'deleting') {
      if (displayText.length > 0) {
        timer = setTimeout(() => {
          setDisplayText(displayText.slice(0, -1));
        }, DELETING_SPEED);
      } else {
        const nextCursor = cursor + 1;
        if (nextCursor >= THINKING_WORD_COUNT) {
          // Reshuffle when all words shown
          setOrder(shuffledOrder(THINKING_WORD_COUNT));
          setCursor(0);
        } else {
          setCursor(nextCursor);
        }
        setPhase('waiting');
      }
    } else if (phase === 'waiting') {
      timer = setTimeout(() => {
        setDisplayText('');
        setPhase('typing');
      }, TRANSITION_DELAY);
    }

    return () => clearTimeout(timer);
  }, [displayText, phase, fullWord, cursor]);

  return (
    <span className="inline-flex items-baseline">
      <span>{displayText}</span>
      <span className="text-text-tertiary">...</span>
    </span>
  );
}

function formatApiRetryText(retry: ApiRetryStatus, t: (key: string) => string): string {
  const attempt = retry.attempt
    ? retry.maxRetries
      ? t('chat.apiRetryAttempt')
        .replace('{attempt}', String(retry.attempt))
        .replace('{max}', String(retry.maxRetries))
      : t('chat.apiRetryAttemptOnly').replace('{attempt}', String(retry.attempt))
    : '';
  const base = isRateLimitRetry(retry)
    ? t('chat.apiRetryRateLimit')
    : t('chat.apiRetryGeneric');
  const delay = formatRetryDelaySeconds(retry.retryDelayMs);
  const delayText = delay ? ` ${t('chat.apiRetryDelay').replace('{delay}', delay)}` : '';
  return `${base.replace('{attempt}', attempt ? ` ${attempt}` : '')}${delayText}`;
}

/** Activity indicator with elapsed time and token count */
function ActivityIndicator({ activityStatus, sessionMeta, sessionStatus }: {
  activityStatus: { phase: string; toolName?: string };
  sessionMeta: { turnStartTime?: number; outputTokens?: number; inputTokens?: number; lastProgressAt?: number; apiRetry?: ApiRetryStatus };
  sessionStatus?: string;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const isStopping = sessionStatus === 'stopping';
  const retryStatus = !isStopping ? sessionMeta.apiRetry : undefined;
  const isStarting = sessionStatus === 'running'
    && activityStatus.phase === 'idle';
  const retryText = retryStatus ? formatApiRetryText(retryStatus, t) : null;
  const phaseText = isStopping ? t('chat.stopping')
    : retryText ? retryText
    : isStarting ? t('chat.startingAgent')
    : activityStatus.phase === 'thinking' ? t('chat.thinking')
    : activityStatus.phase === 'writing' ? t('chat.writing')
    : activityStatus.phase === 'tool' ? `${t('chat.runningTool')}: ${activityStatus.toolName || ''}`
    : activityStatus.phase === 'awaiting' ? t('chat.awaiting')
    : activityStatus.phase === 'reconnecting' ? t('chat.reconnecting')
    : t('chat.running');

  const elapsed = sessionMeta.turnStartTime ? formatElapsedCompact(now - sessionMeta.turnStartTime) : null;
  const tokens = sessionMeta.outputTokens ? formatTokens(sessionMeta.outputTokens) : null;
  const statsText = elapsed
    ? tokens ? `(${elapsed} · ↓ ${tokens})` : `(${elapsed})`
    : null;

  // Context pressure warning: threshold depends on model context window size
  // 1M models → warn at 600K; others at 120K (60% of 200K).
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const selectedModelResolution = resolveModelOrError(selectedModel);
  const resolvedModel = selectedModelResolution.ok ? selectedModelResolution.model : '';
  const is1MContextModel = isOneMillionModel(resolvedModel);
  const contextWindow = is1MContextModel ? 1_000_000 : 200_000;
  const inputTokens = sessionMeta.inputTokens || 0;
  const contextWarning = !isStopping && inputTokens > contextWindow * 0.6;

  // Stall detection: 120s of silence (no stream activity), not total elapsed time.
  const stallWarning = !isStopping
    && !!sessionMeta.lastProgressAt
    && !!elapsed
    && (now - sessionMeta.lastProgressAt) > 120_000;

  const isRetrying = Boolean(retryStatus);
  const isThinking = !isRetrying && !isStopping && !isStarting && activityStatus.phase === 'thinking';

  return (
    <div className={`flex items-center gap-1.5 py-1 ${isStopping ? 'px-2.5 rounded-full border border-warning/20 bg-warning/5 w-fit' : ''}`}>
      {isStopping ? (
        <span className="w-3.5 h-3.5 rounded-full border-2 border-warning/25 border-t-warning animate-spin flex-shrink-0" />
      ) : (
        <span className={`text-sm font-medium leading-none text-accent
          ${isThinking ? '' : 'animate-pulse-soft'}`}>/</span>
      )}
      <span className="text-sm text-text-muted">
        {isThinking ? <CyclingThinkingText /> : phaseText}
        {statsText && (
          <span className={`ml-1.5 ${stallWarning ? 'text-red-400' : 'text-text-tertiary'}`}>{statsText}</span>
        )}
      </span>
      {stallWarning && (
        <span className="text-xs text-red-400 ml-2 flex items-center gap-1">
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
          </svg>
          {t('chat.stallWarning')}
        </span>
      )}
      {contextWarning && !stallWarning && (
        <span className="text-xs text-amber-500 ml-2 flex items-center gap-1"
              title={t('chat.tokenWarning')}>
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          {t('chat.tokenWarning')}
        </span>
      )}
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const messages = useActiveTab((t) => t.messages);
  const isStreaming = useActiveTab((t) => t.isStreaming);
  const partialText = useActiveTab((t) => t.partialText);
  const partialThinking = useActiveTab((t) => t.partialThinking);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const sessionMeta = useActiveTab((t) => t.sessionMeta);
  const activityStatus = useActiveTab((t) => t.activityStatus);
  const pendingUserMessages = useActiveTab((t) => t.pendingUserMessages);
  const sidebarOpen = useSettingsStore((s) => s.sidebarOpen);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const toggleSecondaryPanel = useSettingsStore((s) => s.toggleSecondaryPanel);
  const secondaryPanelOpen = useSettingsStore((s) => s.secondaryPanelOpen);
  const secondaryPanelTab = useSettingsStore((s) => s.secondaryPanelTab);
  const setSecondaryTab = useSettingsStore((s) => s.setSecondaryTab);
  const agentPanelOpen = useSettingsStore((s) => s.agentPanelOpen);
  const agentTeamsEnabled = useSettingsStore((s) => s.agentTeamsEnabled);
  const toggleAgentPanel = useSettingsStore((s) => s.toggleAgentPanel);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const directoryMissing = useFileStore((s) => s.directoryMissing);
  const activeProvider = useProviderStore((s) => {
    if (!s.activeProviderId) return null;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
  });
  const selectedModelResolution = useMemo(
    () => resolveModelOrError(selectedModel),
    [selectedModel, activeProvider],
  );
  const resolvedHeaderModel = (
    (sessionStatus === 'running' || sessionStatus === 'stopping') && sessionMeta.model
      ? sessionMeta.model
      : selectedModelResolution.ok
        ? selectedModelResolution.model
        : sessionMeta.model || selectedModel
  );
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const taskComposerMode = useComposerModeStore((state) => (
    selectedSessionId ? state.tabs[selectedSessionId]?.taskMode || null : null
  ));
  const selectTaskComposerMode = useComposerModeStore((state) => state.selectTaskMode);
  const sessions = useSessionStore((s) => s.sessions);
  const isFilePreviewMode = !!useFileStore((s) => s.selectedFile);

  // Agent activity for floating button badge
  const agents = useAgentStore((s) => s.agents);
  const activeAgentCount = useMemo(
    () => Array.from(agents.values()).filter(
      (a) => !['idle', 'completed', 'error'].includes(a.phase)
    ).length,
    [agents],
  );
  const totalAgentCount = agents.size;

  const openSecondaryTab = useCallback((tab: 'activity' | 'files') => {
    if (secondaryPanelOpen && secondaryPanelTab === tab) {
      toggleSecondaryPanel();
      return;
    }
    setSecondaryTab(tab);
  }, [secondaryPanelOpen, secondaryPanelTab, setSecondaryTab, toggleSecondaryPanel]);

  const selectTaskMode = useCallback((mode: TaskComposerMode) => {
    if (!selectedSessionId || isSessionBusy(sessionStatus)) return;
    useCommandStore.getState().clearPrefix();
    selectTaskComposerMode(selectedSessionId, mode);
  }, [selectedSessionId, selectTaskComposerMode, sessionStatus]);

  const showPlanPanel = usePlanPanelStore((s) => s.open);
  const closePlanPanel = usePlanPanelStore((s) => s.close);

  useEffect(() => {
    const close = () => closePlanPanel();
    window.addEventListener('blackbox:close-plan-panel', close);
    return () => window.removeEventListener('blackbox:close-plan-panel', close);
  }, [closePlanPanel]);

  useEffect(() => subscribeHeaderPopover('agent', () => {
    if (useSettingsStore.getState().agentPanelOpen) {
      useSettingsStore.getState().toggleAgentPanel();
    }
  }), []);


  // Listen for internal file tree drag-drop (mouse-based, not HTML5 drag-and-drop)
  // HTML5 drag events don't work in Tauri because dragDropEnabled: true intercepts them.
  // Listen for file-chip click → open file in secondary panel's file browser
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const filePath = (e as CustomEvent<string>).detail;
      if (!filePath) return;
      // Open secondary panel, hydrate ancestors, then select/preview the file.
      useSettingsStore.getState().setSecondaryTab('files');
      const rootHint = useSettingsStore.getState().workingDirectory
        || useFileStore.getState().rootPath;
      void useFileStore.getState().openFileReference(filePath, rootHint);
    };
    window.addEventListener('blackbox:open-file', onOpenFile);
    return () => window.removeEventListener('blackbox:open-file', onOpenFile);
  }, []);

  // --- Tool grouping: group 3+ consecutive tool_use messages ---
  type DisplayItem =
    | { kind: 'message'; msg: ChatMessage; idx: number }
    | { kind: 'tool_group'; msgs: ChatMessage[]; startIdx: number };

  const displayItems = useMemo<DisplayItem[]>(() => {
    const items: DisplayItem[] = [];
    let i = 0;
    while (i < messages.length) {
      // Detect runs of consecutive tool_use messages
      if (messages[i].type === 'tool_use') {
        let j = i;
        while (j < messages.length && messages[j].type === 'tool_use') j++;
        const runLength = j - i;
        if (runLength >= 3) {
          items.push({ kind: 'tool_group', msgs: messages.slice(i, j), startIdx: i });
          i = j;
          continue;
        }
      }
      items.push({ kind: 'message', msg: messages[i], idx: i });
      i++;
    }
    return items;
  }, [messages]);

  // Collect plan review messages from the session (created by ExitPlanMode)
  const planMessages = useMemo(
    () => messages.filter((m) => m.type === 'plan_review' || m.type === 'plan' || m.planContent),
    [messages],
  );

  // Find the path of the currently selected session for export
  const currentSessionPath = sessions.find(
    (s) => s.id === selectedSessionId
  )?.path;

  const scrollRef = useRef<HTMLDivElement>(null);
  const find = useFindInPage(scrollRef);
  const thinkingPreRef = useRef<HTMLPreElement>(null);
  const isNearBottomRef = useRef(true);
  // When user scrolls up via wheel, suppress auto-scroll until they return to bottom
  const userScrollingUpRef = useRef(false);
  // Show "scroll to bottom" button when user is far from bottom
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Track whether user is near the bottom of the scroll container
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Consider "near bottom" if within 80px of the end
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isNearBottomRef.current = nearBottom;
    // Show scroll-to-bottom button when far from bottom (>300px)
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 300);
    // Reset the scroll-up lock once user returns to bottom
    if (nearBottom) {
      userScrollingUpRef.current = false;
    }
  }, []);

  // Detect intentional upward scroll via wheel event
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User is scrolling up — suppress auto-scroll
        userScrollingUpRef.current = true;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Auto-scroll to bottom only when already near bottom and user isn't scrolling up
  useEffect(() => {
    if (isNearBottomRef.current && !userScrollingUpRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, partialText, partialThinking, activityStatus]);

  // Auto-scroll the internal thinking <pre> to bottom as new content streams in
  useEffect(() => {
    const el = thinkingPreRef.current;
    if (el && partialThinking) {
      el.scrollTop = el.scrollHeight;
    }
  }, [partialThinking]);

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar — with extra top padding for macOS traffic lights */}
      <div
        className="flex items-center h-[68px] pt-[20px] px-5 border-b border-border-subtle
        flex-shrink-0 bg-bg-chat cursor-default">
        {/* Show sidebar toggle when sidebar is not visible:
            either user closed it, or it's hidden by file preview mode */}
        {(!sidebarOpen || isFilePreviewMode) && (
          <button onClick={toggleSidebar}
            className="p-1.5 rounded-md hover:bg-bg-tertiary text-text-tertiary
              transition-smooth mr-3" title={t('chat.showSidebar')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
        )}
        {/* Primary identity: the concrete model actually used by this task. */}
        <div
          data-testid="current-resolved-model"
          className="min-w-0 max-w-[220px] flex-shrink-0 truncate text-xl font-medium
            tracking-[-0.02em] text-text-primary"
          title={resolvedHeaderModel}
        >
          {getResolvedModelDisplayName(resolvedHeaderModel)}
        </div>

        {/* Integrated controls: Agent Teams, Provider/API key, permission mode. */}
        <div className="relative ml-5 flex min-w-0 items-center gap-3">
          {/* Agent status — clickable dot + label → opens AgentPanel */}
          <button onClick={() => {
            if (!agentPanelOpen) announceHeaderPopover('agent');
            toggleAgentPanel();
          }}
            data-testid="agent-panel-toggle"
            className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded-md
              transition-smooth text-[9px]
              ${agentPanelOpen ? 'bg-accent/10' : 'hover:bg-bg-secondary/50'}`}
            title={t('agents.toggle')}>
            <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 transition-smooth
              ${activeAgentCount > 0
                ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.5)] animate-pulse-soft'
                : totalAgentCount > 0
                  ? 'bg-success'
                  : 'bg-text-tertiary/30'}`} />
            <span className={`${activeAgentCount > 0 ? 'text-amber-400' : totalAgentCount > 0 ? 'text-success' : 'text-text-tertiary'}`}>
              {agentTeamsEnabled ? 'Team' : 'Agent'}{totalAgentCount > 1 ? ` (${totalAgentCount})` : ''}
            </span>
          </button>

          <ProviderQuickSelector compact={secondaryPanelOpen} />

          {/* Current session mode — visible and switchable in place. */}
          <ModeSelector placement="down" compact iconOnly={secondaryPanelOpen} />

          {/* Floating agent panel popover — anchored to agent button */}
          {agentPanelOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={toggleAgentPanel} />
              <div className="absolute left-0 top-full mt-2 z-50
                w-72 max-h-80 rounded-lg border border-border-subtle
                bg-bg-primary shadow-lg overflow-y-auto">
                <AgentPanel />
              </div>
            </>
          )}
        </div>

        {/* Spacer + right-side actions */}
        <div className="ml-auto flex items-center" />
        <WorkflowControl
          compact={secondaryPanelOpen}
          active={taskComposerMode === 'workflow'}
          disabled={isSessionBusy(sessionStatus)}
          onSelect={() => selectTaskMode('workflow')}
        />
        <LoopControl
          compact={secondaryPanelOpen}
          active={taskComposerMode === 'loop'}
          disabled={isSessionBusy(sessionStatus)}
          onSelect={() => selectTaskMode('loop')}
        />
        <GoalControl
          compact={secondaryPanelOpen}
          active={taskComposerMode === 'goal'}
          disabled={isSessionBusy(sessionStatus)}
          onSelect={() => selectTaskMode('goal')}
        />
        <TaskLocationControl compact={secondaryPanelOpen} />
        <button onClick={() => openSecondaryTab('activity')}
          data-testid="activity-panel-toggle"
          className={`p-1.5 rounded-md text-text-tertiary transition-smooth
            ${secondaryPanelOpen && secondaryPanelTab === 'activity' ? 'bg-accent/10 text-accent' : 'hover:bg-bg-tertiary'}`}
          title={t('activity.toggle')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11" />
            <circle cx="6" cy="3.5" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="10.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="5" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <ExportMenu sessionPath={currentSessionPath} />
        <button onClick={() => openSecondaryTab('files')}
          className={`p-1.5 rounded-md text-text-tertiary transition-smooth
            ${secondaryPanelOpen && secondaryPanelTab === 'files' ? 'bg-accent/10 text-accent' : 'hover:bg-bg-tertiary'}`}
          title={t('chat.toggleFiles')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <path d="M10 2v12" />
          </svg>
        </button>
      </div>

      <ForkBanner />

      <div className="flex flex-1 min-h-0 relative">
      {/* Main chat area */}
      <div className="flex flex-col flex-1 min-w-0">
      {find.isOpen && <FindBar {...find} />}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="chat-messages"
        className="flex-1 overflow-y-auto px-5 py-6 selectable"
      >
        {!workingDirectory && messages.length === 0 && !isStreaming ? (
          <WelcomeScreen />
        ) : messages.length === 0 && !isStreaming ? (
          <EmptyReadyState />
        ) : (
          <div className="max-w-3xl mx-auto">
            {displayItems.map((item, displayIdx) => {
              // Determine spacing based on item type
              const isCompact = item.kind === 'tool_group'
                || (item.kind === 'message' && ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'].includes(item.msg.type));
              const prevItem = displayIdx > 0 ? displayItems[displayIdx - 1] : null;
              const prevIsCompact = prevItem && (
                prevItem.kind === 'tool_group'
                || (prevItem.kind === 'message' && ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'].includes(prevItem.msg.type))
              );
              const spacing = displayIdx === 0
                ? ''
                : isCompact && prevIsCompact
                  ? 'mt-0.5'
                  : isCompact || prevIsCompact
                    ? 'mt-2'
                    : 'mt-5';

              if (item.kind === 'tool_group') {
                return (
                  <div key={`tg_${item.msgs[0].id}`} className={spacing}>
                    <ToolGroup messages={item.msgs} />
                  </div>
                );
              }

              const msg = item.msg;
              const idx = item.idx;
              // Show avatar only for the FIRST assistant text in a turn.
              let isFirstInGroup = true;
              if (msg.role === 'assistant' && msg.type === 'text') {
                for (let j = idx - 1; j >= 0; j--) {
                  const prev = messages[j];
                  if (prev.role === 'user') break;
                  if (prev.role === 'assistant' && prev.type === 'text') {
                    isFirstInGroup = false;
                    break;
                  }
                }
              }
              return (
                <div key={msg.id} className={spacing}>
                  <MessageBubble message={msg} isFirstInGroup={isFirstInGroup} />
                </div>
              );
            })}
            {/* Streaming thinking — auto-collapse as soon as assistant text becomes visible. */}
            {isStreaming && partialThinking && (() => {
              const hasVisiblePartialText = partialText.trim().length > 0;
              return (
              <div className="ml-11 mr-11 mt-1">
                <details
                  key={hasVisiblePartialText ? 'collapsed' : 'open'}
                  {...(!hasVisiblePartialText ? { open: true } : {})}
                  className="group"
                >
                  <summary className="flex items-center gap-1.5 py-1
                    cursor-pointer text-[11px] text-text-tertiary list-none select-none">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                      stroke="currentColor" strokeWidth="1.5"
                      className="transition-transform duration-150 group-open:rotate-90">
                      <path d="M3 2l4 3-4 3" />
                    </svg>
                    {t('msg.thinking')}
                    <span className="inline-block w-1.5 h-3 bg-text-tertiary ml-0.5
                      animate-pulse-soft rounded-sm" />
                  </summary>
                  <pre ref={thinkingPreRef} className="ml-5 mt-0.5 text-[11px] text-text-tertiary
                    whitespace-pre-wrap max-h-48 overflow-y-auto
                    font-mono leading-relaxed">
                    {partialThinking}
                  </pre>
                </details>
              </div>
              );
            })()}
            {isStreaming && partialText && (() => {
              // Hide streaming text while an unresolved question is pending —
              // the CLI may keep sending text_delta events for the next turn's
              // content, but the user needs to answer the question first.
              // Check both resolved flag AND interactionState to handle edge
              // cases where setInteractionState hasn't propagated yet.
              const hasPendingQuestion = messages.some(
                (m) => m.type === 'question' && !m.resolved
                  && m.interactionState !== 'resolved' && m.interactionState !== 'sending',
              );
              if (hasPendingQuestion) return null;

              // Check if there's already an assistant text in this turn
              let showStreamAvatar = true;
              for (let j = messages.length - 1; j >= 0; j--) {
                if (messages[j].role === 'user') break;
                if (messages[j].role === 'assistant' && messages[j].type === 'text') {
                  showStreamAvatar = false;
                  break;
                }
              }
              return (
              <div className="flex gap-3 mt-2">
                {showStreamAvatar ? (
                  <div className="w-8 h-8 rounded-[10px] bg-accent
                    flex items-center justify-center flex-shrink-0 text-text-inverse
                    text-xs font-bold shadow-md mt-0.5">C</div>
                ) : (
                  <div className="w-8 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed">
                  <MarkdownRenderer content={partialText} />
                </div>
                {/* Right gutter mirrors the avatar so streaming text aligns with the user bubble's right edge */}
                <div className="w-8 flex-shrink-0" />
              </div>
              );
            })()}
            {/* Pending user messages — queued while AI is streaming.
                Rendered AFTER partialText bubble so they visually queue up
                behind the streaming reply. Each one becomes a real user
                message bubble when the current turn completes and the
                FIFO drain in useStreamProcessor sends it. */}
            {pendingUserMessages && pendingUserMessages.length > 0 && pendingUserMessages.map((pending, idx) => (
              <div key={`pending_${idx}`} className="flex justify-end gap-3 mt-4">
                <div className="flex flex-col items-end max-w-[75%] opacity-60">
                  <div className="bg-bg-elevated border border-border-subtle text-text-primary
                    rounded-xl rounded-br-md px-4 py-2.5 leading-relaxed whitespace-pre-wrap break-words">
                    {pending.text}
                  </div>
                  <span className="text-[10px] text-text-tertiary mt-1 mr-1 flex items-center gap-1">
                    <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <circle cx="8" cy="8" r="6" />
                      <path d="M8 5v3l2 1.5" strokeLinecap="round" />
                    </svg>
                    {pending.kind === 'steer' ? t('chat.steerQueued') : t('chat.queued')}
                  </span>
                </div>
                <UserAvatar size="w-8 h-8 text-xs" className="mt-0.5 flex-shrink-0" />
              </div>
            ))}
            {/* Inline activity status indicator — like Claude Desktop App */}
            {(sessionStatus === 'running' || sessionStatus === 'reconnecting' || sessionStatus === 'stopping' || activityStatus.phase === 'awaiting') && (
              <ActivityIndicator activityStatus={activityStatus} sessionMeta={sessionMeta} sessionStatus={sessionStatus} />
            )}
          </div>
        )}
      </div>

      {/* Scroll to bottom FAB */}
      {showScrollBtn && (
        <button
          onClick={() => {
            const el = scrollRef.current;
            if (el) {
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              userScrollingUpRef.current = false;
            }
          }}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10
            w-8 h-8 rounded-full bg-bg-card border border-border-subtle
            shadow-md hover:shadow-lg flex items-center justify-center
            text-text-muted hover:text-text-primary transition-smooth
            cursor-pointer opacity-80 hover:opacity-100"
          title={t('chat.scrollToBottom')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M7 2v10M3 8l4 4 4-4" />
          </svg>
        </button>
      )}

      {/* Directory missing banner */}
      {workingDirectory && directoryMissing && (
        <div className="mx-4 mb-3 px-4 py-3 rounded-lg bg-status-warning/10 border border-status-warning/30
          flex items-center gap-3 text-sm text-text-secondary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.5" className="flex-shrink-0 text-status-warning">
            <path d="M8 1.5L1.5 13h13L8 1.5z" strokeLinejoin="round" />
            <path d="M8 6v3" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
          <span className="flex-1">{t('project.directoryMissing')}</span>
          <button
            onClick={async () => {
              const selected = await open({ directory: true, multiple: false, title: t('project.selectFolder') });
              if (selected) useSettingsStore.getState().setWorkingDirectory(selected as string);
            }}
            className="px-3 py-1 rounded-md text-xs font-medium
              bg-status-warning/20 hover:bg-status-warning/30
              text-status-warning transition-smooth"
          >
            {t('project.reselect')}
          </button>
        </div>
      )}

      {/* Input — only show when a project folder is selected and exists */}
      {workingDirectory && !directoryMissing && <InputBar />}
      </div>{/* end main chat area */}

      <ConversationComparePane />

      {/* Right-side plan panel (resizable) */}
      {showPlanPanel && (
        <PlanPanel
          planMessages={planMessages}
          onClose={closePlanPanel}
        />
      )}
      </div>{/* end flex row */}
    </div>
  );
}

/** Start a new draft conversation for the given folder and pre-warm the CLI process */
async function startDraftSession(folderPath: string) {
  useSettingsStore.getState().setWorkingDirectory(folderPath);
  const currentTab = useSessionStore.getState().selectedSessionId;
  if (currentTab) useChatStore.getState().resetTab(currentTab);

  // Reuse existing draft tab if one is already selected, otherwise create a new one
  const currentTabId = useSessionStore.getState().selectedSessionId;
  const currentSession = useSessionStore.getState().sessions.find(
    (s) => s.id === currentTabId,
  );
  let draftId: string;
  if (currentSession && currentSession.path === '') {
    // Reuse the existing draft — just update its project info
    draftId = currentSession.id;
    useSessionStore.getState().updateDraftProject(draftId, folderPath);
  } else {
    // No draft selected — create a new one
    draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().addDraftSession(draftId, folderPath);
  }

  // Pre-warm: spawn CLI process in background so first message is fast.
  // Send empty prompt — Rust will skip the NDJSON send.
  const preWarmId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const spawnConfig = await flushAndCaptureSpawnConfiguration();
    if (!spawnConfig.ok) return;
    const settings = useSettingsStore.getState();
    const permissionMode = mapSessionModeToPermissionMode(settings.sessionMode);

    // Ensure tab exists before writing sessionMeta
    useChatStore.getState().ensureTab(draftId);
    useChatStore.getState().setSessionMeta(draftId, {
      stdinReady: false,
      pendingReadyMessage: undefined,
    });

    // Use lifecycle module for unified spawn
    const spawnResult = await spawnSession({
      tabId: draftId,
      stdinId: preWarmId,
      cwdSnapshot: folderPath,
      configSnapshot: {
        model: spawnConfig.model,
        auxiliaryModel: spawnConfig.auxiliaryModel,
        providerId: spawnConfig.providerId,
        thinkingLevel: spawnConfig.thinkingLevel,
        permissionMode,
        agentTeamsEnabled: spawnConfig.agentTeamsEnabled,
      },
      sessionModeSnapshot: settings.sessionMode,
      sessionParams: {
        prompt: '',  // empty = pre-warm, no message sent
        cwd: folderPath,
        model: spawnConfig.model,
        auxiliary_model: spawnConfig.auxiliaryModel,
        auxiliary_model_tier: spawnConfig.auxiliaryModelTier,
        session_id: preWarmId,
        thinking_level: spawnConfig.thinkingLevel,
        provider_id: spawnConfig.providerId || undefined,
        permission_mode: permissionMode,
        agent_teams_enabled: spawnConfig.agentTeamsEnabled,
      },
      onStream: (msg: any) => {
        // Forward to InputBar's handler via a global
        const handler = (window as any).__claudeStreamHandler;
        if (handler) {
          const queue: any[] = (window as any).__claudeStreamQueue;
          if (queue && queue.length > 0) {
            const pending = queue.splice(0);
            for (const queued of pending) handler(queued);
          }
          handler(msg);
        } else {
          if (!(window as any).__claudeStreamQueue) (window as any).__claudeStreamQueue = [];
          (window as any).__claudeStreamQueue.push(msg);
        }
      },
      onStderr: (line: string) => {
        console.warn('[BLACKBOX] pre-warm stderr:', line);
      },
      setRunning: false,
    });

    // The CLI UUID is authoritative even if system:init arrived after this tab
    // moved to the background. Resolve the current stdin owner before writing
    // post-spawn metadata so no state is stranded under draft_*.
    const ownerBeforeAdoption = useSessionStore.getState().getTabForStdin(preWarmId) ?? draftId;
    const ownerTabId = spawnResult.sessionInfo.cli_session_id
      ? adoptCliSessionIdentity(
        ownerBeforeAdoption,
        spawnResult.sessionInfo.cli_session_id,
        preWarmId,
      )
      : ownerBeforeAdoption;
    // Write additional meta (uses pre-captured values to avoid race)
    useChatStore.getState().setSessionMeta(ownerTabId, {
      sessionId: spawnResult.sessionInfo.cli_session_id ?? undefined,
      envFingerprint: spawnConfig.envFingerprint,
      spawnedModel: spawnConfig.model,
      stdinReady: false,
      pendingReadyMessage: undefined,
      // Phase 2 §2.1: lock in the pre-warm spawn config hash so the first
      // real user submit can detect drift correctly.
      // Uses pre-computed value captured before async spawn to avoid
      // race with user config changes during the spawn window.
      spawnConfigHash: spawnConfig.configHash,
    });
  } catch {
    // Pre-warm failed — InputBar will spawn on first message instead
  }
}

/** Welcome screen shown when no project folder is selected */
function WelcomeScreen() {
  const t = useT();
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);
  const recentProjects = useFileStore((s) => s.recentProjects);
  const fetchProjects = useFileStore((s) => s.fetchRecentProjects);

  useEffect(() => { fetchProjects(); }, []);

  const handlePickFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('project.selectFolder'),
    });
    if (selected) {
      startDraftSession(selected as string);
    }
  }, [t]);

  // Show SetupWizard if setup has not been completed
  if (!setupCompleted) {
    return <SetupWizard />;
  }

  return (
    <div className="relative flex flex-col items-center justify-center h-full text-center overflow-hidden select-none">
      {/* Dot grid background */}
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-text-primary) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
      {/* Top accent glow */}
      <div
        className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] h-[500px]"
        style={{
          background: 'radial-gradient(ellipse 50% 60% at 50% 0%, var(--color-accent-glow), transparent)',
        }}
      />

      <div className="relative z-10 flex flex-col items-center -mt-16">
        {/* Wordmark */}
        <h1
          className="text-6xl font-bold tracking-tight mb-4"
          style={{ letterSpacing: '-0.04em' }}
        >
          <span className="text-text-primary">Black </span>
          <span className="text-accent">Box</span>
        </h1>

        <p className="text-text-muted text-[15px] mb-12 max-w-md leading-relaxed">
          {t('welcome.subtitle')}
        </p>

        {/* CTA button */}
        <button
          onClick={handlePickFolder}
          className="group relative inline-flex items-center gap-2.5
            px-6 py-2.5 rounded-xl text-[14px] font-medium
            bg-accent/10 text-accent
            border border-accent/20 hover:border-accent/40
            hover:bg-accent/15 transition-smooth"
        >
          <span className="w-5 h-5 rounded-md bg-accent/15 flex items-center justify-center
            group-hover:bg-accent/25 transition-smooth">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </span>
          {t('welcome.newChat')}
        </button>

        {/* Recent projects */}
        {recentProjects.length > 0 && (
          <div className="mt-16">
            <div className="text-[10px] font-medium text-text-tertiary
              uppercase tracking-[0.18em] mb-4">
              {t('welcome.recentProjects')}
            </div>
            <div className="flex flex-wrap justify-center gap-1.5 max-w-lg">
              {recentProjects.slice(0, 8).map((project) => (
                <button
                  key={project.path}
                  onClick={() => startDraftSession(project.path)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5
                    rounded-lg text-[13px] text-text-secondary
                    hover:text-text-primary hover:bg-bg-tertiary
                    transition-smooth"
                  title={project.shortPath}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-accent/40 flex-shrink-0" />
                  {project.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Empty state shown when project is selected but no messages yet */
function EmptyReadyState() {
  const t = useT();
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  return (
    <div className="relative flex flex-col items-center justify-center h-full text-center overflow-hidden select-none">
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-text-primary) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
      <div className="relative z-10 flex flex-col items-center -mt-8">
        <h2 className="text-2xl font-semibold text-text-primary mb-2 tracking-tight">
          {t('chat.welcome')}
        </h2>
        <p className="text-text-muted text-sm max-w-sm leading-relaxed">
          {t('chat.welcomeWithProject')}
        </p>
        {workingDirectory && (
          <p className="text-xs text-text-tertiary mt-3 truncate max-w-xs
            bg-bg-secondary px-3 py-1 rounded-md">
            {workingDirectory}
          </p>
        )}
      </div>
    </div>
  );
}
