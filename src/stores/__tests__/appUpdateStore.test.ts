import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), blockers: vi.fn(), plan: vi.fn(), settle: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../lib/tauri-bridge', () => ({ bridge: { getCliUpdateBlockers: mocks.blockers } }));
vi.mock('../../lib/sessionLifecycle', () => ({ planCliUpdateSessions: mocks.plan, settleBackendProcessesForCliUpdate: mocks.settle }));
import { restoreUpdateDrafts, useAppUpdateStore } from '../appUpdateStore';
import { useChatStore } from '../chatStore';
import { useSessionStore } from '../sessionStore';

describe('signed update idle installation and draft recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
    useChatStore.setState({ tabs: new Map(), sessionCache: new Map() });
    useSessionStore.setState({ sessions: [], selectedSessionId: null });
    useAppUpdateStore.setState({ status: { phase: 'downloaded', downloaded: 100 }, waiting: false, busy: false });
    mocks.blockers.mockResolvedValue({ activeSessionIds: [], runningAutomation: false, maintenanceInProgress: false });
    mocks.plan.mockReturnValue({ busyIds: [], unknownIds: [], warmIds: [] });
    mocks.settle.mockResolvedValue(undefined); mocks.invoke.mockResolvedValue(undefined);
  });
  afterEach(() => { useAppUpdateStore.getState().cancelWait(); vi.useRealTimers(); });
  it('waits across polls without disturbing running scheduled work, then installs once idle', async () => {
    mocks.blockers.mockResolvedValueOnce({ activeSessionIds: [], runningAutomation: true });
    useAppUpdateStore.getState().installWhenIdle(); await vi.advanceTimersByTimeAsync(1);
    expect(useAppUpdateStore.getState().waiting).toBe(true); expect(mocks.settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('install_app_update');
    expect(useAppUpdateStore.getState().waiting).toBe(false);
  });
  it('does not install while ownership is unknown and cancellation stops subsequent polls', async () => {
    mocks.plan.mockReturnValue({ busyIds: [], unknownIds: ['unknown'], warmIds: [] });
    useAppUpdateStore.getState().installWhenIdle(); await vi.advanceTimersByTimeAsync(1);
    useAppUpdateStore.getState().cancelWait(); await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it('restores drafts and attachments while still loading the persisted conversation history', () => {
    localStorage.setItem('blackbox:update-drafts', JSON.stringify([{ id: 'disk', text: 'Unsent text', selected: true,
      files: [{ id: 'image', path: '/fixture.png', detailPaths: ['/detail.png'] }],
      session: { id: 'disk', path: '/session.jsonl', project: '/fixture', projectDir: '-fixture', modifiedAt: 1, preview: '' } }]));
    restoreUpdateDrafts(); const chat = useChatStore.getState();
    expect(useSessionStore.getState().selectedSessionId).toBe('disk');
    expect(chat.restoreFromCache('disk')).toBe(false);
    chat.clearMessages('disk');
    expect(chat.getTab('disk')?.inputDraft).toBe('Unsent text');
    expect(chat.getTab('disk')?.pendingAttachments[0].detailPaths).toEqual(['/detail.png']);
    expect(chat.getTab('disk')?.sessionMeta.restoreNeedsHistory).toBeUndefined();
    expect(localStorage.getItem('blackbox:update-drafts')).toBeNull();
  });
});
