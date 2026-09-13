import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { bridge } from '../lib/tauri-bridge';
import { planCliUpdateSessions, settleBackendProcessesForCliUpdate } from '../lib/sessionLifecycle';
import { useSessionStore } from './sessionStore';
import { useChatStore } from './chatStore';

export interface AppUpdateStatus {
  phase: string; version?: string | null; notes?: string | null;
  downloaded: number; total?: number | null; error?: string | null; previousVersion?: string | null;
}
interface AppUpdateStore {
  status: AppUpdateStatus;
  waiting: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  check: (rollback?: boolean) => Promise<void>;
  download: () => Promise<void>;
  installWhenIdle: () => void;
  cancelWait: () => void;
}
let timer: ReturnType<typeof setInterval> | undefined;
let installing = false;

export function restoreUpdateDrafts() {
  try {
    const drafts = JSON.parse(localStorage.getItem('blackbox:update-drafts') ?? '[]');
    for (const draft of drafts) {
      if (typeof draft.id !== 'string' || typeof draft.text !== 'string') continue;
      const store = useChatStore.getState();
      if (draft.session?.id === draft.id && !useSessionStore.getState().sessions.some((session) => session.id === draft.id)) {
        useSessionStore.setState((state) => ({ sessions: [...state.sessions, draft.session] }));
      }
      store.ensureTab(draft.id);
      store.setSessionMeta(draft.id, { restoreNeedsHistory: Boolean(draft.session?.path) });
      store.setInputDraft(draft.id, draft.text);
      if (Array.isArray(draft.files)) store.setPendingAttachments(draft.id, draft.files);
    }
    const selected = drafts.find((draft: { selected?: boolean }) => draft.selected);
    if (selected) useSessionStore.getState().setSelectedSession(selected.id);
    localStorage.removeItem('blackbox:update-drafts');
  } catch { /* An invalid old snapshot must not prevent app startup. */ }
}

function saveUpdateDrafts() {
  localStorage.setItem('blackbox:update-drafts', JSON.stringify(
    [...useChatStore.getState().tabs].map(([id, tab]) => ({ id, text: tab.inputDraft, files: tab.pendingAttachments,
      session: useSessionStore.getState().sessions.find((session) => session.id === id), selected: useSessionStore.getState().selectedSessionId === id }))
      .filter((item) => item.text || item.files.length),
  ));
}

export const useAppUpdateStore = create<AppUpdateStore>((set, get) => ({
  status: { phase: 'idle', downloaded: 0 }, waiting: false, busy: false,
  refresh: async () => { set({ status: await invoke<AppUpdateStatus>('get_app_update_status') }); },
  check: async (rollback = false) => {
    if (get().busy || get().waiting) return;
    set({ busy: true });
    try { set({ status: await invoke<AppUpdateStatus>('check_app_update', { rollback }) }); }
    catch (error) { set({ status: { ...get().status, error: String(error) } }); }
    finally { set({ busy: false }); }
  },
  download: async () => {
    if (get().busy) return;
    set({ busy: true });
    try { set({ status: await invoke<AppUpdateStatus>('download_app_update') }); }
    catch (error) { set({ status: { ...get().status, error: String(error) } }); }
    finally { set({ busy: false }); }
  },
  cancelWait: () => { clearInterval(timer); timer = undefined; set({ waiting: false }); },
  installWhenIdle: () => {
    if (get().status.phase !== 'downloaded' || timer || installing) return;
    set({ waiting: true });
    const tryInstall = async () => {
      if (installing || !get().waiting) return;
      installing = true;
      try {
        const blockers = await bridge.getCliUpdateBlockers();
        if (blockers.maintenanceInProgress || blockers.runningAutomation) return;
        const plan = planCliUpdateSessions(blockers.activeSessionIds);
        if (plan.busyIds.length || plan.unknownIds.length) return;
        await settleBackendProcessesForCliUpdate(blockers.activeSessionIds);
        if (!get().waiting) return;
        saveUpdateDrafts();
        await invoke('install_app_update'); // Native gate closes launch races.
        get().cancelWait();
      } catch (error) {
        if (!String(error).includes('UPDATE_WAITING_FOR_IDLE')) {
          set({ status: { ...get().status, error: String(error) } });
          get().cancelWait();
        }
      } finally { installing = false; }
    };
    timer = setInterval(() => { void tryInstall(); }, 15_000);
    void tryInstall();
  },
}));
