/**
 * Session Lifecycle Module — unified spawn / teardown / ownership guard.
 *
 * Pure functions (no React hooks). Can be called from component event
 * handlers, top-level functions (ChatPanel pre-warm), or any non-React
 * context.
 *
 * All Tauri IPC goes through `./tauri-bridge.ts` per project conventions.
 */

import {
  bridge,
  onClaudeStream,
  onClaudeStderr,
  onSessionExit,
  type StartSessionParams,
  type SessionInfo,
} from './tauri-bridge';
import { useChatStore, generateInterruptedId, isSessionBusy } from '../stores/chatStore';
import type { SessionStatus } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useProviderStore } from '../stores/providerStore';
import { streamController } from '../stream/instance';
import type { CliPermissionMode, SessionMode, ThinkingLevel } from '../stores/settingsStore';
import { clearSessionPermissionGrants } from './session-permission-grants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TeardownReason = 'stop' | 'rewind' | 'plan-approve' | 'delete' | 'switch';

export interface SpawnParams {
  tabId: string;
  stdinId: string;
  cwdSnapshot: string;
  configSnapshot: {
    model: string;
    auxiliaryModel: string;
    providerId: string;
    thinkingLevel: ThinkingLevel;
    permissionMode: CliPermissionMode;
    agentTeamsEnabled: boolean;
  };
  sessionModeSnapshot: SessionMode;
  sessionParams: StartSessionParams;
  /** Stream message handler — receives messages tagged with __stdinId */
  onStream: (msg: any) => void;
  /** Stderr line handler */
  onStderr: (line: string) => void;
  /** Whether to set sessionStatus to 'running' after spawn. Default true.
   *  Set to false for pre-warm spawns where no user message is sent yet. */
  setRunning?: boolean;
}

export interface SpawnResult {
  stdinId: string;
  sessionInfo: SessionInfo;
  /** Call to remove all Tauri event listeners registered by this spawn */
  unlisten: () => void;
}

// ---------------------------------------------------------------------------
// finalizeOnce — idempotent gate for process_exit finalization
// ---------------------------------------------------------------------------

const finalizedSet = new Set<string>();
const finalizedTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface RecentlyFinalizedStdin {
  tabId: string;
  reason?: TeardownReason;
  finalizedAt: number;
}

const recentlyFinalizedStdin = new Map<string, RecentlyFinalizedStdin>();
const recentlyFinalizedTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RECENTLY_FINALIZED_TTL_MS = 30_000;

function rememberRecentlyFinalizedStdin(stdinId: string, entry: RecentlyFinalizedStdin): void {
  const existingTimer = recentlyFinalizedTimers.get(stdinId);
  if (existingTimer) clearTimeout(existingTimer);
  recentlyFinalizedStdin.set(stdinId, entry);
  recentlyFinalizedTimers.set(
    stdinId,
    setTimeout(() => {
      recentlyFinalizedStdin.delete(stdinId);
      recentlyFinalizedTimers.delete(stdinId);
    }, RECENTLY_FINALIZED_TTL_MS),
  );
}

export function getRecentlyFinalizedStdin(stdinId: string): RecentlyFinalizedStdin | undefined {
  return recentlyFinalizedStdin.get(stdinId);
}

export function clearRecentlyFinalizedStdin(stdinId: string): void {
  const timer = recentlyFinalizedTimers.get(stdinId);
  if (timer) clearTimeout(timer);
  recentlyFinalizedTimers.delete(stdinId);
  recentlyFinalizedStdin.delete(stdinId);
}

/**
 * Run `fn` exactly once for a given stdinId. Returns true if `fn` ran,
 * false if it was already finalized. Auto-cleans after 30 seconds.
 */
export function finalizeOnce(stdinId: string, fn: () => void): boolean {
  if (finalizedSet.has(stdinId)) return false;
  finalizedSet.add(stdinId);
  finalizedTimers.set(
    stdinId,
    setTimeout(() => {
      finalizedSet.delete(stdinId);
      finalizedTimers.delete(stdinId);
    }, 30_000),
  );
  fn();
  return true;
}

/** Manual cleanup (e.g. test teardown). */
export function clearFinalized(stdinId: string): void {
  const timer = finalizedTimers.get(stdinId);
  if (timer) clearTimeout(timer);
  finalizedTimers.delete(stdinId);
  finalizedSet.delete(stdinId);
  clearRecentlyFinalizedStdin(stdinId);
}

// ---------------------------------------------------------------------------
// checkOwnership — validate that a stdinId still owns its tab
// ---------------------------------------------------------------------------

export type OwnershipResult =
  | { valid: true; tabId: string }
  | { valid: false; reason: 'no-mapping' | 'tab-deleted' | 'stale-stdinId' };

export function checkOwnership(stdinId: string): OwnershipResult {
  const tabId = useSessionStore.getState().getTabForStdin(stdinId);
  if (!tabId) return { valid: false, reason: 'no-mapping' };
  const tab = useChatStore.getState().getTab(tabId);
  if (!tab) return { valid: false, reason: 'tab-deleted' };
  if (tab.sessionMeta.stdinId && tab.sessionMeta.stdinId !== stdinId) {
    return { valid: false, reason: 'stale-stdinId' };
  }
  return { valid: true, tabId };
}

// ---------------------------------------------------------------------------
// cleanupListeners — remove Tauri event listeners for a stdinId
// ---------------------------------------------------------------------------

export function cleanupListeners(stdinId: string): void {
  const unlisteners = (window as any).__claudeUnlisteners;
  if (unlisteners && unlisteners[stdinId]) {
    const unlisten = unlisteners[stdinId];
    delete unlisteners[stdinId];
    try {
      unlisten();
    } catch {
      /* ignore */
    }
  }
}

/** Drop the stdinId route and its listeners when a process is no longer valid. */
export function cleanupStdinRoute(stdinId: string): void {
  clearSessionPermissionGrants(stdinId);
  useSessionStore.getState().unregisterStdinTab(stdinId);
  cleanupListeners(stdinId);
}

/** A backend process is only recoverable if the frontend still has all three:
 *  route mapping, owning tab metadata, and a live listener bundle. */
export function hasRecoverableFrontendSession(stdinId: string): boolean {
  const tabId = useSessionStore.getState().getTabForStdin(stdinId);
  if (!tabId) return false;
  const tab = useChatStore.getState().getTab(tabId);
  if (!tab || tab.sessionMeta.stdinId !== stdinId) return false;
  return Boolean((window as any).__claudeUnlisteners?.[stdinId]);
}

// A page reload destroys listener closures but leaves the Tauri process alive.
// Both App and ConversationList need the same startup barrier, otherwise the
// sidebar can reload a JSONL and immediately spawn --resume while the old child
// is still being killed. Keep one module-level promise so the two callers join
// the same recovery operation.
let startupRecoveryPromise: Promise<void> | null = null;

export function settleOrphanedBackendProcesses(): Promise<void> {
  if (startupRecoveryPromise) return startupRecoveryPromise;
  const recovery = (async () => {
    const activeIds = await bridge.listActiveProcesses();
    const orphaned = activeIds.filter((id) => !hasRecoverableFrontendSession(id));
    await Promise.all(orphaned.map(async (stdinId) => {
      const ownerTabId = useSessionStore.getState().getTabForStdin(stdinId);
      await bridge.gracefulStopSession(stdinId);
      useSessionStore.getState().unregisterStdinTab(stdinId);
      if (ownerTabId && useChatStore.getState().getTab(ownerTabId)?.sessionMeta.stdinId === stdinId) {
        useChatStore.getState().setSessionMeta(ownerTabId, {
          stdinId: undefined,
          stdinReady: false,
          lastProgressAt: undefined,
        });
      }
    }));
  })();
  startupRecoveryPromise = recovery.catch((error) => {
    // Permit an explicit retry, but never turn a failed startup barrier into a
    // successful promise. Disk loading/spawn must remain fail-closed until the
    // orphan process state is known and settled.
    startupRecoveryPromise = null;
    throw error;
  });
  return startupRecoveryPromise;
}

export const __sessionLifecycleTesting = {
  resetStartupRecovery: () => { startupRecoveryPromise = null; },
};

/** Gracefully finish every persistent CLI child before the native app exits. */
export async function gracefullyStopAllBackendProcesses(): Promise<void> {
  const activeIds = await bridge.listActiveProcesses();
  await Promise.all(activeIds.map(async (stdinId) => {
    await bridge.gracefulStopSession(stdinId);
    cleanupStdinRoute(stdinId);
  }));
}

/** Settle persistent CLI children before replacing the Claude executable.
 *
 * Recoverable sessions go through the full frontend teardown path so their
 * stdin route, listener bundle, partial output, and resumable CLI UUID remain
 * internally consistent. Orphans have no UI owner to finalize and are safely
 * drained directly by Rust before their stale route is removed.
 */
export async function settleBackendProcessesForCliUpdate(
  activeIds: string[],
): Promise<void> {
  const plan = planCliUpdateSessions(activeIds);
  if (plan.busyIds.length > 0) {
    throw new Error(`CLI_UPDATE_SESSION_BUSY:${plan.busyIds.length}`);
  }
  if (plan.unknownIds.length > 0) {
    throw new Error(`CLI_UPDATE_SESSION_UNKNOWN:${plan.unknownIds.length}`);
  }

  await Promise.all(plan.warmIds.map(async ({ stdinId, tabId }) => {
    await teardownSession(stdinId, tabId, 'switch');
  }));
}

export interface CliUpdateSessionPlan {
  warmIds: Array<{ stdinId: string; tabId: string }>;
  busyIds: Array<{ stdinId: string; tabId: string }>;
  unknownIds: string[];
}

/** Classify ProcessManager children using the owning tab's live UI state.
 * Completed/idle/stopped sessions are persistent warm connections and can be
 * closed after confirmation. Generating, reconnecting, stopping, or waiting
 * for a user answer must remain under the conversation's own Stop control.
 */
export function planCliUpdateSessions(activeIds: string[]): CliUpdateSessionPlan {
  const plan: CliUpdateSessionPlan = { warmIds: [], busyIds: [], unknownIds: [] };
  for (const stdinId of activeIds) {
    const tabId = useSessionStore.getState().getTabForStdin(stdinId);
    const tab = tabId ? useChatStore.getState().getTab(tabId) : undefined;
    if (!tabId || !tab || tab.sessionMeta.stdinId !== stdinId) {
      plan.unknownIds.push(stdinId);
      continue;
    }
    const entry = { stdinId, tabId };
    if (isSessionBusy(tab.sessionStatus) || tab.activityStatus.phase === 'awaiting') {
      plan.busyIds.push(entry);
    } else {
      plan.warmIds.push(entry);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// spawnSession — unified entry point for starting a CLI process
// ---------------------------------------------------------------------------

/**
 * Start a CLI session with all necessary bookkeeping:
 * 1. Register stdinTab mapping (must be first — triggers orphan drain)
 * 2. Publish stdin ownership to the tab immediately
 * 3. Register 4 listeners: stream / stderr / blackbox_permission_request / exit
 * 4. Start CLI process via bridge
 * 5. Write sessionMeta snapshot
 * 5. Store unlisten in __claudeUnlisteners
 * 6. On failure: rollback all steps
 */
export async function spawnSession(params: SpawnParams): Promise<SpawnResult> {
  const {
    tabId,
    stdinId,
    cwdSnapshot,
    configSnapshot,
    sessionModeSnapshot,
    sessionParams,
    onStream,
    onStderr,
    setRunning = true,
  } = params;
  const rollbacks: (() => void)[] = [];

  // Defense in depth for future spawn callers: Rust resolves provider secrets
  // from providers.json, so no process may start while a newer UI edit exists
  // only in memory. Current UI callers also flush before their config capture.
  await useProviderStore.getState().flushSave();

  // Do not spawn while a reload/startup orphan barrier is unresolved or
  // failed. Otherwise two stdin owners may concurrently resume one CLI UUID.
  await settleOrphanedBackendProcesses();

  try {
    // STEP 1: Register stdinTab mapping FIRST (triggers orphan drain)
    useSessionStore.getState().registerStdinTab(stdinId, tabId);
    rollbacks.push(() => useSessionStore.getState().unregisterStdinTab(stdinId));

    // STEP 2: Publish stdin ownership immediately so the first permission/exit
    // event can see the new owner even before bridge.startSession resolves.
    const previousStdinId = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
    useChatStore.getState().setSessionMeta(tabId, { stdinId });
    rollbacks.push(() => useChatStore.getState().setSessionMeta(tabId, { stdinId: previousStdinId }));

    // STEP 3: Register listeners
    // 3a. Stream listener — tag __stdinId on every message
    const unlistenStream = await onClaudeStream(stdinId, (msg: any) => {
      msg.__stdinId = stdinId;
      onStream(msg);
    });
    rollbacks.push(unlistenStream);

    // 3b. Stderr listener
    const unlistenStderr = await onClaudeStderr(stdinId, (line: string) => {
      onStderr(line);
    });
    rollbacks.push(unlistenStderr);

    // 3c. Permission request via stream channel (blackbox_permission_request)
    // NOTE: This is NOT the dead `claude:permission_request:*` channel.
    // Permission requests arrive through the main stream channel as messages
    // with type 'blackbox_permission_request'. They are handled by onStream
    // in handleStreamMessage. No separate listener needed here — the stream
    // listener above already captures them.

    // 3d. Backup exit listener (dedicated channel, fires if stream process_exit is missed)
    const unlistenExit = await onSessionExit(stdinId, () => {
      const ownership = checkOwnership(stdinId);
      if (!ownership.valid) {
        cleanupStdinRoute(stdinId);
        return;
      }
      const exitTab = useChatStore.getState().getTab(ownership.tabId);
      if (exitTab?.sessionMeta.stdinId === stdinId) {
        // Only act if this is still the active stdinId
        handleProcessExitFinalize(stdinId);
      }
    });
    rollbacks.push(unlistenExit);

    // Store unlisten functions in global map
    if (!(window as any).__claudeUnlisteners) {
      (window as any).__claudeUnlisteners = {};
    }
    let didUnlisten = false;
    const combinedUnlisten = () => {
      if (didUnlisten) return;
      didUnlisten = true;
      unlistenStream();
      unlistenStderr();
      unlistenExit();
    };
    (window as any).__claudeUnlisteners[stdinId] = combinedUnlisten;

    // STEP 4: Start CLI process
    const session = await bridge.startSession(sessionParams);

    // STEP 4b: Set sessionStatus to running. This is critical for switch/plan-approve
    // paths where teardownSession set 'stopped' before we got here. Without this, the
    // tab would appear stopped while the new process is actively running.
    // Skip for pre-warm spawns (setRunning=false) where no user message is sent yet —
    // otherwise InputBar treats stdinId + running as in-flight turn and queues the
    // first real user message into pendingUserMessages.
    if (setRunning) {
      useChatStore.getState().setSessionStatus(tabId, 'running');
    }

    // STEP 5: Write sessionMeta snapshot (both new configSnapshot and legacy fields)
    useChatStore.getState().setSessionMeta(tabId, {
      stdinId,
      cwdSnapshot,
      configSnapshot,
      // Legacy per-session snapshot fields — read by getEffectiveMode/Model/Thinking
      // in settingsStore.ts. Writing them here resolves C1 (fields defined but never written).
      snapshotMode: sessionModeSnapshot,
      snapshotModel: configSnapshot.model,
      snapshotThinking: configSnapshot.thinkingLevel,
      snapshotProviderId: configSnapshot.providerId,
      envFingerprint: undefined, // Will be set by caller if needed
    });

    // STEP 5: Track session if CLI returned a real UUID
    if (session.cli_session_id) {
      useSessionStore.getState().setCliResumeId(tabId, session.cli_session_id);
      if (!session.cli_session_id.startsWith('desk_')) {
        bridge.trackSession(session.cli_session_id).catch(() => {});
      }
    }

    return {
      stdinId,
      sessionInfo: session,
      unlisten: combinedUnlisten,
    };
  } catch (err) {
    // Rollback all completed steps in reverse order
    for (let i = rollbacks.length - 1; i >= 0; i--) {
      try {
        rollbacks[i]();
      } catch {
        /* ignore rollback errors */
      }
    }
    // Clean from global map if it was set
    if ((window as any).__claudeUnlisteners?.[stdinId]) {
      delete (window as any).__claudeUnlisteners[stdinId];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// teardownSession — unified entry point for stopping a CLI process
// ---------------------------------------------------------------------------

/** Active teardown timeouts by stdinId — cleared when process_exit arrives */
const teardownTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Initiate a graceful CLI process shutdown:
 * 1. Set sessionStatus to 'stopping'
 * 2. Ask Rust to stop and confirm child exit
 * 3. Finalize locally only after that confirmation (safe fallback if the exit
 *    event was lost)
 * 4. On timeout/error, keep stdin ownership and fail closed
 */
export async function teardownSession(
  stdinId: string,
  tabId: string,
  reason: TeardownReason,
): Promise<void> {
  useChatStore.getState().setSessionMeta(tabId, { teardownReason: reason });
  // Set stopping state
  useChatStore.getState().setSessionStatus(tabId, 'stopping');

  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutId = setTimeout(() => {
    teardownTimeouts.delete(stdinId);
    rejectTimeout?.(new Error(`SESSION_STOP_TIMEOUT: stdin_id=${stdinId}`));
  }, 12_000);
  teardownTimeouts.set(stdinId, timeoutId);

  const stopProcess = reason === 'stop' || reason === 'delete'
    ? bridge.killSession(stdinId)
    : bridge.gracefulStopSession(stdinId).then(() => undefined);
  try {
    await Promise.race([stopProcess, timeoutPromise]);
  } catch (error) {
    cancelTeardownTimeout(stdinId);
    useChatStore.getState().setSessionStatus(tabId, 'error');
    throw error;
  }
  cancelTeardownTimeout(stdinId);
  // Rust now returns only after the child exit is confirmed. If the frontend
  // process_exit event was dropped, authoritative backend confirmation makes
  // local route finalization safe and prevents waitForStdinCleared deadlock.
  if (!finalizedSet.has(stdinId)) handleProcessExitFinalize(stdinId);
}

/** Cancel any pending teardown timeout (called when process_exit arrives normally). */
export function cancelTeardownTimeout(stdinId: string): void {
  const timer = teardownTimeouts.get(stdinId);
  if (timer) {
    clearTimeout(timer);
    teardownTimeouts.delete(stdinId);
  }
}

export function waitForStdinCleared(
  tabId: string,
  expectedStdinId?: string,
  timeoutMs = 5_500,
): Promise<void> {
  const isCleared = (): boolean => {
    const currentStdinId = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
    if (!currentStdinId) return true;
    return expectedStdinId !== undefined ? currentStdinId !== expectedStdinId : false;
  };

  if (isCleared()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = (unsubscribe: () => void, timer: ReturnType<typeof setTimeout>) => {
      unsubscribe();
      clearTimeout(timer);
    };

    const unsubscribe = useChatStore.subscribe((state) => {
      const currentStdinId = state.getTab(tabId)?.sessionMeta.stdinId;
      if (!currentStdinId || (expectedStdinId !== undefined && currentStdinId !== expectedStdinId)) {
        cleanup(unsubscribe, timer);
        resolve();
      }
    });

    const timer = setTimeout(() => {
      cleanup(unsubscribe, timer);
      reject(new Error(`[sessionLifecycle] waitForStdinCleared timed out for ${tabId}`));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// handleProcessExitFinalize — unified finalization on process exit
// ---------------------------------------------------------------------------

/**
 * Called from process_exit handlers (foreground, background, and backup exit).
 * Uses finalizeOnce to ensure exactly one execution per stdinId.
 *
 * @param stdinId The desk-generated process key
 * @param isTimeout If true, this was triggered by the 5-second timeout
 */
export function handleProcessExitFinalize(stdinId: string, isTimeout = false): void {
  cancelTeardownTimeout(stdinId);

  const ownership = checkOwnership(stdinId);
  if (!ownership.valid) {
    // Stale or orphaned — drop any leftover route and listeners
    cleanupStdinRoute(stdinId);
    clearFinalized(stdinId);
    return;
  }

  const tabId = ownership.tabId;

  finalizeOnce(stdinId, () => {
    const store = useChatStore.getState();
    streamController.flush(stdinId);

    const tab = store.getTab(tabId);
    if (!tab) return;
    const teardownReason = tab.sessionMeta.teardownReason;
    rememberRecentlyFinalizedStdin(stdinId, {
      tabId,
      reason: teardownReason,
      finalizedAt: Date.now(),
    });

    // 2. Save partial text/thinking as interrupted messages
    const pThinking = tab.partialThinking ?? '';
    const pText = tab.partialText ?? '';
    if (pThinking.trim().length > 0) {
      store.addMessage(tabId, {
        id: generateInterruptedId('thinking'),
        role: 'assistant',
        type: 'thinking',
        content: pThinking,
        timestamp: Date.now(),
      });
    }
    if (pText.trim().length > 0) {
      store.addMessage(tabId, {
        id: generateInterruptedId('text'),
        role: 'assistant',
        type: 'text',
        content: pText,
        timestamp: Date.now(),
      });
    }

    // 3. Mark unanswered questions/permissions as cancelled
    for (const m of tab.messages) {
      if (['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved) {
        store.updateMessage(tabId, m.id, {
          resolved: true,
          interactionState: 'failed',
          interactionError: 'CLI process exited',
        });
      }
    }

    // 4. Backfill pending messages to inputDraft
    const pending = tab.pendingUserMessages ?? [];
    const pendingTurnInput = tab.sessionMeta.pendingTurnInput?.trim();
    const pendingTurnAttachments = tab.sessionMeta.pendingTurnAttachments ?? [];
    const isExplicitStop = teardownReason === 'stop';
    const interruptedAssistantText = isExplicitStop && pText.trim().length > 0 ? pText : undefined;
    const combinedDraftParts = [
      isExplicitStop ? pendingTurnInput : '',
      tab.inputDraft ?? '',
      pending.length > 0 ? pending.map((p) => p.text).join('\n\n') : '',
    ].filter((part) => typeof part === 'string' && part.trim().length > 0);
    if (combinedDraftParts.length > 0) {
      store.setInputDraft(tabId, combinedDraftParts.join('\n\n'));
    }
    if (isExplicitStop && pendingTurnInput) {
      if (tab.sessionMeta.pendingTurnMessageId) {
        store.removeMessage(tabId, tab.sessionMeta.pendingTurnMessageId);
      }
      if (pendingTurnAttachments.length > 0) {
        store.setPendingAttachments(tabId, pendingTurnAttachments);
      }
    }
    if (pending.length > 0) {
      store.clearPendingMessages(tabId);
    }

    // 5. Clear stuck pendingCommandMsgId
    const pendingCmdMsgId = tab.sessionMeta.pendingCommandMsgId;
    if (pendingCmdMsgId) {
      store.updateMessage(tabId, pendingCmdMsgId, { commandCompleted: true });
      store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
    }

    // 5b. Clear per-tab autoCompact tracking (NEW-B fix)
    clearAutoCompact(tabId);

    // 6. Clear sessionMeta: clear stdinId, KEEP cliResumeId and cwdSnapshot
    store.setSessionMeta(tabId, {
      stdinId: undefined,
      lastProgressAt: undefined,
      apiRetry: undefined,
      teardownReason: undefined,
      pendingTurnMessageId: undefined,
      pendingTurnInput: undefined,
      pendingTurnAttachments: undefined,
      interruptedAssistantText,
    });

    // 7-8. Drop stdinTab mapping and listeners
    cleanupStdinRoute(stdinId);

    // 9. StreamController cleanup
    streamController.forgetCompletion(stdinId);

    // 10. Set final sessionStatus
    const currentStatus = store.getTab(tabId)?.sessionStatus;
    let finalStatus: SessionStatus;
    if (teardownReason === 'stop') {
      finalStatus = 'stopped';
    } else if (isTimeout) {
      finalStatus = 'error';
    } else if (currentStatus === 'stopping') {
      finalStatus = 'stopped';
    } else {
      finalStatus = 'idle';
    }
    store.setSessionStatus(tabId, finalStatus);

    // Refresh session list
    useSessionStore.getState().fetchSessions();
  });
}

// ---------------------------------------------------------------------------
// autoCompactFiredMap — per-tab tracking (replaces global ref)
// ---------------------------------------------------------------------------

/** Per-tab auto-compact tracking. Replaces the module-level `autoCompactFiredRef`
 *  in InputBar.tsx to avoid cross-tab pollution. */
export const autoCompactFiredMap = new Map<string, boolean>();

/** Mark auto-compact as fired for a tab. */
export function markAutoCompactFired(tabId: string): void {
  autoCompactFiredMap.set(tabId, true);
}

/** Check if auto-compact has fired for a tab. */
export function hasAutoCompactFired(tabId: string): boolean {
  return autoCompactFiredMap.get(tabId) ?? false;
}

/** Clear auto-compact tracking for a tab (called on teardown). */
export function clearAutoCompact(tabId: string): void {
  autoCompactFiredMap.delete(tabId);
}
