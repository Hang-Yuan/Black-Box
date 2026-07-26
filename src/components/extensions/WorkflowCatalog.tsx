import { useEffect, useMemo, useState } from 'react';
import { useActiveTab } from '../../stores/chatStore';
import type { WorkflowPhase, WorkflowRecord, WorkflowScope } from '../../lib/tauri-bridge';
import { buildNativeWorkflowCommand } from '../../lib/native-workflow';
import { useT } from '../../lib/i18n';
import { useFileStore } from '../../stores/fileStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorkflowStore } from '../../stores/workflowStore';

type EditablePhase = Required<Pick<WorkflowPhase, 'title'>> & {
  detail: string;
  model: string;
  prompt: string;
};

function emptyPhase(index = 0): EditablePhase {
  return {
    title: index === 0 ? 'Execute' : `Phase ${index + 1}`,
    detail: '',
    model: '',
    prompt: '',
  };
}

function WorkflowEditor({ workflow, onClose }: {
  workflow: WorkflowRecord | null;
  onClose: () => void;
}) {
  const t = useT();
  const cwd = useSettingsStore((state) => state.workingDirectory);
  const saveWorkflow = useWorkflowStore((state) => state.saveWorkflow);
  const [scope, setScope] = useState<WorkflowScope>(workflow?.scope || 'project');
  const [name, setName] = useState(workflow?.name || '');
  const [title, setTitle] = useState(workflow?.title || '');
  const [description, setDescription] = useState(workflow?.description || '');
  const [whenToUse, setWhenToUse] = useState(workflow?.whenToUse || '');
  const [phases, setPhases] = useState<EditablePhase[]>(
    workflow?.phases.length
      ? workflow.phases.map((phase) => ({
        title: phase.title,
        detail: phase.detail || '',
        model: phase.model || '',
        prompt: phase.prompt || '',
      }))
      : [emptyPhase()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updatePhase = (index: number, patch: Partial<EditablePhase>) => {
    setPhases((current) => current.map((phase, phaseIndex) => (
      phaseIndex === index ? { ...phase, ...patch } : phase
    )));
  };

  const canSave = Boolean(
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)
    && description.trim()
    && phases.length > 0
    && phases.every((phase) => phase.title.trim() && phase.prompt.trim())
    && (scope === 'user' || cwd),
  );

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      await saveWorkflow({
        originalPath: workflow?.path || null,
        name,
        title: title.trim() || null,
        description,
        whenToUse: whenToUse.trim() || null,
        phases: phases.map((phase) => ({
          title: phase.title,
          detail: phase.detail.trim() || null,
          model: phase.model.trim() || null,
          prompt: phase.prompt,
        })),
        scope,
        cwd: cwd || null,
      });
      onClose();
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-accent/20 bg-bg-secondary/35 p-4" data-testid="workflow-editor">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">
            {workflow ? t('workflow.edit') : t('workflow.create')}
          </h3>
          <p className="mt-1 text-[10px] text-text-tertiary">{t('workflow.editorHint')}</p>
        </div>
        <button type="button" onClick={onClose} className="text-[11px] text-text-muted hover:text-text-primary">
          {t('common.cancel')}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block">
          <span className="text-[10px] text-text-tertiary">{t('workflow.scope')}</span>
          <select
            value={scope}
            disabled={Boolean(workflow)}
            onChange={(event) => setScope(event.target.value as WorkflowScope)}
            className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary"
          >
            <option value="project">{t('workflow.scopeProject')}</option>
            <option value="user">{t('workflow.scopeUser')}</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] text-text-tertiary">{t('workflow.name')}</span>
          <input
            data-testid="workflow-editor-name"
            value={name}
            readOnly={Boolean(workflow)}
            onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
            placeholder="release-review"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary outline-none focus:border-border-focus read-only:opacity-60"
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-text-tertiary">{t('workflow.displayTitle')}</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary outline-none focus:border-border-focus" />
        </label>
        <label className="block">
          <span className="text-[10px] text-text-tertiary">{t('workflow.whenToUse')}</span>
          <input value={whenToUse} onChange={(event) => setWhenToUse(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary outline-none focus:border-border-focus" />
        </label>
      </div>

      <label className="mt-3 block">
        <span className="text-[10px] text-text-tertiary">{t('workflow.description')}</span>
        <textarea value={description} onChange={(event) => setDescription(event.target.value)}
          className="mt-1 min-h-16 w-full resize-y rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary outline-none focus:border-border-focus" />
      </label>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">{t('workflow.phases')}</span>
          <button type="button" onClick={() => setPhases((current) => [...current, emptyPhase(current.length)])}
            className="text-[10px] text-accent hover:underline">{t('workflow.addPhase')}</button>
        </div>
        {phases.map((phase, index) => (
          <div key={index} className="rounded-xl border border-border-subtle bg-bg-primary/35 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold text-text-muted">{index + 1}</span>
              {phases.length > 1 && (
                <button type="button" onClick={() => setPhases((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  className="text-[10px] text-error hover:underline">{t('workflow.removePhase')}</button>
              )}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
              <input value={phase.title} onChange={(event) => updatePhase(index, { title: event.target.value })}
                placeholder={t('workflow.phaseTitle')}
                className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary outline-none focus:border-border-focus" />
              <input value={phase.detail} onChange={(event) => updatePhase(index, { detail: event.target.value })}
                placeholder={t('workflow.phaseDetail')}
                className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary outline-none focus:border-border-focus" />
            </div>
            <textarea value={phase.prompt} onChange={(event) => updatePhase(index, { prompt: event.target.value })}
              placeholder={t('workflow.phasePrompt')}
              className="mt-2 min-h-20 w-full resize-y rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary outline-none focus:border-border-focus" />
          </div>
        ))}
      </div>

      {scope === 'project' && !cwd && <div className="mt-3 text-[10px] text-warning">{t('workflow.projectRequired')}</div>}
      {error && <div className="mt-3 rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-[10px] text-error">{error}</div>}
      <div className="mt-4 flex justify-end">
        <button type="button" data-testid="workflow-editor-save" onClick={save} disabled={!canSave || saving}
          className="rounded-lg bg-accent px-4 py-2 text-[11px] font-medium text-text-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">
          {saving ? t('workflow.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

export function WorkflowCatalog() {
  const t = useT();
  const cwd = useSettingsStore((state) => state.workingDirectory);
  const setMainView = useSettingsStore((state) => state.setMainView);
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId);
  const composerHasDraft = useActiveTab((tab) => Boolean(tab.inputDraft.trim()));
  const workflows = useWorkflowStore((state) => state.workflows);
  const loading = useWorkflowStore((state) => state.loading);
  const error = useWorkflowStore((state) => state.error);
  const fetchWorkflows = useWorkflowStore((state) => state.fetchWorkflows);
  const requestRun = useWorkflowStore((state) => state.requestRun);
  const queueSubmission = useWorkflowStore((state) => state.queueSubmission);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<WorkflowRecord | null | undefined>(undefined);

  useEffect(() => {
    void fetchWorkflows(cwd || undefined);
  }, [cwd, fetchWorkflows]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return workflows.filter((workflow) => !normalized || [
      workflow.name,
      workflow.title || '',
      workflow.description,
      workflow.scope,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [query, workflows]);

  const openSource = (workflow: WorkflowRecord) => {
    useFileStore.getState().selectFile(workflow.path);
    setMainView('chat');
    useSettingsStore.getState().setSecondaryTab('files');
  };

  const run = (workflow: WorkflowRecord) => {
    if (!selectedSessionId || !workflow.valid || composerHasDraft) return;
    requestRun(selectedSessionId, workflow);
    const command = buildNativeWorkflowCommand(workflow.name, '');
    queueSubmission(selectedSessionId, workflow.name, command);
    setMainView('chat');
  };

  return (
    <div className="space-y-5" data-testid="extension-workflows-catalog">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" /><path d="m11 11 3 3" />
          </svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('workflow.search')}
            className="w-full rounded-xl border border-border-subtle bg-bg-secondary/45 py-2.5 pl-9 pr-3 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/60" />
        </div>
        <button type="button" onClick={() => setEditing(null)}
          className="rounded-lg bg-accent px-3 py-2 text-[11px] font-medium text-text-inverse hover:bg-accent-hover">
          {t('workflow.create')}
        </button>
        <button type="button" onClick={() => void fetchWorkflows(cwd || undefined)} disabled={loading}
          className="rounded-lg border border-border-subtle px-3 py-2 text-[11px] text-text-muted hover:bg-bg-secondary disabled:opacity-50">
          {loading ? t('workflow.loading') : t('plugins.refresh')}
        </button>
      </div>

      {editing !== undefined && <WorkflowEditor workflow={editing} onClose={() => setEditing(undefined)} />}
      {error && <div className="rounded-xl border border-error/25 bg-error/10 px-3 py-2 text-[11px] text-error">{error}</div>}

      {loading && workflows.length === 0 ? (
        <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-subtle py-16 text-center text-[12px] text-text-tertiary">
          {query ? t('workflow.noMatches') : t('workflow.none')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {filtered.map((workflow) => (
            <article key={`${workflow.scope}:${workflow.path}`}
              className={`rounded-2xl border p-4 transition-smooth ${workflow.valid
                ? 'border-border-subtle bg-bg-secondary/35 hover:border-accent/25'
                : 'border-error/20 bg-error/[0.04]'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-[13px] font-semibold text-text-primary">{workflow.title || workflow.name}</h3>
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[9px] uppercase text-text-tertiary">{workflow.scope}</span>
                    {!workflow.valid && <span className="text-[9px] font-medium text-error">{t('workflow.invalid')}</span>}
                  </div>
                  <p className={`mt-1 line-clamp-2 text-[11px] leading-5 ${workflow.valid ? 'text-text-muted' : 'text-error'}`}>
                    {workflow.valid ? workflow.description : workflow.error}
                  </p>
                </div>
                <span className="text-[9px] text-text-tertiary">{workflow.contentDigest.slice(0, 8)}</span>
              </div>
              {workflow.phases.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {workflow.phases.map((phase, index) => (
                    <span key={`${phase.title}:${index}`} className="rounded-md border border-border-subtle px-2 py-1 text-[9px] text-text-tertiary">
                      {index + 1}. {phase.title}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => run(workflow)} disabled={!selectedSessionId || !workflow.valid || composerHasDraft}
                  className="rounded-lg bg-accent/10 px-3 py-1.5 text-[10px] font-medium text-accent hover:bg-accent/15 disabled:opacity-40">
                  {t('workflow.start')}
                </button>
                <button type="button" onClick={() => openSource(workflow)}
                  className="rounded-lg border border-border-subtle px-3 py-1.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-primary">
                  {t('extensions.openSource')}
                </button>
                {workflow.blackBoxManaged && workflow.valid && (
                  <button type="button" onClick={() => setEditing(workflow)}
                    className="rounded-lg border border-border-subtle px-3 py-1.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-primary">
                    {t('workflow.edit')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
