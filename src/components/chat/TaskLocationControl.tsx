import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge, type TaskLocationStatus, type TaskRunLocation } from '../../lib/tauri-bridge';
import { teardownSession, waitForStdinCleared } from '../../lib/sessionLifecycle';
import { useT } from '../../lib/i18n';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { showToast } from '../shared/Toast';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';

function isSessionUuid(value: string | null | undefined): value is string {
  return !!value
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function LocationIcon({ location }: { location: TaskRunLocation }) {
  if (location === 'local') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="12" height="9" rx="1.5" />
        <path d="M5 14h6M8 12v2" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="4" cy="13" r="1.5" />
      <path d="M4 4.5v7M5.5 5.5h3A3.5 3.5 0 0 0 12 2" />
    </svg>
  );
}

export function TaskLocationControl({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const workingDirectory = useSettingsStore((state) => state.workingDirectory);
  const [status, setStatus] = useState<TaskLocationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  const cliSessionId = useMemo(() => {
    if (isSessionUuid(selectedSession?.cliResumeId)) return selectedSession.cliResumeId;
    if (isSessionUuid(selectedSessionId)) return selectedSessionId;
    return null;
  }, [selectedSession, selectedSessionId]);

  useEffect(() => {
    if (!cliSessionId || !workingDirectory || !selectedSession || selectedSession.path === '') {
      setStatus(null);
      setOpen(false);
      return;
    }
    let cancelled = false;
    bridge.getTaskLocation(cliSessionId, workingDirectory)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // A task outside Git cannot use worktree handoff, so omit the control.
        if (!cancelled) setStatus(null);
      });
    return () => { cancelled = true; };
  }, [cliSessionId, selectedSession, workingDirectory]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => subscribeHeaderPopover('task-location', () => setOpen(false)), []);

  const handoff = useCallback(async () => {
    if (!status || !cliSessionId || !selectedSessionId || busy) return;
    const destination: TaskRunLocation = status.currentLocation === 'local' ? 'worktree' : 'local';
    setBusy(true);
    try {
      const tab = useChatStore.getState().getTab(selectedSessionId);
      const stdinId = tab?.sessionMeta.stdinId;
      if (stdinId) {
        await teardownSession(stdinId, selectedSessionId, 'switch');
        await waitForStdinCleared(selectedSessionId, stdinId);
      }

      const currentCwd = useSettingsStore.getState().workingDirectory;
      const next = await bridge.handoffTask(cliSessionId, currentCwd, destination);
      useSessionStore.getState().updateSessionProject(selectedSessionId, next.currentCwd);
      if (useSessionStore.getState().selectedSessionId === selectedSessionId) {
        useSettingsStore.getState().setWorkingDirectory(next.currentCwd);
      }
      useChatStore.getState().setSessionMeta(selectedSessionId, { cwdSnapshot: next.currentCwd });
      setStatus(next);
      setOpen(false);
      await useSessionStore.getState().fetchSessions();
      showToast(
        t(next.currentLocation === 'local' ? 'handoff.successLocal' : 'handoff.successWorktree'),
        'success',
      );
    } catch (error) {
      showToast(`${t('handoff.failed')}: ${errorMessage(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, cliSessionId, selectedSessionId, status, t]);

  if (!status) return null;
  const destination = status.currentLocation === 'local' ? 'worktree' : 'local';
  const destinationLabel = t(destination === 'local' ? 'handoff.toLocal' : 'handoff.toWorktree');
  const explanation = destination === 'local'
    ? t('handoff.returnsLocal')
    : t(status.worktreeExists ? 'handoff.reusesWorktree' : 'handoff.createsWorktree');

  return (
    <div className="relative ml-2" ref={rootRef}>
      <button
        type="button"
        data-testid="task-location-control"
        data-location={status.currentLocation}
        onClick={() => setOpen((value) => {
          const next = !value;
          if (next) announceHeaderPopover('task-location');
          return next;
        })}
        disabled={busy}
        title={`${t('handoff.current')}: ${status.currentCwd}`}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border-subtle
          bg-bg-secondary/40 hover:bg-bg-tertiary text-[9px] text-text-tertiary
          transition-smooth disabled:opacity-50 disabled:cursor-wait"
      >
        <LocationIcon location={status.currentLocation} />
        {!compact && (
          <>
            <span>{t(status.currentLocation === 'local' ? 'handoff.local' : 'handoff.worktree')}</span>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="m2 3 2 2 2-2" />
            </svg>
          </>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-80 rounded-xl border border-border-subtle
          bg-bg-primary shadow-xl p-3 text-left">
          <div className="text-[10px] uppercase tracking-wide text-text-tertiary">
            {t('handoff.current')}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-text-primary">
            <LocationIcon location={status.currentLocation} />
            <span>{t(status.currentLocation === 'local' ? 'handoff.local' : 'handoff.worktree')}</span>
          </div>
          <div className="mt-1 text-[10px] text-text-tertiary break-all leading-relaxed">
            {status.currentCwd}
          </div>
          {status.releasedBranch && (
            <div className="mt-2 text-[10px] text-text-muted">
              {t('handoff.branchReleased').replace('{branch}', status.releasedBranch)}
            </div>
          )}
          <div className="my-3 h-px bg-border-subtle" />
          <div className="text-[11px] text-text-muted leading-relaxed">{explanation}</div>
          <div className="mt-1 text-[10px] text-text-tertiary leading-relaxed">{t('handoff.stopHint')}</div>
          <button
            type="button"
            data-testid="task-location-handoff"
            data-destination={destination}
            onClick={handoff}
            disabled={busy}
            className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2
              bg-accent text-white text-xs font-medium hover:brightness-110 transition-smooth
              disabled:opacity-60 disabled:cursor-wait"
          >
            <LocationIcon location={destination} />
            {busy ? t('handoff.moving') : destinationLabel}
          </button>
        </div>
      )}
    </div>
  );
}
