import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTab } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useLoopStore } from '../../stores/loopStore';
import { useCommandStore } from '../../stores/commandStore';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';

function submitLoopCommand(tabId: string, command: string): void {
  window.dispatchEvent(new CustomEvent('blackbox:loop-submit', {
    detail: { tabId, command },
  }));
}

export function LoopControl({
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
  const allJobs = useLoopStore((state) => state.jobs);
  const commands = useCommandStore((state) => state.commands);
  const nativeAvailable = commands.some((command) => (
    command.name.toLowerCase() === '/loop'
    && command.owner === 'claude'
    && command.runtime_available === true
  ));
  const composerHasDraft = useActiveTab((tab) => Boolean(tab.inputDraft.trim()));
  const sessionLive = useActiveTab((tab) => Boolean(
    tab.sessionMeta.stdinId && tab.sessionMeta.stdinReady,
  ));
  const jobs = useMemo(
    () => allJobs.filter((job) => job.threadId === tabId),
    [allJobs, tabId],
  );
  const hasJobs = jobs.length > 0;
  const jobsRunning = sessionLive && jobs.some((job) => job.status === 'running');
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

  useEffect(() => subscribeHeaderPopover('loop', () => setOpen(false)), []);

  const cancel = (jobId: string) => {
    if (!tabId || composerHasDraft) return;
    submitLoopCommand(
      tabId,
      `Cancel current-session scheduled job ${jobId} using CronDelete. Do not change any other jobs.`,
    );
    setOpen(false);
  };

  const refresh = () => {
    if (!tabId || composerHasDraft) return;
    submitLoopCommand(
      tabId,
      'List current-session scheduled jobs using CronList. Do not create, modify, or delete any jobs.',
    );
    setOpen(false);
  };
  const selectMode = () => {
    setOpen(false);
    announceHeaderPopover('loop');
    onSelect();
  };

  return (
    <div ref={ref} className="relative mr-1 flex items-center">
      <button
        type="button"
        data-testid="loop-button"
        data-active={active ? 'true' : 'false'}
        data-loop-job-count={jobs.length}
        data-loop-live={jobsRunning ? 'true' : 'false'}
        onClick={selectMode}
        disabled={disabled || !nativeAvailable}
        data-runtime-available={nativeAvailable ? 'true' : 'false'}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px]
          transition-smooth disabled:cursor-not-allowed disabled:opacity-40 ${active
            ? 'border-accent/40 bg-accent/15 text-accent'
            : jobsRunning
            ? 'border-accent/25 bg-accent/10 text-accent'
            : hasJobs
              ? 'border-warning/25 bg-warning/10 text-warning'
            : 'border-border-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
          }`}
        title={!nativeAvailable
          ? t('loop.unavailable')
          : hasJobs && !sessionLive ? t('loop.resumePending') : t('loop.title')}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${jobsRunning
          ? 'bg-accent animate-pulse-soft'
          : hasJobs ? 'bg-warning' : 'bg-text-tertiary/40'}`} />
        <span className={compact ? 'hidden' : 'max-[1040px]:hidden'}>Loop</span>
        <span className={compact ? 'inline' : 'hidden max-[1040px]:inline'} aria-hidden="true">L</span>
        {jobs.length > 0 && <span>{jobs.length}</span>}
      </button>

      <button
        type="button"
        data-testid="loop-manage"
        onClick={() => setOpen((value) => {
          const next = !value;
          if (next) announceHeaderPopover('loop');
          return next;
        })}
        aria-label={t('loop.confirmedJobs')}
        className="ml-0.5 rounded-md p-1 text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[400px]
          rounded-xl border border-border-subtle bg-bg-card shadow-xl p-3"
          data-testid="loop-popover">
          <div className="space-y-3">
            <div>
              <div className="text-sm font-semibold text-text-primary">{t('loop.create')}</div>
              <div data-testid="loop-explainer" className="mt-1 text-xs leading-relaxed text-text-tertiary">
                {nativeAvailable ? t('loop.sessionHint') : t('loop.unavailable')}
              </div>
            </div>

            <div className="rounded-lg border border-accent/15 bg-accent/[0.05] px-3 py-2
              text-[10px] leading-relaxed text-text-muted">
              {t('composerMode.useMainInput')}
            </div>

            <div className="border-t border-border-subtle pt-3 space-y-2">
              {hasJobs && !sessionLive && (
                <div className="rounded-md border border-warning/20 bg-warning/10 px-2 py-1.5
                  text-[10px] leading-relaxed text-warning">
                  {t('loop.resumePending')}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  {t('loop.confirmedJobs')}
                </span>
                <button
                  type="button"
                  data-testid="loop-verify"
                  onClick={refresh}
                  disabled={!tabId || composerHasDraft}
                  className="text-[10px] text-accent hover:underline disabled:opacity-40"
                >
                  {t('loop.verify')}
                </button>
              </div>
              {jobs.length === 0 ? (
                <div className="text-[10px] text-text-tertiary">{t('loop.none')}</div>
              ) : jobs.map((job) => (
                <div key={job.jobId} className="rounded-lg border border-border-subtle bg-bg-secondary/50 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium text-text-primary">
                      {job.cron || t('loop.dynamic')}
                    </span>
                    <button
                      type="button"
                      data-loop-cancel-id={job.jobId}
                      onClick={() => cancel(job.jobId)}
                      disabled={composerHasDraft}
                      className="text-[10px] text-error hover:underline disabled:opacity-40"
                    >
                      {t('loop.cancel')}
                    </button>
                  </div>
                  <div className="mt-1 text-[9px] text-text-tertiary">ID {job.jobId}</div>
                </div>
              ))}
              <div className="text-[9px] leading-relaxed text-text-tertiary">
                {t('loop.receiptHint')}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
