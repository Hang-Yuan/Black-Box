import { useEffect, useRef, useState } from 'react';
import { bridge } from '../../lib/tauri-bridge';
import { buildConversationHandoff, formatHandoffSummary, validateHandoffSummary, type GeneratedHandoff } from '../../lib/conversation-handoff';
import { useT } from '../../lib/i18n';
import { isSessionBusy, useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useProviderStore } from '../../stores/providerStore';
import { useAgentStore } from '../../stores/agentStore';
import { switchConversationFileState } from '../../stores/fileStore';
import { inheritContinuationRuntimePreference } from '../../lib/conversation-runtime-preferences';

export function ConversationHandoff({ sourceId, model }: { sourceId: string; model: string }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.locale);
  const source = useSessionStore((s) => s.sessions.find((item) => item.id === sourceId));
  const tab = useChatStore((s) => s.tabs.get(sourceId));
  const request = useRef<string | null>(null);
  const alive = useRef(true);
  const [phase, setPhase] = useState<'idle' | 'generating' | 'ready' | 'opening'>('idle');
  const [generated, setGenerated] = useState<GeneratedHandoff | null>(null);
  const [error, setError] = useState('');
  const busy = isSessionBusy(tab?.sessionStatus ?? 'idle') || tab?.sessionMeta.hydratingFromDisk;
  const hasInteraction = tab?.messages.some((message) =>
    ['question', 'plan_review', 'permission'].includes(message.type) && !message.resolved);
  const hasQueue = Boolean(tab?.pendingUserMessages.length);
  const sourceReady = Boolean(source?.cliResumeId && source.path && model && !busy && !hasInteraction && !hasQueue);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (request.current) void bridge.cancelConversationHandoff(request.current).catch(() => {});
      request.current = null;
    };
  }, []);

  const showError = (value: unknown) => {
    const code = String(value);
    const key = code.includes('SOURCE_CHANGED') ? 'handoffSummary.changed'
      : code.includes('TOO_LONG') ? 'handoffSummary.tooLong'
      : code.includes('CLI_UNSUPPORTED') ? 'handoffSummary.unsupported'
      : code.includes('TIMED_OUT') ? 'handoffSummary.timedOut'
      : code.includes('UNKNOWN_REFERENCE') ? 'handoffSummary.unknownReference'
      : /INVALID_SUMMARY|INCOMPLETE_SUMMARY|EMPTY_SUMMARY/.test(code) ? 'handoffSummary.invalid'
      : code.includes('BUSY') ? 'handoffSummary.busy'
      : 'handoffSummary.failed';
    setError(t(key));
  };

  const generate = async () => {
    if (!sourceReady || !source || request.current || phase === 'opening') return;
    const id = crypto.randomUUID();
    request.current = id;
    setPhase('generating'); setError(''); setGenerated(null);
    try {
      const meta = useChatStore.getState().getTab(sourceId)?.sessionMeta;
      const provider = meta?.snapshotProviderId !== undefined ? meta.snapshotProviderId : useProviderStore.getState().activeProviderId;
      const result = await bridge.generateConversationHandoff(id, source.cliResumeId!, model, provider ?? null, locale);
      if (!alive.current || request.current !== id) return;
      if (!validateHandoffSummary(result.summary)) throw new Error('HANDOFF_INVALID_SUMMARY');
      setGenerated(result); setPhase('ready');
    } catch (err) {
      if (!alive.current || request.current !== id) return;
      showError(err); setPhase('idle');
    } finally {
      if (request.current === id) request.current = null;
    }
  };

  const cancel = () => {
    const id = request.current;
    request.current = null;
    if (id) void bridge.cancelConversationHandoff(id).catch(() => {});
    setGenerated(null); setError(''); setPhase('idle');
  };

  const openDraft = async () => {
    if (!generated || !sourceReady || !source || phase !== 'ready') return;
    setPhase('opening'); setError('');
    try {
      const id = `draft_${crypto.randomUUID()}`;
      await inheritContinuationRuntimePreference(sourceId, id);
      await bridge.validateConversationHandoff(source.cliResumeId!, generated.sourceDigest);
      if (!alive.current || useSessionStore.getState().selectedSessionId !== sourceId) return;
      const current = useChatStore.getState().getTab(sourceId);
      if (!current || isSessionBusy(current.sessionStatus) || current.pendingUserMessages.length) throw new Error('HANDOFF_SOURCE_CHANGED');
      const title = useSessionStore.getState().getDisplayName(source);
      const text = buildConversationHandoff(generated, title, locale);
      const chat = useChatStore.getState();
      // Preserve the source composer and attachments; a new draft owns its input.
      chat.saveToCache(sourceId); chat.ensureTab(id); chat.setInputDraft(id, text);
      useSessionStore.getState().addContinuationDraft(id, generated.sourceCwd, sourceId, t('conv.newChat'));
      switchConversationFileState(sourceId, id);
      useAgentStore.getState().clearAgents();
    } catch (err) {
      if (alive.current) { showError(err); setPhase('ready'); }
    }
  };

  return <div className="mx-4 mb-2 rounded-md border border-border-subtle px-3 py-2 text-xs text-text-muted" data-testid="conversation-handoff">
    <div className="flex items-center justify-between gap-3">
      <span>{phase === 'generating' ? t('handoffSummary.generating') : t('chat.longSessionHandoffHint')}</span>
      {phase === 'generating'
        ? <button className="shrink-0 text-accent" onClick={cancel}>{t('common.cancel')}</button>
        : <button className="shrink-0 text-accent disabled:opacity-40" disabled={!sourceReady || phase === 'opening'} onClick={generate}>
          {generated ? t('handoffSummary.regenerate') : t('handoffSummary.generate')}
        </button>}
    </div>
    {error && <p className="mt-2 text-status-error" role="alert">{error}</p>}
    {generated && <div className="mt-3 space-y-3">
      <p>{t('handoffSummary.review')}</p>
      <div className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded border border-border-subtle p-3 text-sm text-text-primary" data-testid="handoff-summary-preview">
        {formatHandoffSummary(generated.summary, locale)}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>{t('handoffSummary.size').replace('{count}', String([...formatHandoffSummary(generated.summary, locale)].length))}</span>
        <div className="flex gap-3">
          <button disabled={phase === 'opening'} onClick={cancel}>{t('common.close')}</button>
          <button className="text-accent disabled:opacity-40" disabled={!sourceReady || phase === 'opening'} onClick={openDraft}>{t('chat.longSessionHandoff')}</button>
        </div>
      </div>
    </div>}
  </div>;
}
