import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import { open } from '@tauri-apps/plugin-dialog';
import { bridge, type AutomationDefinition, type AutomationRun, type AutomationSummary, type AutomationWorktreeFileDiff, type AutomationWorktreeReview } from '../../lib/tauri-bridge';
import {
  createAutomationDraft,
  isAutomationDraftComplete,
  prepareAutomationDefinitionForSave,
} from '../../lib/automation-form';
import { useT } from '../../lib/i18n';
import { normalizeModelTier, useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { stripFinalInboxDirective } from '../../lib/automation-output';
import { InlinePatchReview } from '../review/InlinePatchReview';
import { formatReviewFeedback } from '../../lib/review-feedback';
import { useReviewStore } from '../../stores/reviewStore';
import { useProviderStore } from '../../stores/providerStore';
import { getModelDisplayOptions, getSelectedModelOptionId } from '../../lib/api-provider';

type Frequency = 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY';

const DAY_OPTIONS = [
  'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU',
] as const;
const WORKTREE_RETENTION_OPTIONS = [5, 10, 15, 25, 50] as const;

function rruleField(rrule: string, name: string): string | undefined {
  const raw = rrule.replace(/^RRULE:/, '');
  return raw.split(';').map((part) => part.split('=')).find(([key]) => key === name)?.[1];
}

function parseFormRule(rrule: string) {
  const frequency = (rruleField(rrule, 'FREQ') || 'DAILY') as Frequency;
  const hour = rruleField(rrule, 'BYHOUR') || '09';
  const minute = rruleField(rrule, 'BYMINUTE') || '00';
  const interval = rruleField(rrule, 'INTERVAL') || '1';
  const days = (rruleField(rrule, 'BYDAY') || 'MO,WE,FR').split(',');
  return { frequency, time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`, interval, days };
}

function buildRule(frequency: Frequency, time: string, interval: string, days: string[]): string {
  const [hour, minute] = time.split(':').map((value) => Number(value));
  const safeInterval = Math.max(1, Number(interval) || 1);
  if (frequency === 'MINUTELY') return `FREQ=MINUTELY;INTERVAL=${safeInterval}`;
  if (frequency === 'HOURLY') return `FREQ=HOURLY;INTERVAL=${safeInterval};BYMINUTE=${minute || 0};BYSECOND=0`;
  if (frequency === 'WEEKLY') {
    const selected = days.length ? days.join(',') : 'MO';
    return `FREQ=WEEKLY;INTERVAL=${safeInterval};BYDAY=${selected};BYHOUR=${hour || 0};BYMINUTE=${minute || 0};BYSECOND=0`;
  }
  return `FREQ=DAILY;INTERVAL=${safeInterval};BYHOUR=${hour || 0};BYMINUTE=${minute || 0};BYSECOND=0`;
}

function formatTime(value: number | null, locale: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function statusColor(status: string) {
  if (status === 'FAILED') return 'text-red-500 bg-red-500/10';
  if (status === 'CANCELLED') return 'text-text-muted bg-bg-tertiary';
  if (status === 'RUNNING') return 'text-blue-500 bg-blue-500/10';
  if (status === 'PENDING_REVIEW') return 'text-amber-500 bg-amber-500/10';
  return 'text-text-muted bg-bg-tertiary';
}

function traceDotColor(eventType: string, summary: string) {
  if (summary === 'Failed') return 'bg-red-500';
  if (eventType === 'agent_start') return 'bg-violet-500';
  if (eventType === 'agent_result') return 'bg-emerald-500';
  return eventType === 'tool_use' ? 'bg-accent' : 'bg-emerald-500';
}

function traceSummary(eventType: string, summary: string, t: (key: string) => string) {
  if (eventType === 'agent_start') return t('automations.trace.agentStarted');
  if (eventType === 'agent_result') return summary === 'Failed' ? t('automations.trace.agentFailed') : t('automations.trace.agentCompleted');
  if (eventType === 'tool_use') return summary;
  return summary === 'Failed' ? t('automations.trace.failed') : t('automations.trace.completed');
}

function defaultWorktreeBranchName(run: AutomationRun): string {
  const slug = (run.title || 'scheduled-run')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'scheduled-run';
  return `blackbox/${slug}-${run.runId.slice(0, 8)}`;
}

interface AutomationsTabProps {
  standalone?: boolean;
  onClose?: () => void;
}

export function AutomationsTab({ standalone = false, onClose }: AutomationsTabProps = {}) {
  const t = useT();
  const locale = useSettingsStore((state) => state.locale);
  const selectedModel = useSettingsStore((state) => state.selectedModel);
  const auxiliaryModel = useSettingsStore((state) => state.auxiliaryModel);
  const workingDirectory = useSettingsStore((state) => state.workingDirectory);
  const sessions = useSessionStore((state) => state.sessions);
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId);
  const customPreviews = useSessionStore((state) => state.customPreviews);
  const reviewCommentMap = useReviewStore((state) => state.comments);
  const providers = useProviderStore((state) => state.providers);
  const activeProviderId = useProviderStore((state) => state.activeProviderId);
  const providersLoaded = useProviderStore((state) => state.loaded);
  const [items, setItems] = useState<AutomationSummary[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);
  const [frequency, setFrequency] = useState<Frequency>('DAILY');
  const [time, setTime] = useState('09:00');
  const [interval, setIntervalValue] = useState('1');
  const [days, setDays] = useState<string[]>(['MO', 'WE', 'FR']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [worktreeAvailable, setWorktreeAvailable] = useState<boolean | null>(null);
  const [launchAtLogin, setLaunchAtLogin] = useState<boolean | null>(null);
  const [launchAtLoginBusy, setLaunchAtLoginBusy] = useState(false);
  const [launchAtLoginError, setLaunchAtLoginError] = useState('');
  const [worktreeRetentionLimit, setWorktreeRetentionLimit] = useState<number | null | undefined>(undefined);
  const [worktreeRetentionBusy, setWorktreeRetentionBusy] = useState(false);
  const [worktreeRetentionError, setWorktreeRetentionError] = useState('');
  const [worktreeActionRunId, setWorktreeActionRunId] = useState<string | null>(null);
  const [continuingRunId, setContinuingRunId] = useState<string | null>(null);
  const [branchEditor, setBranchEditor] = useState<{ runId: string; name: string } | null>(null);
  const [worktreeReviews, setWorktreeReviews] = useState<Record<string, {
    loading: boolean;
    data?: AutomationWorktreeReview;
    error?: string;
  }>>({});
  const [worktreeFileDiffs, setWorktreeFileDiffs] = useState<Record<string, {
    loading: boolean;
    data?: AutomationWorktreeFileDiff;
    error?: string;
  }>>({});
  const [expandedWorktreeFiles, setExpandedWorktreeFiles] = useState<Record<string, string | undefined>>({});
  const worktreeReviewRequests = useRef(new Set<string>());
  const worktreeFileDiffRequests = useRef(new Set<string>());

  const activeConversation = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, sessions],
  );
  const resumableConversations = useMemo(() => {
    const seen = new Set<string>();
    return [...sessions]
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .filter((session) => {
        const id = session.cliResumeId?.trim();
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }, [sessions]);
  const editingProvider = useMemo(
    () => providers.find((provider) => provider.id === editing?.provider_id) ?? null,
    [editing?.provider_id, providers],
  );
  const automationModelOptions = useMemo(
    () => getModelDisplayOptions(editingProvider),
    [editingProvider],
  );

  useEffect(() => {
    if (!providersLoaded) void useProviderStore.getState().load();
  }, [providersLoaded]);

  const load = useCallback(async () => {
    try {
      // Opening the standalone Scheduled center is the read boundary for its
      // inbox. Clear every durable unread marker, including older entries that
      // are outside the 50-row visual history window, so the sidebar cannot
      // accumulate a permanent 99+ badge.
      if (standalone) await bridge.markAllAutomationRunsRead();
      const [nextItems, nextRuns] = await Promise.all([
        bridge.listAutomations(), bridge.listAutomationRuns(undefined, 50),
      ]);
      setItems(nextItems);
      setRuns(nextRuns);
      setError('');
      return nextRuns;
    } catch (reason) {
      setError(String(reason));
      return [];
    }
  }, [standalone]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    isAutostartEnabled()
      .then((enabled) => {
        if (!cancelled) setLaunchAtLogin(enabled);
      })
      .catch((reason) => {
        if (!cancelled) setLaunchAtLoginError(String(reason));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridge.getAutomationPreferences()
      .then((preferences) => {
        if (!cancelled) setWorktreeRetentionLimit(preferences.worktreeRetentionLimit);
      })
      .catch((reason) => {
        if (!cancelled) setWorktreeRetentionError(String(reason));
      });
    return () => { cancelled = true; };
  }, []);

  const toggleLaunchAtLogin = useCallback(async () => {
    if (launchAtLogin == null || launchAtLoginBusy) return;
    const next = !launchAtLogin;
    setLaunchAtLoginBusy(true);
    setLaunchAtLoginError('');
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
      const verified = await isAutostartEnabled();
      if (verified !== next) throw new Error(t('automations.launchAtLoginMismatch'));
      setLaunchAtLogin(verified);
    } catch (reason) {
      setLaunchAtLoginError(String(reason));
    } finally {
      setLaunchAtLoginBusy(false);
    }
  }, [launchAtLogin, launchAtLoginBusy, t]);

  const changeWorktreeRetention = useCallback(async (value: string) => {
    if (worktreeRetentionBusy) return;
    const next = value === 'off' ? null : Number(value);
    setWorktreeRetentionBusy(true);
    setWorktreeRetentionError('');
    try {
      const preferences = await bridge.setAutomationWorktreeRetentionLimit(next);
      setWorktreeRetentionLimit(preferences.worktreeRetentionLimit);
      await load();
    } catch (reason) {
      setWorktreeRetentionError(String(reason));
    } finally {
      setWorktreeRetentionBusy(false);
    }
  }, [load, worktreeRetentionBusy]);

  const loadWorktreeReview = useCallback(async (run: AutomationRun) => {
    if (!run.executionCwd || run.executionCwd === run.sourceCwd) return;
    if (run.worktreeCleanedAt && !run.worktreeSnapshotCommit) return;
    if (worktreeReviewRequests.current.has(run.runId)) return;
    worktreeReviewRequests.current.add(run.runId);
    setWorktreeReviews((current) => ({
      ...current,
      [run.runId]: { loading: true },
    }));
    try {
      const data = await bridge.getAutomationWorktreeReview(run.runId);
      setWorktreeReviews((current) => ({
        ...current,
        [run.runId]: { loading: false, data },
      }));
    } catch (reason) {
      worktreeReviewRequests.current.delete(run.runId);
      setWorktreeReviews((current) => ({
        ...current,
        [run.runId]: { loading: false, error: String(reason) },
      }));
    }
  }, []);

  const clearWorktreeReview = useCallback((runId: string) => {
    worktreeReviewRequests.current.delete(runId);
    setWorktreeReviews((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    setExpandedWorktreeFiles((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    setWorktreeFileDiffs((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(`${runId}\u0000`)),
    ));
    for (const key of worktreeFileDiffRequests.current) {
      if (key.startsWith(`${runId}\u0000`)) worktreeFileDiffRequests.current.delete(key);
    }
  }, []);

  const loadWorktreeFileDiff = useCallback(async (runId: string, path: string) => {
    const key = `${runId}\u0000${path}`;
    if (worktreeFileDiffRequests.current.has(key)) return;
    worktreeFileDiffRequests.current.add(key);
    setWorktreeFileDiffs((current) => ({ ...current, [key]: { loading: true } }));
    try {
      const data = await bridge.getAutomationWorktreeFileDiff(runId, path);
      setWorktreeFileDiffs((current) => ({ ...current, [key]: { loading: false, data } }));
    } catch (reason) {
      worktreeFileDiffRequests.current.delete(key);
      setWorktreeFileDiffs((current) => ({
        ...current,
        [key]: { loading: false, error: String(reason) },
      }));
    }
  }, []);

  const cleanupWorktree = useCallback(async (run: AutomationRun) => {
    setWorktreeActionRunId(run.runId);
    setError('');
    try {
      await bridge.cleanupAutomationWorktree(run.runId);
      clearWorktreeReview(run.runId);
      const refreshedRuns = await load();
      const refreshed = refreshedRuns.find((candidate) => candidate.runId === run.runId);
      if (refreshed) await loadWorktreeReview(refreshed);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setWorktreeActionRunId(null);
    }
  }, [clearWorktreeReview, load, loadWorktreeReview]);

  const restoreWorktree = useCallback(async (run: AutomationRun) => {
    setWorktreeActionRunId(run.runId);
    setError('');
    try {
      await bridge.restoreAutomationWorktree(run.runId);
      clearWorktreeReview(run.runId);
      await load();
      await loadWorktreeReview({ ...run, worktreeCleanedAt: null });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setWorktreeActionRunId(null);
    }
  }, [clearWorktreeReview, load, loadWorktreeReview]);

  const createWorktreeBranch = useCallback(async (run: AutomationRun, branchName: string) => {
    setWorktreeActionRunId(run.runId);
    setError('');
    try {
      await bridge.createAutomationWorktreeBranch(run.runId, branchName);
      setBranchEditor(null);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setWorktreeActionRunId(null);
    }
  }, [load]);

  const continueAutomationRun = useCallback(async (run: AutomationRun, draftText?: string) => {
    if (!run.sessionId || continuingRunId) return;
    setContinuingRunId(run.runId);
    setError('');
    try {
      if (run.worktreeCleanedAt) {
        await bridge.restoreAutomationWorktree(run.runId);
        clearWorktreeReview(run.runId);
        await load();
      }
      await useSessionStore.getState().fetchSessions();
      const session = useSessionStore.getState().sessions.find(
        (candidate) => candidate.id === run.sessionId,
      );
      if (!session) {
        throw new Error(t('automations.continueUnavailable'));
      }
      useSettingsStore.setState({ settingsOpen: false });
      window.dispatchEvent(new CustomEvent('blackbox:open-session', {
        detail: { sessionId: session.id, draftText },
      }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setContinuingRunId(null);
    }
  }, [clearWorktreeReview, continuingRunId, load, t]);

  // Worktrees only make sense for a real Git repository. Detect this from the
  // chosen folder and silently fall back to local execution for ordinary
  // folders instead of making a non-technical user decipher a Git error.
  useEffect(() => {
    const projectId = editing?.kind === 'cron'
      ? editing.target?.projectId.trim()
      : '';
    if (!projectId) {
      setWorktreeAvailable(null);
      return;
    }
    let cancelled = false;
    setWorktreeAvailable(null);
    const timer = window.setTimeout(() => {
      bridge.runGitCommand(projectId, ['rev-parse', '--is-inside-work-tree'])
        .then((output) => output.trim() === 'true')
        .catch(() => false)
        .then((available) => {
          if (cancelled) return;
          setWorktreeAvailable(available);
          if (!available) {
            setEditing((current) => current?.kind === 'cron'
              && current.execution_environment === 'worktree'
              ? { ...current, execution_environment: 'local' }
              : current);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editing?.kind, editing?.target?.projectId]);

  const beginEdit = useCallback((definition: AutomationDefinition) => {
    const parsed = parseFormRule(definition.rrule);
    setWorktreeAvailable(null);
    setEditing({
      ...definition,
      model: normalizeModelTier(definition.model),
      execution_environment: definition.kind === 'heartbeat'
        ? 'local'
        : definition.execution_environment,
    });
    setFrequency(parsed.frequency);
    setTime(parsed.time);
    setIntervalValue(parsed.interval);
    setDays(parsed.days);
    setError('');
  }, []);

  const chooseProjectDirectory = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('project.selectFolder'),
    });
    if (typeof selected !== 'string') return;
    setEditing((current) => current ? {
      ...current,
      target: { type: 'project', projectId: selected },
      cwds: [selected],
    } : current);
  }, [t]);

  const changeKind = useCallback((kind: 'cron' | 'heartbeat') => {
    setEditing((current) => {
      if (!current) return current;
      if (kind === 'heartbeat') {
        const targetThreadId = current.target_thread_id || activeConversation?.cliResumeId || null;
        const conversation = resumableConversations.find(
          (session) => session.cliResumeId === targetThreadId,
        );
        return {
          ...current,
          kind,
          execution_environment: 'local',
          target_thread_id: targetThreadId,
          cwds: conversation?.projectDir ? [conversation.projectDir] : current.cwds,
        };
      }
      const projectId = current.target?.projectId || workingDirectory || '';
      return {
        ...current,
        kind,
        execution_environment: current.kind === 'heartbeat'
          ? 'worktree'
          : current.execution_environment,
        target: { type: 'project', projectId },
        cwds: projectId ? [projectId] : current.cwds,
      };
    });
  }, [activeConversation, resumableConversations, workingDirectory]);

  const selectHeartbeatConversation = useCallback((targetThreadId: string) => {
    const conversation = resumableConversations.find(
      (session) => session.cliResumeId === targetThreadId,
    );
    setEditing((current) => current ? {
      ...current,
      target_thread_id: targetThreadId || null,
      cwds: conversation?.projectDir ? [conversation.projectDir] : current.cwds,
    } : current);
  }, [resumableConversations]);

  const save = useCallback(async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      await useProviderStore.getState().flushSave();
      const persistedProviders = useProviderStore.getState().providers;
      const definition = prepareAutomationDefinitionForSave(
        {
          ...editing,
          provider_revision: editing.provider_id
            ? persistedProviders.find((provider) => provider.id === editing.provider_id)?.revision ?? null
            : null,
        },
        buildRule(frequency, time, interval, days),
      );
      await bridge.upsertAutomation(definition);
      setEditing(null);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [editing, frequency, time, interval, days, load]);

  const runNow = useCallback(async (id: string) => {
    setError('');
    try {
      await useProviderStore.getState().flushSave();
      await bridge.runAutomationNow(id);
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }, [load]);

  const changeStatus = useCallback(async (id: string, status: 'ACTIVE' | 'PAUSED') => {
    setError('');
    try {
      await useProviderStore.getState().flushSave();
      await bridge.setAutomationStatus(id, status);
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }, [load]);

  const recentRuns = useMemo(() => runs, [runs]);
  const canSave = isAutomationDraftComplete(editing)
    && !(editing?.kind === 'cron'
      && editing.execution_environment === 'worktree'
      && worktreeAvailable !== true);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className={`${standalone ? 'text-[24px]' : 'text-[15px]'} font-semibold tracking-tight text-text-primary`}>{t('automations.title')}</h3>
          <p className="mt-1 text-[12px] leading-5 text-text-muted">
            {t('automations.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => beginEdit(createAutomationDraft(
            selectedModel,
            workingDirectory || activeConversation?.projectDir || '',
            activeConversation?.cliResumeId || null,
            Date.now(),
            activeProviderId,
            providers.find((provider) => provider.id === activeProviderId)?.revision ?? null,
            auxiliaryModel,
          ))}
            className="px-3 py-1.5 rounded-md bg-accent text-text-inverse text-[12px] font-medium hover:opacity-90">
            {t('automations.new')}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={t('extensions.close')}
              data-testid="automation-center-close"
              className="rounded-lg p-2 text-text-tertiary transition-smooth hover:bg-bg-secondary hover:text-text-primary"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-text-primary">{t('automations.launchAtLogin')}</div>
          <p className="mt-1 text-[11px] leading-4 text-text-muted">{t('automations.launchAtLoginHint')}</p>
          {launchAtLoginError && (
            <p className="mt-1 break-all text-[10px] text-red-500">{t('automations.launchAtLoginError')} {launchAtLoginError}</p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={launchAtLogin === true}
          aria-label={t('automations.launchAtLogin')}
          disabled={launchAtLogin == null || launchAtLoginBusy}
          onClick={() => void toggleLaunchAtLogin()}
          className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${launchAtLogin ? 'bg-accent' : 'bg-bg-tertiary'}`}
        >
          <span
            className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-text-inverse shadow-sm transition-transform"
            style={{ transform: `translateX(${launchAtLogin ? 16 : 0}px)` }}
          />
        </button>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-text-primary">{t('automations.worktreeRetention')}</div>
          <p className="mt-1 text-[11px] leading-4 text-text-muted">{t('automations.worktreeRetentionHint')}</p>
          {worktreeRetentionError && (
            <p className="mt-1 break-all text-[10px] text-red-500">{t('automations.worktreeRetentionError')} {worktreeRetentionError}</p>
          )}
        </div>
        <select
          value={worktreeRetentionLimit === undefined ? '' : worktreeRetentionLimit == null ? 'off' : String(worktreeRetentionLimit)}
          aria-label={t('automations.worktreeRetention')}
          disabled={worktreeRetentionLimit === undefined || worktreeRetentionBusy}
          onChange={(event) => void changeWorktreeRetention(event.target.value)}
          className="flex-shrink-0 rounded-md border border-border-subtle bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary disabled:cursor-wait disabled:opacity-50"
        >
          {worktreeRetentionLimit === undefined && <option value="">—</option>}
          <option value="off">{t('automations.worktreeRetentionOff')}</option>
          {typeof worktreeRetentionLimit === 'number'
            && !(WORKTREE_RETENTION_OPTIONS as readonly number[]).includes(worktreeRetentionLimit)
            && <option value={worktreeRetentionLimit}>{t('automations.worktreeRetentionCount').replace('{count}', String(worktreeRetentionLimit))}</option>}
          {WORKTREE_RETENTION_OPTIONS.map((limit) => (
            <option key={limit} value={limit}>{t('automations.worktreeRetentionCount').replace('{count}', String(limit))}</option>
          ))}
        </select>
      </div>

      {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">{error}</div>}

      {editing && (
        <div className="rounded-lg border border-border-subtle bg-bg-secondary p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-[13px] font-semibold text-text-primary">{editing.id ? t('automations.edit') : t('automations.new')}</h4>
            <button onClick={() => setEditing(null)} className="text-[12px] text-text-muted hover:text-text-primary">{t('common.cancel')}</button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] text-text-muted">{t('automations.name')}</span>
              <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent/60" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-text-muted">{t('automations.kind')}</span>
              <select value={editing.kind} onChange={(event) => changeKind(event.target.value as 'cron' | 'heartbeat')}
                className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[12px] text-text-primary outline-none">
                <option value="cron">{t('automations.kind.cron')}</option>
                <option value="heartbeat">{t('automations.kind.heartbeat')}</option>
              </select>
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] text-text-muted">{t('automations.prompt')}</span>
            <textarea value={editing.prompt} onChange={(event) => setEditing({ ...editing, prompt: event.target.value })}
              rows={5} className="w-full resize-y rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[12px] leading-5 text-text-primary outline-none focus:border-accent/60" />
          </label>

          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] text-text-muted">{t('automations.frequency')}</span>
              <select value={frequency} onChange={(event) => setFrequency(event.target.value as Frequency)}
                className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[12px] text-text-primary">
                <option value="MINUTELY">{t('automations.frequency.minutely')}</option>
                <option value="HOURLY">{t('automations.frequency.hourly')}</option>
                <option value="DAILY">{t('automations.frequency.daily')}</option>
                <option value="WEEKLY">{t('automations.frequency.weekly')}</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-text-muted">{t('automations.interval')}</span>
              <input type="number" min="1" value={interval} onChange={(event) => setIntervalValue(event.target.value)}
                className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[12px] text-text-primary" />
            </label>
            {frequency !== 'MINUTELY' && (
              <label className="space-y-1">
                <span className="text-[11px] text-text-muted">{t('automations.time')}</span>
                <input type="time" value={time} onChange={(event) => setTime(event.target.value)}
                  className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[12px] text-text-primary" />
              </label>
            )}
          </div>

          {frequency === 'WEEKLY' && (
            <div className="flex items-center gap-1.5">
              {DAY_OPTIONS.map((value) => (
                <button key={value} onClick={() => setDays((current) => current.includes(value) ? current.filter((day) => day !== value) : [...current, value])}
                  className={`h-7 w-7 rounded-full text-[11px] ${days.includes(value) ? 'bg-accent text-text-inverse' : 'bg-bg-card text-text-muted border border-border-subtle'}`}>
                  {t(`automations.day.${value}`)}
                </button>
              ))}
            </div>
          )}

          {editing.kind === 'cron' ? (
            <label className="block space-y-1">
              <span className="text-[11px] text-text-muted">{t('automations.projectDirectory')}</span>
              <div className="flex gap-2">
                <input value={editing.target?.projectId || ''}
                  onChange={(event) => setEditing({
                    ...editing,
                    target: { type: 'project', projectId: event.target.value },
                  })}
                  className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-card px-3 py-2 font-mono text-[11px] text-text-primary" />
                <button type="button" onClick={chooseProjectDirectory}
                  className="flex-shrink-0 rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[11px] text-text-muted hover:border-accent hover:text-accent">
                  {t('automations.chooseFolder')}
                </button>
              </div>
              {worktreeAvailable === false && (
                <span className="block text-[10px] leading-4 text-text-tertiary">{t('automations.nonGitHint')}</span>
              )}
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="text-[11px] text-text-muted">{t('automations.sessionId')}</span>
              <select value={editing.target_thread_id || ''}
                onChange={(event) => selectHeartbeatConversation(event.target.value)}
                className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-[12px] text-text-primary">
                <option value="">{t('automations.selectConversation')}</option>
                {editing.target_thread_id
                  && !resumableConversations.some((session) => session.cliResumeId === editing.target_thread_id)
                  && <option value={editing.target_thread_id}>{t('automations.savedConversation')}</option>}
                {resumableConversations.map((session) => (
                  <option key={session.cliResumeId || session.id} value={session.cliResumeId || ''}>
                    {customPreviews[session.id] || session.preview || session.id} · {session.project || session.projectDir}
                  </option>
                ))}
              </select>
              {resumableConversations.length === 0 && (
                <span className="block text-[10px] leading-4 text-text-tertiary">{t('automations.noConversation')}</span>
              )}
            </label>
          )}

          <details className="text-[11px] text-text-muted">
            <summary className="cursor-pointer">{t('automations.advanced')}</summary>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <label className="space-y-1">
                <span>{t('automations.mainModel')}</span>
                <select
                  value={getSelectedModelOptionId(editing.model || 'sonnet', automationModelOptions, editingProvider)}
                  onChange={(event) => setEditing({ ...editing, model: event.target.value })}
                  className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-text-primary">
                  {automationModelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span>{t('automations.auxiliaryModel')}</span>
                <select
                  value={getSelectedModelOptionId(editing.auxiliary_model || 'sonnet', automationModelOptions, editingProvider)}
                  onChange={(event) => setEditing({ ...editing, auxiliary_model: event.target.value })}
                  className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-text-primary">
                  {automationModelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
                <span className="block text-[10px] leading-4 text-text-tertiary">{t('automations.auxiliaryModelHint')}</span>
              </label>
              <label className="space-y-1">
                <span>{t('automations.reasoningEffort')}</span>
                <select value={editing.reasoning_effort || 'high'} onChange={(event) => setEditing({ ...editing, reasoning_effort: event.target.value })}
                  className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-text-primary">
                  {['low', 'medium', 'high', 'max'].map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>
              <label className="col-span-2 space-y-1">
                <span>{t('automations.provider')}</span>
                <select
                  value={editing.provider_id || ''}
                  onChange={(event) => {
                    const providerId = event.target.value || null;
                    const provider = providers.find((entry) => entry.id === providerId);
                    setEditing({
                      ...editing,
                      provider_id: providerId,
                      provider_revision: provider?.revision ?? null,
                    });
                  }}
                  className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-text-primary"
                >
                  <option value="">{t('provider.inherit')}</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name || t('provider.unnamed')} · {provider.credentialHint || t('provider.noStoredKey')}
                    </option>
                  ))}
                </select>
                <span className="block text-[10px] leading-4 text-text-tertiary">
                  {t('automations.providerPinned')}
                </span>
              </label>
              {editing.kind === 'cron' && (
                <label className="space-y-1">
                  <span>{t('automations.executionEnvironment')}</span>
                  <select value={editing.execution_environment || 'local'}
                    onChange={(event) => setEditing({ ...editing, execution_environment: event.target.value as 'local' | 'worktree' })}
                    className="w-full rounded-md border border-border-subtle bg-bg-card px-3 py-2 text-text-primary">
                    <option value="worktree" disabled={worktreeAvailable === false}>
                      {worktreeAvailable === false
                        ? t('automations.execution.worktreeUnavailable')
                        : t('automations.execution.worktree')}
                    </option>
                    <option value="local">{t('automations.execution.local')}</option>
                  </select>
                </label>
              )}
              <label className="col-span-2 flex items-start justify-between gap-4 rounded-md border border-border-subtle bg-bg-secondary/30 p-3">
                <span className="space-y-1">
                  <span className="block text-text-primary">{t('automations.agentTeams')}</span>
                  <span className="block text-[10px] leading-4 text-text-tertiary">{t('automations.agentTeamsHint')}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={editing.agent_teams_enabled}
                  data-testid="automation-agent-teams-toggle"
                  onClick={() => {
                    const next = !editing.agent_teams_enabled;
                    if (next && !window.confirm(t('automations.agentTeamsConfirm'))) return;
                    setEditing({ ...editing, agent_teams_enabled: next });
                  }}
                  className={`relative mt-0.5 h-5 w-9 flex-shrink-0 rounded-full transition-colors
                    ${editing.agent_teams_enabled ? 'bg-accent' : 'bg-bg-tertiary'}`}>
                  <span
                    className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
                    style={{ transform: `translateX(${editing.agent_teams_enabled ? 16 : 0}px)` }}
                  />
                </button>
              </label>
            </div>
            {editing.kind === 'cron' && editing.execution_environment === 'worktree' && (
              <p className="mt-2 leading-5">{t('automations.worktreeHint')}</p>
            )}
            <div className="mt-2 font-mono">{buildRule(frequency, time, interval, days)}</div>
          </details>

          <div className="flex justify-end">
            <button disabled={busy || !canSave} onClick={save}
              className="px-4 py-2 rounded-md bg-accent text-text-inverse text-[12px] font-medium disabled:opacity-50">
              {busy ? t('automations.saving') : t('automations.save')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.length === 0 && !editing && (
          <div className="rounded-lg border border-dashed border-border-subtle py-10 text-center text-[12px] text-text-muted">{t('automations.empty')}</div>
        )}
        {items.map((item) => (
          <div key={item.id} className="rounded-lg border border-border-subtle bg-bg-card px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-text-primary">{item.name}</span>
                  <span className="rounded px-1.5 py-0.5 text-[10px] uppercase bg-bg-tertiary text-text-muted">{item.kind}</span>
                  {item.kind === 'cron' && <span className="rounded px-1.5 py-0.5 text-[10px] bg-bg-tertiary text-text-muted">{item.execution_environment === 'worktree' ? 'worktree' : 'local'}</span>}
                  {item.agent_teams_enabled && <span className="rounded px-1.5 py-0.5 text-[10px] bg-accent/10 text-accent">team</span>}
                  {item.running && <span className="text-[10px] text-blue-500">{t('automations.running')}</span>}
                  {item.unreadRuns > 0 && (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label={`${item.unreadRuns} unread`} />
                  )}
                </div>
                <div className="mt-1 text-[11px] text-text-muted">{t('automations.next')} {formatTime(item.nextRunAt, locale)} · {t('automations.last')} {formatTime(item.lastRunAt, locale)}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-text-tertiary">{item.rrule}</div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <button onClick={() => { void runNow(item.id); }}
                  className="px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10">{t('automations.runNow')}</button>
                <button onClick={() => { void changeStatus(item.id, item.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'); }}
                  className="px-2 py-1 rounded text-[11px] text-text-muted hover:bg-bg-secondary">{item.status === 'ACTIVE' ? t('automations.pause') : t('automations.resume')}</button>
                <button onClick={() => beginEdit(item)} className="px-2 py-1 rounded text-[11px] text-text-muted hover:bg-bg-secondary">{t('automations.edit')}</button>
                <button onClick={() => {
                  if (window.confirm(t('automations.deleteConfirm').replace('{name}', item.name))) bridge.deleteAutomation(item.id).then(load).catch((reason) => setError(String(reason)));
                }} className="px-2 py-1 rounded text-[11px] text-red-500 hover:bg-red-500/10">{t('automations.delete')}</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div>
        <h4 className="mb-2 text-[13px] font-semibold text-text-primary">{t('automations.recentRuns')}</h4>
        <div className="space-y-2">
          {recentRuns.length === 0 && <div className="text-[12px] text-text-muted">{t('automations.noRuns')}</div>}
          {recentRuns.map((run) => (
            <details key={run.runId} className="rounded-lg border border-border-subtle bg-bg-card px-3 py-2"
              onToggle={(event) => {
                if (!(event.currentTarget as HTMLDetailsElement).open) return;
                if (!run.readAt) bridge.markAutomationRunRead(run.runId).then(load);
                void loadWorktreeReview(run);
              }}>
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-medium text-text-primary">{run.title || run.automationId}</div>
                    <div className="mt-0.5 truncate text-[11px] text-text-muted">{run.summary || run.error || t('automations.waitingResult')}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[9px] ${statusColor(run.status)}`}>{run.status}</span>
                    <span className="text-[10px] text-text-tertiary">{formatTime(run.startedAt, locale)}</span>
                  </div>
                </div>
              </summary>
              {run.trace?.length > 0 && (
                <div className="mt-3 rounded-md border border-border-subtle bg-bg-secondary/60 p-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{t('automations.trace')}</div>
                  <div className="space-y-1.5">
                    {run.trace.map((event) => (
                      <div key={`${event.sequence}-${event.toolUseId || event.toolName || 'event'}`} className="flex items-start gap-2 text-[11px]"
                        style={{ paddingLeft: `${(event.agentDepth ?? 0) * 12}px` }}>
                        <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${traceDotColor(event.eventType, event.summary)}`} />
                        <div className="min-w-0">
                          <span className="font-mono text-text-primary">{event.eventType.startsWith('agent_')
                            ? event.agentType || (event.agentKind === 'teammate' ? t('agents.teammate') : t('agents.subAgent'))
                            : event.toolName || 'Tool'}</span>
                          {event.agentDepth != null && event.agentDepth > 0 && !event.eventType.startsWith('agent_') && (
                            <span className="ml-2 rounded bg-violet-500/10 px-1 py-0.5 text-[9px] text-violet-500">{event.agentType || (event.agentKind === 'teammate' ? t('agents.teammate') : t('agents.subAgent'))}</span>
                          )}
                          <span className="ml-2 text-text-muted">{traceSummary(event.eventType, event.summary, t)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {run.executionCwd && run.executionCwd !== run.sourceCwd && (
                <div className="mt-3 rounded-md border border-border-subtle bg-bg-secondary/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{t('automations.worktree')}</div>
                    <div className="flex items-center gap-3">
                      {!run.worktreeCleanedAt && run.status !== 'RUNNING' && !run.worktreeBranchName && (
                        <button onClick={() => setBranchEditor({ runId: run.runId, name: defaultWorktreeBranchName(run) })}
                          className="text-[10px] text-accent hover:underline">{t('automations.createBranchHere')}</button>
                      )}
                      {!run.worktreeCleanedAt && (
                        <button onClick={() => bridge.revealInFinder(run.executionCwd || '').catch((reason) => setError(String(reason)))}
                          className="text-[10px] text-accent hover:underline">{t('automations.revealWorktree')}</button>
                      )}
                      {run.worktreeCleanedAt && run.worktreeSnapshotCommit && (
                        <button onClick={() => void restoreWorktree(run)} disabled={worktreeActionRunId === run.runId}
                          className="text-[10px] text-accent hover:underline disabled:cursor-wait disabled:opacity-50">
                          {worktreeActionRunId === run.runId ? t('automations.restoring') : t('automations.restoreWorktree')}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 break-all font-mono text-[10px] text-text-muted">{run.executionCwd}</div>
                  {run.baseCommit && (
                    <div className="mt-1 text-[10px] text-text-tertiary">
                      {t('automations.startingCommit')} <span className="font-mono">{run.baseCommit.slice(0, 12)}</span>
                    </div>
                  )}
                  {run.sourceHeadCommit && run.baseCommit && run.sourceHeadCommit !== run.baseCommit && (
                    <div className="mt-1 text-[10px] text-emerald-500">
                      {t('automations.localInputsCaptured')} · {t('automations.sourceHead')} <span className="font-mono">{run.sourceHeadCommit.slice(0, 12)}</span>
                      {run.worktreeInputSnapshotAt ? ` · ${formatTime(run.worktreeInputSnapshotAt, locale)}` : ''}
                    </div>
                  )}
                  {(run.worktreeIncludedFiles || 0) > 0 && (
                    <div className="mt-1 text-[10px] text-text-tertiary">
                      {t('automations.includedIgnoredFiles').replace('{count}', String(run.worktreeIncludedFiles))}
                    </div>
                  )}
                  {run.worktreeBranchName && (
                    <div className="mt-1 text-[10px] text-text-tertiary">
                      {t('automations.worktreeBranch')} <span className="font-mono text-text-muted">{run.worktreeBranchName}</span>
                      {run.worktreeBranchAt ? ` · ${formatTime(run.worktreeBranchAt, locale)}` : ''}
                    </div>
                  )}
                  {branchEditor?.runId === run.runId && !run.worktreeCleanedAt && !run.worktreeBranchName && (
                    <div className="mt-3 rounded border border-border-subtle bg-bg-primary/40 p-2">
                      <label className="text-[10px] font-medium text-text-tertiary">{t('automations.branchName')}</label>
                      <input value={branchEditor.name} onChange={(event) => setBranchEditor({ ...branchEditor, name: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && branchEditor.name.trim() && worktreeActionRunId !== run.runId) {
                            void createWorktreeBranch(run, branchEditor.name);
                          }
                        }}
                        className="mt-1 w-full rounded border border-border-subtle bg-bg-secondary px-2 py-1 font-mono text-[11px] text-text-primary outline-none focus:border-accent" />
                      <div className="mt-1 text-[10px] leading-4 text-text-muted">{t('automations.createBranchHint')}</div>
                      <div className="mt-2 flex justify-end gap-2">
                        <button onClick={() => setBranchEditor(null)} disabled={worktreeActionRunId === run.runId}
                          className="rounded px-2 py-1 text-[10px] text-text-muted hover:bg-bg-secondary disabled:opacity-50">{t('common.cancel')}</button>
                        <button onClick={() => void createWorktreeBranch(run, branchEditor.name)}
                          disabled={!branchEditor.name.trim() || worktreeActionRunId === run.runId}
                          className="rounded bg-accent px-2 py-1 text-[10px] text-text-inverse hover:bg-accent-hover disabled:cursor-wait disabled:opacity-50">
                          {worktreeActionRunId === run.runId ? t('automations.creatingBranch') : t('automations.createBranch')}
                        </button>
                      </div>
                    </div>
                  )}
                  {run.worktreeCleanedAt && <div className="mt-1 text-[10px] text-text-tertiary">{t('automations.cleaned')} · {formatTime(run.worktreeCleanedAt, locale)}</div>}
                  {run.worktreeCleanedAt && run.worktreeSnapshotCommit && (
                    <div className="mt-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-[10px] text-text-muted">
                      <div className="font-medium text-emerald-500">{t('automations.recoverySnapshot')}</div>
                      <div className="mt-0.5">{t('automations.recoverySnapshotHint')}</div>
                      <div className="mt-0.5 font-mono text-text-tertiary">
                        {run.worktreeSnapshotCommit.slice(0, 12)}
                        {run.worktreeSnapshotAt ? ` · ${formatTime(run.worktreeSnapshotAt, locale)}` : ''}
                      </div>
                    </div>
                  )}
                  {worktreeReviews[run.runId]?.loading && (
                    <div className="mt-3 text-[10px] text-text-muted">{t('automations.reviewLoading')}</div>
                  )}
                  {worktreeReviews[run.runId]?.error && (
                    <div className="mt-3 break-all text-[10px] text-red-500">{t('automations.reviewUnavailable')} {worktreeReviews[run.runId]?.error}</div>
                  )}
                  {worktreeReviews[run.runId]?.data && (() => {
                    const review = worktreeReviews[run.runId].data!;
                    const hasChanges = review.status || review.commits || review.diffStat || review.files.length > 0;
                    const runComments = Object.values(reviewCommentMap)
                      .filter((comment) => comment.runId === run.runId);
                    const unresolvedComments = runComments.filter((comment) => !comment.resolved);
                    const reviewFeedback = formatReviewFeedback(
                      runComments,
                      locale === 'zh' ? 'zh' : 'en',
                    );
                    return (
                      <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
                        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                          <span>{t('automations.reviewChanges')}</span>
                          {review.reviewSource === 'snapshot' && (
                            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] normal-case tracking-normal text-emerald-500">{t('automations.reviewFromSnapshot')}</span>
                          )}
                        </div>
                        {!hasChanges && <div className="text-[10px] text-text-muted">{t('automations.noChanges')}</div>}
                        {review.commits && (
                          <div>
                            <div className="mb-1 text-[10px] font-medium text-text-tertiary">{review.reviewSource === 'snapshot' ? t('automations.reviewSnapshotCommit') : t('automations.reviewCommits')}</div>
                            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-text-muted">{review.commits}</pre>
                          </div>
                        )}
                        {review.status && (
                          <div>
                            <div className="mb-1 text-[10px] font-medium text-text-tertiary">{review.reviewSource === 'snapshot' ? t('automations.reviewFinalSnapshot') : t('automations.reviewWorkingTree')}</div>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-text-muted">{review.status}</pre>
                          </div>
                        )}
                        {review.diffStat && (
                          <div>
                            <div className="mb-1 text-[10px] font-medium text-text-tertiary">{t('automations.reviewDiffStat')}</div>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-text-muted">{review.diffStat}</pre>
                          </div>
                        )}
                        {review.files.length > 0 && (
                          <div>
                            <div className="mb-1 text-[10px] font-medium text-text-tertiary">{t('automations.reviewFiles')}</div>
                            <div className="max-h-[28rem] space-y-1 overflow-auto rounded border border-border-subtle bg-bg-primary/30 p-1">
                              {review.files.map((file) => {
                                const diffKey = `${run.runId}\u0000${file.path}`;
                                const diffState = worktreeFileDiffs[diffKey];
                                const expanded = expandedWorktreeFiles[run.runId] === file.path;
                                return (
                                  <div key={file.path} className="rounded bg-bg-secondary/60">
                                    <button onClick={() => {
                                      setExpandedWorktreeFiles((current) => ({
                                        ...current,
                                        [run.runId]: expanded ? undefined : file.path,
                                      }));
                                      if (!expanded) void loadWorktreeFileDiff(run.runId, file.path);
                                    }} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-bg-tertiary/70">
                                      <span className={`w-4 flex-none text-center font-mono text-[10px] ${file.status === 'D' ? 'text-red-500' : file.untracked ? 'text-amber-500' : 'text-accent'}`}>{file.status}</span>
                                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-muted" title={file.displayPath}>{file.displayPath}</span>
                                      <span className="text-[9px] text-text-tertiary">{expanded ? '−' : '+'}</span>
                                    </button>
                                    {expanded && (
                                      <div className="border-t border-border-subtle px-2 py-2">
                                        {diffState?.loading && <div className="text-[10px] text-text-muted">{t('automations.reviewFileLoading')}</div>}
                                        {diffState?.error && <div className="break-all text-[10px] text-red-500">{t('automations.reviewFileUnavailable')} {diffState.error}</div>}
                                        {diffState?.data?.binary && (
                                          <div className="text-[10px] text-text-muted">
                                            {t('automations.reviewBinaryFile')}
                                            {diffState.data.sizeBytes != null ? ` · ${diffState.data.sizeBytes} B` : ''}
                                          </div>
                                        )}
                                        {diffState?.data && !diffState.data.binary && (
                                          diffState.data.patch
                                            ? <InlinePatchReview runId={run.runId} baseCommit={review.baseCommit} diff={diffState.data} />
                                            : <div className="text-[10px] text-text-muted">{t('automations.noChanges')}</div>
                                        )}
                                        {diffState?.data?.truncated && <div className="mt-1 text-[10px] text-amber-500">{t('automations.reviewPatchTruncated')}</div>}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {review.filesTruncated && <div className="mt-1 text-[10px] text-amber-500">{t('automations.reviewFilesTruncated')}</div>}
                          </div>
                        )}
                        {review.truncated && <div className="text-[10px] text-amber-500">{t('automations.reviewTruncated')}</div>}
                        {runComments.length > 0 && (
                          <div className="flex items-center justify-between gap-3 rounded border border-accent/20 bg-accent/[0.04] px-2 py-2">
                            <div className="min-w-0 text-[10px] text-text-muted">
                              <span>{t('review.comments').replace('{count}', String(runComments.length))}</span>
                              {unresolvedComments.length > 0 && (
                                <span className="ml-1 text-accent">
                                  {t('review.unresolved').replace('{count}', String(unresolvedComments.length))}
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              data-testid={`open-review-task-${run.runId}`}
                              disabled={!run.sessionId || !reviewFeedback || continuingRunId === run.runId}
                              onClick={() => void continueAutomationRun(run, reviewFeedback)}
                              title={t('review.openTaskHint')}
                              className="flex-none rounded bg-accent/10 px-2 py-1 text-[10px] text-accent
                                hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {t('review.openTask')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
              <div className="mt-3 max-h-80 overflow-y-auto rounded-md bg-bg-secondary p-3">
                <MarkdownRenderer
                  content={stripFinalInboxDirective(run.output)
                    || run.error
                    || (run.status === 'RUNNING' ? t('automations.stillRunning') : run.summary || t('automations.noReport'))}
                  basePath={run.executionCwd || run.sourceCwd || undefined}
                  className="text-[11px] leading-5 text-text-muted prose-p:my-2 prose-headings:my-3"
                />
              </div>
              <div className="mt-2 flex justify-end gap-3">
                {run.status === 'RUNNING' ? (
                  <button onClick={() => {
                    if (window.confirm(t('automations.stopConfirm'))) {
                      bridge.cancelAutomationRun(run.runId).then(load).catch((reason) => setError(String(reason)));
                    }
                  }} className="text-[11px] text-red-500 hover:text-red-400">{t('automations.stop')}</button>
                ) : (
                  <>
                    {run.sessionId && (
                      <button disabled={continuingRunId === run.runId} onClick={() => void continueAutomationRun(run)}
                        className="text-[11px] text-accent hover:text-accent-hover disabled:cursor-wait disabled:opacity-50">
                        {continuingRunId === run.runId
                          ? t('automations.continuingConversation')
                          : run.worktreeCleanedAt
                            ? t('automations.restoreAndContinue')
                            : t('automations.continueConversation')}
                      </button>
                    )}
                    {run.executionCwd && run.executionCwd !== run.sourceCwd && !run.worktreeCleanedAt && (
                      <button disabled={worktreeActionRunId === run.runId} onClick={() => {
                        if (window.confirm(t('automations.cleanupConfirm').replace('{path}', run.executionCwd || ''))) {
                          void cleanupWorktree(run);
                        }
                      }} className="text-[11px] text-red-500 hover:text-red-400 disabled:cursor-wait disabled:opacity-50">{t('automations.cleanup')}</button>
                    )}
                    {run.status !== 'ARCHIVED' && (
                      <button onClick={() => bridge.archiveAutomationRun(run.runId).then(load)} className="text-[11px] text-text-muted hover:text-text-primary">{t('automations.archive')}</button>
                    )}
                  </>
                )}
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
