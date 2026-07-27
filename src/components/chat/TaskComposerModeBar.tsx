import { useEffect, useMemo } from 'react';
import { validateNativeLoopInterval } from '../../lib/native-loop';
import { useT } from '../../lib/i18n';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  DEFAULT_COMPOSER_MODE_TAB,
  useComposerModeStore,
} from '../../stores/composerModeStore';
import { useWorkflowStore } from '../../stores/workflowStore';
import type { TaskComposerMode } from '../../lib/composer-mode';

export function TaskComposerModeBar({
  tabId,
  mode,
}: {
  tabId: string;
  mode: TaskComposerMode;
}) {
  const t = useT();
  const cwd = useSettingsStore((state) => state.workingDirectory);
  const config = useComposerModeStore((state) => state.tabs[tabId] || DEFAULT_COMPOSER_MODE_TAB);
  const clearTaskMode = useComposerModeStore((state) => state.clearTaskMode);
  const setWorkflowName = useComposerModeStore((state) => state.setWorkflowName);
  const setLoopInterval = useComposerModeStore((state) => state.setLoopInterval);
  const workflows = useWorkflowStore((state) => state.workflows);
  const loading = useWorkflowStore((state) => state.loading);
  const workflowError = useWorkflowStore((state) => state.error);
  const fetchWorkflows = useWorkflowStore((state) => state.fetchWorkflows);

  const effectiveWorkflows = useMemo(() => {
    const byName = new Map<string, (typeof workflows)[number]>();
    for (const workflow of workflows) {
      if (!byName.has(workflow.name)) byName.set(workflow.name, workflow);
    }
    return Array.from(byName.values());
  }, [workflows]);

  useEffect(() => {
    if (mode !== 'workflow') return;
    void fetchWorkflows(cwd || undefined);
  }, [cwd, fetchWorkflows, mode]);

  const selectedWorkflow = effectiveWorkflows.find(
    (workflow) => workflow.name === config.workflowName,
  );
  const intervalStatus = validateNativeLoopInterval(config.loopInterval);

  const openWorkflowManager = () => {
    useSettingsStore.getState().setMainView('extensions');
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('blackbox:extension-section', {
      detail: { section: 'workflows' },
    })));
  };

  return (
    <div
      data-testid="task-composer-mode-bar"
      data-task-mode={mode}
      className="mb-2 rounded-xl border border-accent/20 bg-accent/[0.045] px-3 py-2"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-accent">{t(`composerMode.${mode}`)}</span>
            <span className="text-[10px] text-text-tertiary">{t(`composerMode.${mode}Hint`)}</span>
          </div>

          {mode === 'workflow' && (
            <div className="mt-2 flex items-center gap-2">
              <select
                data-testid="workflow-select"
                value={config.workflowName}
                onChange={(event) => setWorkflowName(tabId, event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-input px-2 py-1.5
                  text-[11px] text-text-primary outline-none focus:border-border-focus"
              >
                <option data-testid="workflow-select-placeholder" value="">
                  {t('workflow.select')}
                </option>
                {effectiveWorkflows.map((workflow) => (
                  <option key={`${workflow.scope}:${workflow.path}`} value={workflow.name} disabled={!workflow.valid}>
                    {workflow.title || workflow.name} · {workflow.scope}
                    {workflow.valid ? '' : ` · ${t('workflow.invalid')}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={openWorkflowManager}
                className="rounded-md px-2 py-1 text-[10px] text-accent hover:bg-accent/10"
              >
                {t('workflow.manage')}
              </button>
              {loading && <span className="text-[10px] text-text-tertiary">{t('workflow.loading')}</span>}
              {workflowError && <span className="text-[10px] text-error">{workflowError}</span>}
            </div>
          )}

          {mode === 'workflow' && selectedWorkflow && (
            <div className="mt-1 truncate text-[10px] text-text-tertiary" title={selectedWorkflow.description}>
              {selectedWorkflow.description}
            </div>
          )}

          {mode === 'loop' && (
            <label className="mt-2 flex items-center gap-2">
              <span className="text-[10px] text-text-tertiary">{t('loop.interval')}</span>
              <input
                data-testid="loop-interval"
                value={config.loopInterval}
                onChange={(event) => setLoopInterval(tabId, event.target.value)}
                placeholder="5m"
                className="w-24 rounded-md border border-border-subtle bg-bg-input px-2 py-1
                  text-[11px] text-text-primary outline-none focus:border-border-focus"
              />
              {intervalStatus === 'invalid' && (
                <span className="text-[10px] text-error">{t('loop.intervalInvalid')}</span>
              )}
              {intervalStatus === 'durable' && (
                <span className="text-[10px] text-warning">{t('loop.useScheduled')}</span>
              )}
              {!config.loopInterval.trim() && (
                <span className="text-[10px] text-text-tertiary">{t('loop.dynamicHint')}</span>
              )}
            </label>
          )}
        </div>

        <button
          type="button"
          data-testid="task-composer-mode-close"
          onClick={() => clearTaskMode(tabId)}
          aria-label={t('common.close')}
          className="rounded-md p-1 text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
