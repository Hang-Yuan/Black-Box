import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, type CreateHookRequest, type HookDefinitionInfo } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ConfirmDialog } from '../shared/ConfirmDialog';

const editableHookScopes: CreateHookRequest['scope'][] = ['user', 'project', 'local'];
const editableHandlerTypes: CreateHookRequest['handlerType'][] = ['command', 'http', 'prompt', 'agent', 'mcp_tool'];

const canEditHook = (hook: HookDefinitionInfo) => (
  editableHookScopes.includes(hook.scope as CreateHookRequest['scope'])
  && editableHandlerTypes.includes(hook.handlerType as CreateHookRequest['handlerType'])
);

const emptyHookDraft = (): CreateHookRequest => ({
  scope: 'user',
  event: 'UserPromptSubmit',
  matcher: '',
  handlerType: 'command',
  value: '',
  timeoutSeconds: 30,
});

export function HookCatalog() {
  const t = useT();
  const workingDirectory = useSettingsStore((state) => state.workingDirectory);
  const setMainView = useSettingsStore((state) => state.setMainView);
  const [hooks, setHooks] = useState<HookDefinitionInfo[]>([]);
  const [supportedHookEvents, setSupportedHookEvents] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingHook, setEditingHook] = useState<HookDefinitionInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HookDefinitionInfo | null>(null);
  const [draft, setDraft] = useState<CreateHookRequest>(emptyHookDraft);
  const loadGeneration = useRef(0);
  const workingDirectoryRef = useRef(workingDirectory);
  workingDirectoryRef.current = workingDirectory;

  const load = async (directory = workingDirectory) => {
    if (workingDirectoryRef.current !== directory) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const [nextHooks, nextEvents] = await Promise.all([
        bridge.listHookDefinitions(directory || undefined),
        bridge.listHookEvents(),
      ]);
      if (loadGeneration.current !== generation || workingDirectoryRef.current !== directory) return;
      setHooks(nextHooks);
      setSupportedHookEvents(nextEvents);
      setError('');
    } catch (reason) {
      if (loadGeneration.current !== generation || workingDirectoryRef.current !== directory) return;
      setError(String(reason));
    } finally {
      if (loadGeneration.current === generation && workingDirectoryRef.current === directory) setLoading(false);
    }
  };

  useEffect(() => {
    setEditingHook(null);
    setDeleteTarget(null);
    setShowCreate(false);
    void load(workingDirectory);
  }, [workingDirectory]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return hooks.filter((hook) => !normalized || [
      hook.event,
      hook.matcher,
      hook.handlerType,
      hook.summary,
      hook.scope,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [hooks, query]);

  const hookEvents = useMemo(() => Array.from(new Set([
    ...supportedHookEvents,
    ...(editingHook ? [editingHook.event] : []),
  ])), [supportedHookEvents, editingHook]);

  const openConfig = (hook: HookDefinitionInfo) => {
    if (!hook.path) return;
    useFileStore.getState().selectFile(hook.path);
    setMainView('chat');
    useSettingsStore.getState().setSecondaryTab('files');
  };

  const startCreate = () => {
    setEditingHook(null);
    setDraft(emptyHookDraft());
    setShowCreate(true);
  };

  const startEdit = (hook: HookDefinitionInfo) => {
    if (!canEditHook(hook)) return;
    setEditingHook(hook);
    setDraft({
      scope: hook.scope as CreateHookRequest['scope'],
      event: hook.event,
      matcher: hook.matcher,
      handlerType: hook.handlerType as CreateHookRequest['handlerType'],
      value: hook.handlerValue || hook.summary,
      timeoutSeconds: hook.timeoutSeconds || 30,
    });
    setShowCreate(true);
  };

  const closeEditor = () => {
    setEditingHook(null);
    setShowCreate(false);
    setDraft(emptyHookDraft());
  };

  const saveHook = async () => {
    if (!draft.value.trim()) return;
    const operationDirectory = workingDirectory;
    setSaving(true);
    try {
      if (editingHook) {
        await bridge.updateHookDefinition(editingHook, draft, operationDirectory || undefined);
      } else {
        await bridge.createHookDefinition(draft, operationDirectory || undefined);
      }
      closeEditor();
      if (workingDirectoryRef.current === operationDirectory) await load(operationDirectory);
    } catch (reason) {
      if (workingDirectoryRef.current === operationDirectory) setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeHook = async () => {
    if (!deleteTarget) return;
    const operationDirectory = workingDirectory;
    setSaving(true);
    try {
      await bridge.deleteHookDefinition(deleteTarget, operationDirectory || undefined);
      setDeleteTarget(null);
      if (workingDirectoryRef.current === operationDirectory) await load(operationDirectory);
    } catch (reason) {
      if (workingDirectoryRef.current === operationDirectory) setError(String(reason));
    } finally {
      setSaving(false);
    }
  };


  return (
    <div className="space-y-5" data-testid="extension-hooks-catalog">
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/35 px-4 py-3 text-[11px] leading-5 text-text-muted">
        {t('extensions.hooksReadOnly')}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" /><path d="m11 11 3 3" />
          </svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t('extensions.searchHooks')}
            className="w-full rounded-xl border border-border-subtle bg-bg-secondary/45 py-2.5 pl-9 pr-3 text-[12px] text-text-primary outline-none transition-smooth placeholder:text-text-tertiary focus:border-accent/60 focus:bg-bg-secondary" />
        </div>
        <button type="button" onClick={() => void load(workingDirectory)} disabled={loading}
          className="rounded-lg border border-border-subtle px-3 py-2 text-[11px] text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary disabled:opacity-50">
          {loading ? t('plugins.loading') : t('plugins.refresh')}
        </button>
        <button type="button" onClick={() => (showCreate ? closeEditor() : startCreate())}
          className="rounded-lg bg-accent px-3 py-2 text-[11px] font-medium text-white transition-smooth hover:brightness-110">
          {showCreate ? t('common.cancel') : t('extensions.addHook')}
        </button>
      </div>

      {showCreate && (
        <div className="rounded-2xl border border-accent/25 bg-accent/5 p-4" data-testid="hook-create-form">
          <div className="mb-3 text-[12px] font-medium text-text-primary">
            {editingHook ? t('extensions.editHook') : t('extensions.addHook')}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1 text-[10px] text-text-tertiary">
              <span>{t('extensions.hookScope')}</span>
              <select value={draft.scope} disabled={Boolean(editingHook)} onChange={(event) => setDraft({ ...draft, scope: event.target.value as CreateHookRequest['scope'] })}
                className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[11px] text-text-primary outline-none">
                <option value="user">{t('extensions.scopeUser')}</option>
                <option value="project" disabled={!workingDirectory}>{t('extensions.scopeProject')}</option>
                <option value="local" disabled={!workingDirectory}>{t('extensions.scopeLocal')}</option>
              </select>
            </label>
            <label className="space-y-1 text-[10px] text-text-tertiary">
              <span>{t('extensions.hookEvent')}</span>
              <select value={draft.event} onChange={(event) => setDraft({ ...draft, event: event.target.value })}
                className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[11px] text-text-primary outline-none">
                {hookEvents.map((event) => <option key={event} value={event}>{event}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-[10px] text-text-tertiary">
              <span>{t('extensions.hookType')}</span>
              <select value={draft.handlerType} onChange={(event) => setDraft({ ...draft, handlerType: event.target.value as CreateHookRequest['handlerType'] })}
                className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[11px] text-text-primary outline-none">
                {['command', 'http', 'prompt', 'agent', 'mcp_tool'].map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_110px]">
            <label className="space-y-1 text-[10px] text-text-tertiary">
              <span>{t('extensions.matcher')}</span>
              <input value={draft.matcher || ''} onChange={(event) => setDraft({ ...draft, matcher: event.target.value })}
                placeholder="*"
                className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[11px] text-text-primary outline-none placeholder:text-text-tertiary" />
            </label>
            {(draft.handlerType === 'command' || draft.handlerType === 'http') && (
              <label className="space-y-1 text-[10px] text-text-tertiary">
                <span>{t('extensions.hookTimeout')}</span>
                <input type="number" min={1} max={600} value={draft.timeoutSeconds || 30}
                  onChange={(event) => setDraft({ ...draft, timeoutSeconds: Number(event.target.value) })}
                  className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[11px] text-text-primary outline-none" />
              </label>
            )}
          </div>
          <label className="mt-3 block space-y-1 text-[10px] text-text-tertiary">
            <span>{t('extensions.hookHandler')}</span>
            <textarea value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })}
              rows={3} placeholder={t('extensions.hookHandlerPlaceholder')}
              className="w-full resize-y rounded-xl border border-border-subtle bg-bg-primary px-3 py-2 text-[11px] leading-5 text-text-primary outline-none placeholder:text-text-tertiary" />
          </label>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[10px] leading-4 text-text-tertiary">{t('extensions.hookCreateHint')}</p>
            <button type="button" disabled={saving || !draft.value.trim()} onClick={() => void saveHook()}
              className="flex-shrink-0 rounded-lg bg-accent px-4 py-2 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
              {saving
                ? t('plugins.loading')
                : t(editingHook ? 'extensions.saveHook' : 'extensions.createHook')}
            </button>
          </div>
        </div>
      )}

      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-[11px] text-red-500">{error}</div>}
      {loading && hooks.length === 0 ? (
        <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-subtle py-16 text-center text-[12px] text-text-tertiary">
          {query ? t('extensions.noHookMatches') : t('extensions.noHooks')}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((hook) => (
            <article key={`${hook.path}:${hook.id}`} className="rounded-2xl border border-border-subtle bg-bg-secondary/35 p-4 transition-smooth hover:border-accent/25 hover:bg-bg-secondary/55">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.2 2.1v8.3a4 4 0 1 1-4-4" /><path d="m6.9 4.3 2.3-2.2 2.2 2.2" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-text-primary">{hook.event}</h3>
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[9px] uppercase text-text-tertiary">{hook.scope}</span>
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[9px] text-accent">{hook.handlerType}</span>
                    {hook.disabledBySource && <span className="text-[9px] font-medium text-amber-500">{t('extensions.disableAllDeclared')}</span>}
                  </div>
                  <div className="mt-1 text-[10px] text-text-tertiary">{t('extensions.matcher')}: {hook.matcher || '*'}</div>
                  <p className="mt-2 break-all text-[11px] leading-5 text-text-muted">{hook.summary}</p>
                </div>
                {hook.path ? (
                  <div className="flex flex-shrink-0 flex-wrap justify-end gap-1.5">
                    {editableHookScopes.includes(hook.scope as CreateHookRequest['scope']) && (
                      <>
                        {canEditHook(hook) && (
                          <button type="button" onClick={() => startEdit(hook)}
                            className="rounded-lg border border-border-subtle px-2.5 py-1.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-primary">
                            {t('common.edit')}
                          </button>
                        )}
                        <button type="button" onClick={() => setDeleteTarget(hook)}
                          className="rounded-lg border border-red-500/20 px-2.5 py-1.5 text-[10px] text-red-500 hover:bg-red-500/10">
                          {t('common.delete')}
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => openConfig(hook)}
                      className="rounded-lg border border-border-subtle px-2.5 py-1.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-primary">
                      {t('extensions.openConfig')}
                    </button>
                  </div>
                ) : (
                  <span className="flex-shrink-0 rounded-full bg-accent/10 px-2.5 py-1 text-[9px] font-medium text-accent">
                    {t('extensions.builtIn')}
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t('extensions.deleteHook')}
        message={t(deleteTarget?.scope === 'project'
          ? 'extensions.deleteProjectHookConfirm'
          : 'extensions.deleteHookConfirm')}
        detail={deleteTarget
          ? `${deleteTarget.scope} · ${deleteTarget.event} · ${deleteTarget.matcher || '*'} · ${deleteTarget.summary} · ${deleteTarget.path}`
          : undefined}
        confirmLabel={t('common.delete')}
        variant="danger"
        onConfirm={() => void removeHook()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
