import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTab } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorkflowStore } from '../../stores/workflowStore';
import { useCommandStore } from '../../stores/commandStore';
import type { LiveWorkflowRun } from '../../stores/workflowStore';
import { deriveNativeWorkflowRuns } from '../../lib/native-workflow';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';

const EMPTY_LIVE_WORKFLOW_RUNS: LiveWorkflowRun[] = [];

function statusTone(status: string | undefined): string {
  if (status === 'running' || status === 'launching') return 'bg-accent animate-pulse-soft';
  if (status === 'completed') return 'bg-success';
  if (status === 'failed') return 'bg-error';
  if (status === 'interrupted') return 'bg-warning';
  return 'bg-text-tertiary/40';
}

export function WorkflowControl({
  compact = false,
  active = false,
  disabled = false,
  onSelect,
}: {
  compact?: boolean;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const tabId = useSessionStore((state) => state.selectedSessionId);
  const messages = useActiveTab((tab) => tab.messages);
  const selectedLiveRuns = useWorkflowStore((state) => tabId ? state.liveRuns[tabId] : undefined);
  const liveRuns = selectedLiveRuns || EMPTY_LIVE_WORKFLOW_RUNS;
  const activeCwd = useCommandStore((state) => state.activeCwd);
  const runtimeInventory = useCommandStore((state) => state.runtimeByCwd[activeCwd]);
  const commands = useCommandStore((state) => state.commands);
  const nativeAvailable = Boolean(
    runtimeInventory?.capabilities?.some((capability) => capability === 'Workflow')
    || commands.some((command) => (
      ['/workflow-launch-exec', '/__remote-workflow'].includes(command.name.toLowerCase())
      && command.owner === 'claude'
      && command.runtime_available === true
    )),
  );
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => subscribeHeaderPopover('workflow', () => setOpen(false)), []);

  const transcriptRuns = useMemo(() => deriveNativeWorkflowRuns(messages), [messages]);
  const latestRun = liveRuns[0] || transcriptRuns[0];
  const latestRunName: string = latestRun
    ? ('requestedName' in latestRun && typeof latestRun.requestedName === 'string'
      ? latestRun.requestedName
      : typeof latestRun.workflowName === 'string' ? latestRun.workflowName : '')
    : '';
  const openManager = () => {
    useSettingsStore.getState().setMainView('extensions');
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('blackbox:extension-section', {
      detail: { section: 'workflows' },
    })));
    setOpen(false);
  };
  const selectMode = () => {
    setOpen(false);
    announceHeaderPopover('workflow');
    onSelect();
  };

  return (
    <div ref={ref} className="relative mr-1 flex items-center">
      <button
        type="button"
        data-testid="workflow-button"
        data-active={active ? 'true' : 'false'}
        data-workflow-status={latestRun?.status || 'idle'}
        onClick={selectMode}
        disabled={disabled || !nativeAvailable}
        data-runtime-available={nativeAvailable ? 'true' : 'false'}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]
          transition-smooth disabled:cursor-not-allowed disabled:opacity-40 ${active
            ? 'border-accent/40 bg-accent/15 text-accent'
            : latestRun?.status === 'running' || latestRun?.status === 'launching'
            ? 'border-accent/25 bg-accent/10 text-accent'
            : 'border-border-subtle text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'}`}
        title={nativeAvailable ? t('workflow.title') : t('workflow.unavailable')}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${statusTone(latestRun?.status)}`} />
        <span className={compact ? 'hidden' : 'max-[1040px]:hidden'}>Workflow</span>
        <span className={compact ? 'inline' : 'hidden max-[1040px]:inline'} aria-hidden="true">W</span>
      </button>

      <button
        type="button"
        data-testid="workflow-manage"
        onClick={() => setOpen((value) => {
          const next = !value;
          if (next) announceHeaderPopover('workflow');
          return next;
        })}
        aria-label={t('workflow.manage')}
        className="ml-0.5 rounded-md p-1 text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[400px] rounded-xl border
          border-border-subtle bg-bg-card p-3 shadow-xl" data-testid="workflow-popover">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-text-primary">{t('workflow.run')}</div>
              <div data-testid="workflow-explainer" className="mt-1 text-xs leading-relaxed text-text-tertiary">
                {nativeAvailable ? t('workflow.nativeHint') : t('workflow.unavailable')}
              </div>
            </div>
            <button type="button" onClick={openManager} className="text-[10px] text-accent hover:underline">
              {t('workflow.manage')}
            </button>
          </div>

          <div className="mt-3 space-y-3">
            <div className="rounded-lg border border-accent/15 bg-accent/[0.05] px-3 py-2
              text-[10px] leading-relaxed text-text-muted">
              {t('composerMode.useMainInput')}
            </div>
            {latestRun && (
              <div className="border-t border-border-subtle pt-2 text-[10px] text-text-tertiary">
                <span className="font-medium text-text-muted">{latestRunName}</span>
                <span> · {t(`workflow.status.${latestRun.status}`)}</span>
                {'phases' in latestRun && Array.isArray(latestRun.phases) && latestRun.phases.length > 0 && (
                  <span> · {latestRun.phases[latestRun.phases.length - 1].title}</span>
                )}
              </div>
            )}
            {!latestRun && (
              <div className="text-[10px] text-text-tertiary">{t('workflow.noneRunning')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
