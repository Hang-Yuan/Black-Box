import { useCallback, useRef, type MutableRefObject } from 'react';
import { APP_NAME } from '../lib/edition';
import { useChatStore, generateMessageId, type ChatMessage } from '../stores/chatStore';
import { useSettingsStore, getEffectiveMode, getEffectiveThinking } from '../stores/settingsStore';
import { useSessionStore, setOrphanDrainCallback } from '../stores/sessionStore';
import {
  useAgentStore,
  resolveAgentId,
  resolveAgentEventId,
  getAgentDepth,
  appendCachedAgentActivity,
  upsertCachedAgent,
  updateCachedAgentPhase,
  settleCachedAgent,
  settleCachedTurn,
  registerCachedTeamTask,
  resolveCachedTeamTask,
  updateCachedTeamTask,
} from '../stores/agentStore';
import type { AgentNode, TeamTask } from '../stores/agentStore';
import { runtimeInventoryFromMessage, useCommandStore } from '../stores/commandStore';
import { useFileStore } from '../stores/fileStore';
import { useMcpStore } from '../stores/mcpStore';
import { usePlanStore } from '../stores/planStore';
import { useWorkflowStore } from '../stores/workflowStore';
import { adoptCliSessionIdentity } from '../lib/session-identity';
import { bridge } from '../lib/tauri-bridge';
import { spawnConfigHash, getAutoCompactThreshold } from '../lib/api-provider';
import { buildApiRetryStatus } from '../lib/api-retry';
import {
  assistantContentHasVisibleTerminalResponse,
  decideEmptyTerminalRecovery,
  effectiveContextInputTokens,
  EMPTY_TERMINAL_RECOVERY_PROMPT,
  isGenericContextGreeting,
  isGreetingOnlyPrompt,
  shouldRetryContextDrop,
} from '../lib/context-recovery';
import {
  isCliPlaceholder,
  sanitizeAssistantTextForDisplay,
  sanitizeToolResultForDisplay,
} from '../lib/presentation-sanitizer';
import { useProviderStore } from '../stores/providerStore';
import { t } from '../lib/i18n';
import {
  clearPreservedThinkingSnapshot,
  filterThinkingDeltaAfterPreservedSnapshot,
  rememberPreservedThinkingSnapshot,
} from '../stream/thinkingDedupe';
import {
  checkOwnership,
  handleProcessExitFinalize,
  cleanupStdinRoute,
  teardownSession,
  waitForStdinCleared,
  hasAutoCompactFired,
  markAutoCompactFired,
  getRecentlyFinalizedStdin,
} from '../lib/sessionLifecycle';
import { matchingSessionPermissionGrants } from '../lib/session-permission-grants';
import { recordLoopToolReceipt } from '../stores/loopStore';
import {
  isForwardedSubagentEvent,
  isFailedAgentTaskStatus,
  messageTextContent,
  parseAgentTaskNotification,
  parseAsyncAgentLaunch,
  type AsyncAgentLaunch,
} from '../lib/agent-lifecycle';

function syncNativeTaskPlan(tabId: string, tasks: Iterable<TeamTask>): void {
  const items = Array.from(tasks)
    .filter((task) => task.status !== 'deleted')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((task) => ({
      step: task.subject,
      status: task.status,
      ...(task.activeForm ? { activeForm: task.activeForm } : {}),
    }));
  if (items.length > 0) {
    usePlanStore.getState().setPlan(tabId, items, undefined, 'native_tasks');
  } else if (usePlanStore.getState().plans[tabId]?.source === 'native_tasks') {
    usePlanStore.getState().clearPlan(tabId);
  }
}

function recordNativeLoopReceipt(
  tabId: string,
  parentMessage: ChatMessage | undefined,
  resultText: string,
  fallbackToolName?: string,
): void {
  recordLoopToolReceipt({
    threadId: tabId,
    toolName: parentMessage?.toolName || fallbackToolName,
    toolInput: parentMessage?.toolInput,
    resultText,
    occurredAt: parentMessage?.timestamp,
  });
}

function addRegularPermissionCard(tabId: string, msg: any, ownerStdinId?: string): void {
  const store = useChatStore.getState();
  const existing = store.getTab(tabId)?.messages.find(
    (message) => message.type === 'permission'
      && message.permissionData?.requestId === msg.request_id
      && message.interactionState !== 'failed',
  );
  if (existing) return;
  store.addMessage(tabId, {
    id: generateMessageId(),
    role: 'assistant',
    type: 'permission',
    content: msg.title || msg.description || `${msg.tool_name} wants to execute`,
    permissionTool: msg.tool_name,
    permissionDescription: msg.description || msg.decision_reason || '',
    timestamp: Date.now(),
    interactionState: 'pending',
    permissionData: {
      requestId: msg.request_id,
      toolName: msg.tool_name,
      input: msg.input,
      description: msg.description,
      toolUseId: msg.tool_use_id,
      permissionSuggestions: msg.permission_suggestions,
      blockedPath: msg.blocked_path,
      decisionReason: msg.decision_reason,
      decisionReasonType: msg.decision_reason_type,
      classifierApprovable: msg.classifier_approvable,
      title: msg.title,
      displayName: msg.display_name,
      requiresUserInteraction: msg.requires_user_interaction,
    },
    owner: ownerStdinId ? { tabId, stdinId: ownerStdinId } : undefined,
  });
  store.setActivityStatus(tabId, { phase: 'awaiting' });
}

function expireSdkControlRequest(tabId: string, msg: any): void {
  const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
  if (!requestId) return;
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  const reason = typeof msg.reason === 'string' && msg.reason.trim()
    ? msg.reason.trim()
    : t('msg.requestCancelled');
  for (const message of tab?.messages ?? []) {
    if (message.permissionData?.requestId !== requestId || message.resolved) continue;
    store.updateMessage(tabId, message.id, {
      resolved: true,
      interactionState: 'expired',
      interactionError: reason,
    });
  }
  store.setActivityStatus(tabId, { phase: 'thinking' });
}

function autoAllowRegisteredSessionPermission(
  tabId: string,
  msg: any,
  ownerStdinId?: string,
): boolean {
  if (!ownerStdinId) return false;
  const updates = matchingSessionPermissionGrants(ownerStdinId, msg.permission_suggestions);
  if (updates.length === 0) return false;
  void bridge.respondPermission(
    ownerStdinId,
    msg.request_id,
    true,
    undefined,
    msg.tool_use_id,
    msg.input,
    updates,
  ).then(() => {
    const store = useChatStore.getState();
    store.setSessionStatus(tabId, 'running');
    store.setActivityStatus(tabId, { phase: 'thinking' });
  }).catch((error) => {
    console.warn('[BLACKBOX:permission] Session grant response failed:', error);
    addRegularPermissionCard(tabId, msg, ownerStdinId);
  });
  return true;
}

async function generateSessionTitleWithPersistedProvider(
  userMessage: string,
  assistantMessage: string,
) {
  await useProviderStore.getState().flushSave();
  const providerId = useProviderStore.getState().activeProviderId || undefined;
  return bridge.generateSessionTitle(userMessage, assistantMessage, providerId);
}

// --- Error classification for user-facing messages ---
// Each pattern maps to a friendly i18n key. Matched errors show the friendly
// message as primary text with raw error in a collapsible details block.
// Unmatched errors get a generic fallback + raw details.
const ERROR_CATEGORIES: ReadonlyArray<{ pattern: RegExp; i18nKey: string }> = [
  { pattern: /40[13]|unauthorized|invalid.*key|api.key.*invalid/i, i18nKey: 'error.invalidKey' },
  { pattern: /429|rate.limit|too.many.request/i, i18nKey: 'error.rateLimit' },
  { pattern: /quota|insufficient.*balance|credit|billing/i, i18nKey: 'error.quotaExceeded' },
  // Fable rejected as unknown means the installed CLI predates the model —
  // the fix is a CLI upgrade, not switching models. Must match before the
  // generic modelNotFound rule below.
  { pattern: /(?=[\s\S]*fable)(?=[\s\S]*(not.?found|does.?not.?exist|invalid|unknown|unsupported))/i, i18nKey: 'error.modelNeedsNewerCli' },
  { pattern: /model.*not.found|invalid.*model|not_found.*model/i, i18nKey: 'error.modelNotFound' },
  { pattern: /timeout|timed?.out|ECONNREFUSED|ECONNRESET|ENOTFOUND/i, i18nKey: 'error.networkError' },
  { pattern: /network|fetch.failed|dns/i, i18nKey: 'error.networkError' },
  { pattern: /permission.denied|operation.not.permitted|access.denied|forbidden/i, i18nKey: 'error.permissionDenied' },
  { pattern: /overloaded|capacity|503|service.unavailable/i, i18nKey: 'error.serviceUnavailable' },
  { pattern: /not.installed|command.not.found/i, i18nKey: 'error.cliNotInstalled' },
  { pattern: /token.*limit|context.*length|too.long/i, i18nKey: 'error.tokenLimit' },
];

export function formatErrorForUser(raw: string): string {
  if (!raw || raw.length < 10) return raw;
  const match = ERROR_CATEGORIES.find((c) => c.pattern.test(raw));
  const friendly = match ? t(match.i18nKey) : t('error.genericFallback');
  return `${friendly}\n\n<details>\n<summary>${t('error.showDetails')}</summary>\n\n\`\`\`\n${raw}\n\`\`\`\n\n</details>`;
}

function shouldHoldPotentialContextDropGreeting(tabId: string, text: string): boolean {
  const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
  return (meta?.contextRecoveryAttempts ?? 0) < 1
    && !isGreetingOnlyPrompt(meta?.activeTurnInput)
    && isGenericContextGreeting(text);
}

// --- Streaming text buffer ---
// Ownership of the rAF buffer, orphan queue, and completion guard lives in
// StreamController (src/stream/StreamController.ts). This module is now a
// thin call-site for the singleton. See roadmap §4.3.1.
import { streamController, DEFAULT_CONFIG as _STREAM_CONFIG } from '../stream/instance';

/** Drain any orphan buffer for the given stdinId into its newly known tab.
 *  Called by sessionStore.registerStdinTab via the registered callback. */
export function drainOrphanBuffer(stdinId: string, tabId: string) {
  streamController.drainOrphan(stdinId, tabId, (msg: unknown) => {
    const globalWindow = window as any;
    const handler = globalWindow.__claudeStreamHandler;
    if (typeof handler === 'function') {
      handler(msg);
      return;
    }
    if (!Array.isArray(globalWindow.__claudeStreamQueue)) {
      globalWindow.__claudeStreamQueue = [];
    }
    globalWindow.__claudeStreamQueue.push(msg);
  });
}

/** Test-only seam for orphan-queue regression coverage. Not part of the
 *  runtime API surface — do not import from production code. */
export const __orphanTesting = {
  stash: (stdinId: string, text: string, thinking: string) =>
    streamController.stashOrphan(stdinId, text, thinking),
  stashEvent: (stdinId: string, event: unknown) =>
    streamController.stashOrphanEvent(stdinId, event),
  expire: () => streamController.expireOrphans(),
  size: (): number => streamController.__testing.orphansSize(),
  has: (stdinId: string): boolean => streamController.__testing.hasOrphan(stdinId),
  get: (stdinId: string) => streamController.__testing.getOrphan(stdinId),
  clear: () => streamController.__testing.clear(),
  totalChars: (): number => streamController.__testing.orphanTotalChars(),
  TTL_MS: _STREAM_CONFIG.ttlMs,
  PER_STDIN_CAP: _STREAM_CONFIG.perStdinCapChars,
  TOTAL_CAP: _STREAM_CONFIG.totalCapChars,
};

// Register the drain callback so sessionStore.registerStdinTab can flush
// orphaned buffers without creating a circular import dependency.
setOrphanDrainCallback(drainOrphanBuffer);

function captureCliSessionIdentity(tabId: string, msg: any, stdinId?: string): string {
  const cliSessionId = msg.session_id || msg.sessionId;
  if (typeof cliSessionId !== 'string' || !cliSessionId.trim()) return tabId;
  const currentResumeId = useSessionStore.getState().sessions
    .find((session) => session.id === tabId)?.cliResumeId;
  if (currentResumeId === cliSessionId && !tabId.startsWith('draft_')) return tabId;

  const adoptedTabId = adoptCliSessionIdentity(tabId, cliSessionId, stdinId);
  bridge.trackSession(cliSessionId).catch(() => {});
  useSessionStore.getState().fetchSessions();
  return adoptedTabId;
}

// --- Shared pendingCommand completion helper (#27) ---
// Both foreground and background handlers must clear pendingCommandMsgId when
// a result or assistant event arrives. Without this, slash commands like /compact
// that complete on a background tab leave the spinner stuck forever.
interface CompletePendingCommandOpts {
  output?: string;
  costSummary?: { cost: string; duration: string; turns: string | number; input: string; output: string; };
}

export function completePendingCommand(tabId: string, opts: CompletePendingCommandOpts = {}) {
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  const pendingCmdMsgId = tab?.sessionMeta.pendingCommandMsgId;
  if (!pendingCmdMsgId) return;
  const cmdMsg = (tab?.messages ?? []).find((m) => m.id === pendingCmdMsgId);
  store.updateMessage(tabId, pendingCmdMsgId, {
    commandCompleted: true,
    commandData: {
      ...cmdMsg?.commandData,
      ...(opts.output !== undefined ? { output: opts.output } : {}),
      ...(opts.costSummary ? { costSummary: opts.costSummary } : {}),
      completedAt: Date.now(),
    },
  });
  store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
}

/** Mark a long-running command without releasing its busy/ownership gates. */
export function markPendingCommandSlow(tabId: string, commandId: string, statusText: string): boolean {
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  if (tab?.sessionMeta.pendingCommandMsgId !== commandId) return false;
  const command = (tab.messages ?? []).find((message) => message.id === commandId);
  store.updateMessage(tabId, commandId, {
    commandCompleted: false,
    commandData: {
      ...command?.commandData,
      slow: true,
      statusText,
      slowSince: Date.now(),
    },
  });
  return true;
}

interface EmptyTerminalRecoveryResultArgs {
  tabId: string;
  stdinId: string | undefined;
  subtype: string | undefined;
  resultDisplayText: string;
  usage: any;
}

/**
 * Keep a successful CLI result from silently settling an unfinished turn.
 * Recovery stays on the same stdin/durable session, is bounded, and compacts
 * once before retrying when cached + uncached input is close to the window.
 */
function handleEmptyTerminalRecoveryResult({
  tabId,
  stdinId,
  subtype,
  resultDisplayText,
  usage,
}: EmptyTerminalRecoveryResultArgs): boolean {
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  const meta = tab?.sessionMeta ?? {};
  const safeResult = resultDisplayText.trim();
  const resultAddsVisibleText = Boolean(
    safeResult
    && !isCliPlaceholder(safeResult)
    && !(tab?.messages ?? []).some(
      (message) => message.role === 'assistant'
        && message.type === 'text'
        && message.content === safeResult,
    ),
  );
  const action = decideEmptyTerminalRecovery({
    subtype,
    activeTurnInput: meta.activeTurnInput,
    awaitingVisibleAssistantResponse: meta.awaitingVisibleAssistantResponse,
    resultAddsVisibleText,
    attempts: meta.contextRecoveryAttempts,
    stdinAvailable: Boolean(stdinId),
    pendingCommand: Boolean(meta.pendingCommandMsgId),
    recoveryCompactPending: meta.emptyTerminalRecoveryAfterCompact,
    contextInputTokens: effectiveContextInputTokens(usage),
    autoCompactThreshold: getAutoCompactThreshold(meta.spawnedModel),
    compactAlreadyFired: hasAutoCompactFired(tabId),
  });
  if (action === 'none') return false;

  const failRecovery = (messageKey: 'error.emptyTerminalExhausted' | 'error.emptyTerminalRecoveryFailed') => {
    completePendingCommand(tabId, { output: t(messageKey) });
    store.setSessionStatus(tabId, 'error');
    store.setActivityStatus(tabId, { phase: 'error' });
    store.setSessionMeta(tabId, {
      turnStartTime: undefined,
      lastProgressAt: undefined,
      apiRetry: undefined,
      activeTurnInput: undefined,
      contextRecoveryAttempts: undefined,
      awaitingVisibleAssistantResponse: undefined,
      emptyTerminalRecoveryAfterCompact: undefined,
    });
    store.addMessage(tabId, {
      id: generateMessageId(),
      role: 'system',
      type: 'text',
      content: t(messageKey),
      commandType: 'error',
      timestamp: Date.now(),
    });
  };

  if (action === 'fail' || !stdinId) {
    console.error('[BLACKBOX] Empty terminal response recovery exhausted', { tabId });
    failRecovery('error.emptyTerminalExhausted');
    return true;
  }

  const attempts = meta.contextRecoveryAttempts ?? 0;
  const startedAt = Date.now();
  if (action === 'compact') {
    const compactMsgId = generateMessageId();
    markAutoCompactFired(tabId);
    store.addMessage(tabId, {
      id: compactMsgId,
      role: 'system',
      type: 'text',
      content: t('chat.autoCompacting'),
      commandType: 'processing',
      commandData: { command: '/compact', automatic: true, recovery: true },
      commandStartTime: startedAt,
      commandCompleted: false,
      timestamp: startedAt,
    });
    store.setSessionMeta(tabId, {
      pendingCommandMsgId: compactMsgId,
      contextRecoveryAttempts: attempts + 1,
      awaitingVisibleAssistantResponse: true,
      emptyTerminalRecoveryAfterCompact: true,
      turnStartTime: startedAt,
      lastProgressAt: startedAt,
      inputTokens: 0,
      outputTokens: 0,
      apiRetry: undefined,
    });
    store.setSessionStatus(tabId, 'running');
    store.setActivityStatus(tabId, { phase: 'thinking' });
    console.warn('[BLACKBOX] Empty terminal response near context limit; compacting before recovery', {
      tabId,
      contextInputTokens: effectiveContextInputTokens(usage),
    });
    bridge.sendStdin(stdinId, '/compact').catch((error) => {
      console.error('[BLACKBOX] Empty terminal recovery compact failed:', error);
      failRecovery('error.emptyTerminalRecoveryFailed');
    });
    setTimeout(() => {
      if (store.getTab(tabId)?.sessionMeta.pendingCommandMsgId === compactMsgId) {
        markPendingCommandSlow(tabId, compactMsgId, t('chat.compactStillRunning'));
      }
    }, 15_000);
    return true;
  }

  completePendingCommand(tabId);
  store.setSessionMeta(tabId, {
    contextRecoveryAttempts: action === 'retry' ? attempts + 1 : attempts,
    awaitingVisibleAssistantResponse: true,
    emptyTerminalRecoveryAfterCompact: false,
    turnStartTime: startedAt,
    lastProgressAt: startedAt,
    inputTokens: 0,
    outputTokens: 0,
    apiRetry: undefined,
  });
  store.setSessionStatus(tabId, 'running');
  store.setActivityStatus(tabId, { phase: 'thinking' });
  console.warn('[BLACKBOX] Empty terminal response detected; resuming durable session', {
    tabId,
    attempt: action === 'retry' ? attempts + 1 : attempts,
    afterCompact: action === 'resume_after_compact',
  });
  bridge.sendStdin(stdinId, EMPTY_TERMINAL_RECOVERY_PROMPT).catch((error) => {
    console.error('[BLACKBOX] Empty terminal recovery retry failed:', error);
    failRecovery('error.emptyTerminalRecoveryFailed');
  });
  return true;
}

interface DrainPendingQueueOptions {
  tabId: string;
  stdinId: string | undefined;
  wasStopping: boolean;
  onDraftRestored?: (draft: string) => void;
  retryRestoredDraft?: () => void;
  onUserBatchSent?: (text: string) => void;
}

/**
 * Drain exactly one FIFO item after a result settles. User follow-ups and
 * slash commands each own a separate turn/card; a later result advances the
 * queue by one more item.
 */
export function drainPendingQueueAfterSettlement({
  tabId,
  stdinId,
  wasStopping,
  onDraftRestored,
  retryRestoredDraft,
  onUserBatchSent,
}: DrainPendingQueueOptions): boolean {
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  const allPending = tab?.pendingUserMessages ?? [];
  if (allPending.length === 0 || !stdinId || wasStopping) return false;

  const firstPending = allPending[0];
  if (!firstPending) return false;
  const firstIsCommand = firstPending.kind === 'command';
  const stage = [firstPending];

  const currentHash = spawnConfigHash();
  const hashMismatch = stage.some(
    (item) => item.enqueueConfigHash !== undefined && item.enqueueConfigHash !== currentHash,
  );
  const sessionHashMismatch = tab?.sessionMeta.spawnConfigHash !== undefined
    && tab.sessionMeta.spawnConfigHash !== currentHash;
  const stdinMismatch = stage.some(
    (item) => item.enqueueStdinId !== undefined && item.enqueueStdinId !== stdinId,
  );
  if (hashMismatch || sessionHashMismatch || stdinMismatch) {
    for (const item of allPending) {
      if (item.kind === 'command' && item.commandMessageId) {
        const command = store.getTab(tabId)?.messages.find(
          (message) => message.id === item.commandMessageId,
        );
        store.updateMessage(tabId, item.commandMessageId, {
          commandCompleted: true,
          commandData: {
            ...command?.commandData,
            queued: false,
            cancelled: true,
            completedAt: Date.now(),
          },
        });
      }
    }
    store.restorePendingQueueToDraft(tabId);
    const restoredDraft = store.getTab(tabId)?.inputDraft ?? '';
    onDraftRestored?.(restoredDraft);
    retryRestoredDraft?.();
    console.warn('[BLACKBOX] Pending queue restored because process/config ownership changed');
    return false;
  }

  if (firstIsCommand) {
    const command = store.shiftPendingMessage(tabId)!;
    const commandMessageId = command.commandMessageId || generateMessageId();
    if (!command.commandMessageId) {
      store.addMessage(tabId, {
        id: commandMessageId,
        role: 'system',
        type: 'text',
        content: '',
        commandType: 'processing',
        commandData: { command: command.text },
        commandStartTime: Date.now(),
        commandCompleted: false,
        timestamp: Date.now(),
      });
    } else {
      const existing = store.getTab(tabId)?.messages.find(
        (message) => message.id === commandMessageId,
      );
      store.updateMessage(tabId, commandMessageId, {
        commandStartTime: Date.now(),
        commandCompleted: false,
        commandData: { ...existing?.commandData, queued: false, startedAt: Date.now() },
      });
    }
    store.setSessionMeta(tabId, {
      pendingCommandMsgId: commandMessageId,
      turnStartTime: Date.now(),
      lastProgressAt: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
    });
    store.setSessionStatus(tabId, 'running');
    store.setActivityStatus(tabId, { phase: 'thinking' });
    bridge.sendStdin(stdinId, command.text).catch((error) => {
      console.error('[BLACKBOX] Failed to send queued command:', error);
      completePendingCommand(tabId, { output: 'Command failed to start' });
      if (store.getTab(tabId)?.sessionStatus === 'running') {
        store.setSessionStatus(tabId, 'error');
      }
    });
    return true;
  }

  store.shiftPendingMessage(tabId);
  const queuedText = stage[0].text;
  const pendingTurnMessageId = generateMessageId();
  store.addMessage(tabId, {
    id: pendingTurnMessageId,
    role: 'user',
    type: 'text',
    content: queuedText,
    timestamp: Date.now(),
  });
  store.setSessionStatus(tabId, 'running');
  store.setSessionMeta(tabId, {
    pendingTurnMessageId,
    pendingTurnInput: queuedText,
    activeTurnInput: queuedText,
    contextRecoveryAttempts: 0,
    awaitingVisibleAssistantResponse: true,
    emptyTerminalRecoveryAfterCompact: false,
    turnAcceptedForResume: false,
    turnStartTime: Date.now(),
    lastProgressAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
  });
  store.setActivityStatus(tabId, { phase: 'thinking' });
  onUserBatchSent?.(queuedText);
  bridge.sendStdin(stdinId, queuedText).catch((error) => {
    console.error('[BLACKBOX] Failed to send pending messages:', error);
    const draft = store.getTab(tabId)?.inputDraft ?? '';
    store.setInputDraft(tabId, draft ? `${draft}\n\n${queuedText}` : queuedText);
    cleanupStdinRoute(stdinId);
    store.setSessionMeta(tabId, {
      stdinId: undefined,
      stdinReady: false,
      pendingReadyMessage: undefined,
      activeTurnInput: undefined,
      contextRecoveryAttempts: undefined,
      awaitingVisibleAssistantResponse: undefined,
      emptyTerminalRecoveryAfterCompact: undefined,
    });
    store.setSessionStatus(tabId, 'error');
  });
  return true;
}

function markStdinReady(tabId: string, stdinId: string | undefined, model: string | undefined) {
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  const meta = tab?.sessionMeta ?? {};
  const pendingReady = meta.pendingReadyMessage;
  const shouldStartTurn = tab?.sessionStatus === 'running' && !meta.turnStartTime;
  const startedAt = shouldStartTurn ? Date.now() : undefined;

  store.setSessionMeta(tabId, {
    ...(model !== undefined ? { model } : {}),
    stdinReady: true,
    ...(shouldStartTurn ? {
      turnStartTime: startedAt,
      lastProgressAt: startedAt,
      inputTokens: 0,
      outputTokens: 0,
    } : {}),
    ...(pendingReady?.stdinId === stdinId ? { pendingReadyMessage: undefined } : {}),
  });

  if (shouldStartTurn) {
    store.setActivityStatus(tabId, {
      phase: shouldRenderThinkingForTab(tabId) ? 'thinking' : 'writing',
    });
  }

  if (stdinId) {
    const queuedSteers = store.takePendingSteers(tabId, stdinId);
    if (pendingReady?.stdinId === stdinId || queuedSteers.length > 0) {
      void (async () => {
        let deliveredSteers = 0;
        try {
          // Preserve ordering: the initial ready-gated prompt enters the
          // agent loop before guidance typed while the process was starting.
          if (pendingReady?.stdinId === stdinId) {
            await bridge.sendStdin(stdinId, pendingReady.text);
          }
          for (const steer of queuedSteers) {
            await bridge.sendStdin(stdinId, steer.text);
            store.addMessage(tabId, {
              id: generateMessageId(),
              role: 'user',
              type: 'text',
              content: steer.text,
              isSteer: true,
              steerState: 'sent',
              timestamp: steer.enqueueAt ?? Date.now(),
            });
            deliveredSteers += 1;
          }
          if (queuedSteers.length > 0) {
            store.setSessionMeta(tabId, { lastProgressAt: Date.now() });
          }
        } catch (err) {
          console.error('[BLACKBOX] Failed to flush ready-gated input:', err);
          const unsent = queuedSteers.slice(deliveredSteers).map((item) => item.text).join('\n\n');
          if (unsent) {
            const draft = store.getTab(tabId)?.inputDraft.trim() || '';
            store.setInputDraft(tabId, draft ? `${draft}\n\n${unsent}` : unsent);
          }
          cleanupStdinRoute(stdinId);
          store.setSessionMeta(tabId, {
            stdinId: undefined,
            stdinReady: false,
            pendingReadyMessage: undefined,
            pendingTurnMessageId: undefined,
            pendingTurnInput: undefined,
            pendingTurnAttachments: undefined,
            activeTurnInput: undefined,
            contextRecoveryAttempts: undefined,
            awaitingVisibleAssistantResponse: undefined,
            emptyTerminalRecoveryAfterCompact: undefined,
            turnStartTime: undefined,
            lastProgressAt: undefined,
            apiRetry: undefined,
          });
          store.setSessionStatus(tabId, 'error');
          store.addMessage(tabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: '预热会话就绪后发送消息失败，请重发一次。',
            timestamp: Date.now(),
          });
        }
      })();
    }
  }
}

/** Flush any buffered streaming text immediately (call before clearPartial).
 *  If stdinId is provided, flush only that session's buffer.
 *  If omitted, flush ALL buffers (backward compat). */
export function flushStreamBuffer(stdinId?: string) {
  streamController.flush(stdinId);
}

function buildThinkingSnapshot(msgUuid: string | undefined, content: any[]) {
  const thinkingBlocks = content.filter(
    (b: any) => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0,
  );
  if (thinkingBlocks.length === 0) return null;
  return {
    id: msgUuid ? `${msgUuid}_thinking` : generateMessageId(),
    content: thinkingBlocks.map((b: any) => b.thinking).join(''),
  };
}

function appendDedupedThinking(base: string, next: string) {
  if (!base) return next;
  if (!next) return base;

  const trimmedNext = next.trim();
  const trimmedBase = base.trim();
  if (!trimmedNext) return base;
  if (!trimmedBase) return next;
  if (base.includes(trimmedNext)) return base;
  if (next.includes(trimmedBase)) return next;

  const maxOverlap = Math.min(base.length, next.length);
  for (let len = maxOverlap; len > 0; len--) {
    if (base.endsWith(next.slice(0, len))) {
      return base + next.slice(len);
    }
  }
  return base + next;
}

function mergeThinkingContent(...parts: Array<string | undefined>) {
  const merged = parts.reduce<string>((acc, part) => {
    if (!part || part.trim().length === 0) return acc;
    return appendDedupedThinking(acc, part);
  }, '');
  return merged.trim();
}

function buildCommittedThinkingId(msgUuid: string | undefined) {
  return msgUuid ? `${msgUuid}__thinking_committed` : undefined;
}

function logicalAssistantMessageId(msg: any): string | undefined {
  const sdkMessageId = typeof msg?.message?.id === 'string'
    ? msg.message.id.trim()
    : '';
  if (sdkMessageId) return sdkMessageId;
  return typeof msg?.uuid === 'string' && msg.uuid.trim() ? msg.uuid : undefined;
}

function resolveThinkingPersistence(
  msgUuid: string | undefined,
  content: any[],
  partialThinking: string | undefined,
  bufferedThinking?: string,
) {
  const snapshot = buildThinkingSnapshot(msgUuid, content);
  const mergedContent = mergeThinkingContent(
    snapshot?.content,
    partialThinking,
    bufferedThinking,
  );
  if (!mergedContent) return null;
  return {
    id: snapshot?.id ?? (msgUuid ? `${msgUuid}_thinking` : generateMessageId()),
    content: mergedContent,
  };
}

function shouldMaterializeThinkingSnapshot(content: any[], hasTextBlock: boolean) {
  if (hasTextBlock) return true;
  return content.some(
    (b: any) =>
      b.type === 'tool_use'
      || b.type === 'tool_result'
      || b.type === 'todo',
  );
}

function isPureThinkingOnlySnapshot(content: any[]) {
  return content.length > 0
    && content.every((b: any) => b.type === 'thinking')
    && content.some(
      (b: any) => typeof b.thinking === 'string' && b.thinking.length > 0,
    );
}

function shouldCreateStreamingToolPlaceholder(toolName: string | undefined) {
  return Boolean(
    toolName
      && toolName !== 'ExitPlanMode'
      && toolName !== 'Task'
      && toolName !== 'Agent'
      && toolName !== 'TaskCreate'
      && toolName !== 'SendMessage'
      && toolName !== 'AskUserQuestion',
  );
}

/** Claude's Agent/SendMessage launch results contain internal agent ids and
 * private task-output paths that the CLI explicitly marks as non-user-facing.
 * Keep the completion state on the card, but never render that metadata. */
function agentToolIdentity(block: any): {
  kind: 'subagent' | 'teammate';
  name?: string;
  model?: string;
  description: string;
} {
  const teammateName = typeof block?.input?.name === 'string'
    ? block.input.name.trim()
    : '';
  const subagentType = [
    block?.input?.subagent_type,
    block?.input?.subagentType,
    block?.input?.agent_type,
    block?.input?.agentType,
  ].find((value) => typeof value === 'string' && value.trim())?.trim() || '';
  const model = typeof block?.input?.model === 'string'
    ? block.input.model.trim()
    : '';
  const description = teammateName
    || (typeof block?.input?.description === 'string' ? block.input.description : '')
    || (typeof block?.input?.prompt === 'string' ? block.input.prompt : '');
  return {
    kind: teammateName ? 'teammate' : 'subagent',
    name: teammateName || subagentType || undefined,
    model: model || undefined,
    description,
  };
}

function backgroundAgentNode(
  launch: AsyncAgentLaunch,
  agents: Map<string, AgentNode>,
): AgentNode {
  const id = resolveAgentEventId(launch.toolUseId, launch.taskId, agents)
    ?? launch.toolUseId
    ?? launch.taskId;
  const existing = agents.get(id);
  const toolUseIds = Array.from(new Set([
    ...(existing?.toolUseIds ?? []),
    ...(launch.toolUseId ? [launch.toolUseId] : []),
  ]));
  return {
    id,
    parentId: existing?.parentId ?? 'main',
    description: launch.description ?? existing?.description ?? 'Background Agent',
    phase: 'thinking',
    startTime: existing?.startTime ?? Date.now(),
    isMain: false,
    kind: existing?.kind ?? 'subagent',
    name: existing?.name,
    model: launch.model ?? existing?.model,
    taskId: launch.taskId,
    toolUseIds,
    background: true,
  };
}

function shouldRenderThinkingForTab(tabId: string) {
  const tab = useChatStore.getState().getTab(tabId);
  return getEffectiveThinking(tab?.sessionMeta) !== 'off';
}

function clearLivePartialThinking(tabId: string, stdinId?: string) {
  if (stdinId) streamController.clearThinking(stdinId);
  clearPreservedThinkingSnapshot(tabId, stdinId);
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  if (!tab?.partialThinking) return;
  const nextTabs = new Map(store.tabs);
  nextTabs.set(tabId, { ...tab, partialThinking: '' });
  useChatStore.setState({ tabs: nextTabs, sessionCache: nextTabs });
}

function clearLivePartialText(tabId: string, stdinId?: string) {
  if (stdinId) streamController.flush(stdinId);
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  if (!tab?.partialText) return;
  const nextTabs = new Map(store.tabs);
  nextTabs.set(tabId, {
    ...tab,
    partialText: '',
    isStreaming: Boolean(tab.partialThinking),
  });
  useChatStore.setState({ tabs: nextTabs, sessionCache: nextTabs });
}

function preserveLiveThinkingSnapshot(params: {
  tabId: string;
  thinkingPersistence: { id: string; content: string } | null;
  stdinId?: string;
}) {
  const { tabId, thinkingPersistence, stdinId } = params;
  if (!shouldRenderThinkingForTab(tabId)) {
    clearLivePartialThinking(tabId, stdinId);
    return false;
  }
  if (!thinkingPersistence?.content) return false;
  if (stdinId) streamController.clearThinking(stdinId);
  rememberPreservedThinkingSnapshot(tabId, stdinId, thinkingPersistence.content);

  useChatStore.setState((state) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return {};
    const nextThinking = mergeThinkingContent(tab.partialThinking, thinkingPersistence.content);
    if (!nextThinking || nextThinking === tab.partialThinking) return {};
    const nextTabs = new Map(state.tabs);
    nextTabs.set(tabId, {
      ...tab,
      partialThinking: nextThinking,
      isStreaming: true,
      activityStatus:
        tab.activityStatus.phase === 'tool'
          || tab.activityStatus.phase === 'awaiting'
          || tab.activityStatus.phase === 'writing'
          ? tab.activityStatus
          : tab.partialText.length > 0
            ? { phase: 'writing' as const }
            : { phase: 'thinking' as const },
    });
    return { tabs: nextTabs, sessionCache: nextTabs };
  });
  return true;
}

function appendLiveThinkingDelta(tabId: string, delta: string, stdinId?: string) {
  if (!delta) return;
  if (!shouldRenderThinkingForTab(tabId)) {
    clearLivePartialThinking(tabId, stdinId);
    return;
  }
  const currentThinking = useChatStore.getState().getTab(tabId)?.partialThinking ?? '';
  const filtered = filterThinkingDeltaAfterPreservedSnapshot({
    tabId,
    stdinId,
    currentThinking,
    delta,
  });
  if (filtered) useChatStore.getState().updatePartialThinking(tabId, filtered);
}

function commitThinkingAtTurnBoundary(params: {
  tabId: string;
  msgUuid: string | undefined;
  timestamp: number;
  subAgentDepth?: number;
  stdinId?: string;
}) {
  const {
    tabId,
    msgUuid,
    timestamp,
    subAgentDepth,
    stdinId,
  } = params;
  const tab = useChatStore.getState().getTab(tabId);
  const bufferedThinking = stdinId
    ? streamController.peekBufferedThinking(stdinId)
    : undefined;
  const thinkingPersistence = resolveThinkingPersistence(
    msgUuid,
    [],
    tab?.partialThinking,
    bufferedThinking,
  );
  return commitThinkingBeforeAssistantText({
    tabId,
    msgUuid,
    thinkingPersistence,
    timestamp,
    subAgentDepth,
    stdinId,
  });
}

function finalizeBackgroundAssistantStreamingState(params: {
  tabId: string;
  hasTextBlock: boolean;
  hasAskUserQuestion: boolean;
  shouldMaterializeThinking: boolean;
  thinkingPersistence: { id: string; content: string } | null;
  stdinId?: string;
}) {
  const {
    tabId,
    hasTextBlock,
    hasAskUserQuestion,
    shouldMaterializeThinking,
    thinkingPersistence,
    stdinId,
  } = params;
  if (stdinId) {
    if (hasTextBlock) {
      streamController.clearPartial(stdinId);
    } else if (hasAskUserQuestion) {
      streamController.flush(stdinId);
    } else if (shouldMaterializeThinking && thinkingPersistence) {
      streamController.clearThinking(stdinId);
    }
  }
  useChatStore.setState((state) => {
    const latestTab = state.tabs.get(tabId);
    if (!latestTab) return {};

    if (hasTextBlock) {
      const nextTabs = new Map(state.tabs);
      nextTabs.set(tabId, {
        ...latestTab,
        partialText: '',
        partialThinking: '',
        isStreaming: false,
      });
      return { tabs: nextTabs, sessionCache: nextTabs };
    }

    if (hasAskUserQuestion && latestTab.partialText) {
      const nextPartialThinking = shouldMaterializeThinking && thinkingPersistence
        ? ''
        : latestTab.partialThinking;
      const nextTabs = new Map(state.tabs);
      nextTabs.set(tabId, {
        ...latestTab,
        partialText: '',
        partialThinking: nextPartialThinking,
        isStreaming: Boolean(nextPartialThinking),
      });
      return { tabs: nextTabs, sessionCache: nextTabs };
    }

    if (latestTab.partialThinking && shouldMaterializeThinking && thinkingPersistence) {
      const nextTabs = new Map(state.tabs);
      nextTabs.set(tabId, { ...latestTab, partialThinking: '' });
      return { tabs: nextTabs, sessionCache: nextTabs };
    }

    return {};
  });
}

function commitThinkingBeforeAssistantText(params: {
  tabId: string;
  msgUuid: string | undefined;
  thinkingPersistence: { id: string; content: string } | null;
  timestamp: number;
  subAgentDepth?: number;
  stdinId?: string;
}) {
  const {
    tabId,
    msgUuid,
    thinkingPersistence,
    timestamp,
    subAgentDepth,
    stdinId,
  } = params;
  if (!thinkingPersistence) return false;
  if (!shouldRenderThinkingForTab(tabId)) {
    clearLivePartialThinking(tabId, stdinId);
    return false;
  }

  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  if (!tab) return false;

  // Thinking and final text are two views of one logical SDK message. Keep
  // thinking as its own compact, collapsed row, but give it a stable logical
  // id so split/replayed wrappers update that row instead of duplicating it.
  const committedId = buildCommittedThinkingId(msgUuid) ?? thinkingPersistence.id;
  const legacyId = msgUuid ? `${msgUuid}_thinking` : undefined;
  const existingThinking = tab.messages.find((message) =>
    message.type === 'thinking'
      && (message.id === committedId || message.id === legacyId),
  );

  if (existingThinking) {
    if (
      existingThinking.content !== thinkingPersistence.content
      || existingThinking.subAgentDepth !== subAgentDepth
    ) {
      store.updateMessage(tabId, existingThinking.id, {
        content: thinkingPersistence.content,
        ...(subAgentDepth !== undefined ? { subAgentDepth } : {}),
      });
    }
    clearLivePartialThinking(tabId, stdinId);
    return true;
  }

  store.addMessage(tabId, {
    id: committedId,
    role: 'assistant',
    type: 'thinking',
    content: thinkingPersistence.content,
    ...(subAgentDepth !== undefined ? { subAgentDepth } : {}),
    timestamp,
  });
  clearLivePartialThinking(tabId, stdinId);
  return true;
}

function resolveToolResultTargetMessageId(
  messages: ChatMessage[],
  toolUseId: string | undefined,
  toolName: string | undefined,
) {
  if (toolUseId) {
    const directTarget = messages.find((message) => message.id === toolUseId);
    if (directTarget) return directTarget.id;
  }
  if (!toolName) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message.role === 'assistant'
      && message.toolName === toolName
      && message.type !== 'tool_result'
      && !message.toolCompleted
    ) {
      return message.id;
    }
  }
  return undefined;
}

export const __streamThinkingTesting = {
  buildThinkingSnapshot,
  buildCommittedThinkingId,
  logicalAssistantMessageId,
  resolveThinkingPersistence,
  mergeThinkingContent,
  shouldMaterializeThinkingSnapshot,
  isPureThinkingOnlySnapshot,
  shouldCreateStreamingToolPlaceholder,
  clearLivePartialText,
  preserveLiveThinkingSnapshot,
  appendLiveThinkingDelta,
  commitThinkingBeforeAssistantText,
  commitThinkingAtTurnBoundary,
  finalizeBackgroundAssistantStreamingState,
};

export const __streamRetryTesting = {
  recordApiRetry,
  shouldClearApiRetryForEvent,
};

export const __streamAgentTeamsTesting = {
  agentToolIdentity,
  backgroundAgentNode,
  parseAsyncAgentLaunch,
  parseAgentTaskNotification,
  sanitizeToolResultContent: sanitizeToolResultForDisplay,
};

// --- File tree auto-refresh on file-mutating tool completions ---
// Tools that may create/modify/delete files in the working directory.
const FILE_MUTATING_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'Bash', 'BatchTool',
]);

// Debounce tree refresh to batch rapid tool completions (e.g. parallel agents).
let _fileRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleFileTreeRefresh() {
  const settings = useSettingsStore.getState();
  if (
    settings.mainView !== 'chat'
    || !settings.secondaryPanelOpen
    || settings.secondaryPanelTab !== 'files'
  ) return;
  if (_fileRefreshTimer) return; // already scheduled
  _fileRefreshTimer = setTimeout(() => {
    _fileRefreshTimer = null;
    useFileStore.getState().refreshTree();
  }, 300);
}

/**
 * If the tool_result's parent tool_use was a file-mutating tool,
 * schedule a debounced file tree refresh.
 */
function _maybeRefreshFileTree(tabId: string, toolUseId?: string, toolName?: string) {
  // Fast path: tool_name available directly on the message
  if (toolName && FILE_MUTATING_TOOLS.has(toolName)) {
    _scheduleFileTreeRefresh();
    return;
  }
  // Fallback: look up parent tool_use message
  if (toolUseId) {
    const messages = useChatStore.getState().getTab(tabId)?.messages ?? [];
    const parent = messages.find((m) => m.id === toolUseId);
    if (parent?.toolName && FILE_MUTATING_TOOLS.has(parent.toolName)) {
      _scheduleFileTreeRefresh();
    }
  }
}

function isAssistantResumeEvidenceEvent(msg: any): boolean {
  if (msg.type === 'assistant' || msg.type === 'content_block_delta') return true;
  if (msg.type !== 'stream_event') return false;
  const evtType = msg.event?.type;
  return evtType === 'message_start'
    || evtType === 'message_delta'
    || evtType === 'content_block_start'
    || evtType === 'content_block_delta'
    || evtType === 'content_block_stop';
}

function shouldClearApiRetryForEvent(msg: any): boolean {
  if (msg.type === 'system') {
    return msg.subtype === 'init' || msg.subtype === 'error';
  }
  if (msg.type === 'stream_event') {
    const evtType = msg.event?.type;
    return evtType === 'message_start'
      || evtType === 'message_delta'
      || evtType === 'content_block_start'
      || evtType === 'content_block_delta'
      || evtType === 'content_block_stop';
  }
  return msg.type === 'assistant'
    || msg.type === 'content_block_delta'
    || msg.type === 'result'
    || msg.type === 'process_exit'
    || msg.type === 'blackbox_permission_request'
    || msg.type === 'tool_result';
}

/**
 * Claude Code publishes the authoritative slash-command and skill inventory in
 * `system:init`, then may replace it with `commands_changed`. Keep the UI
 * catalogue tied to that live runtime instead of a compiled command allowlist.
 */
function recordRuntimeCommandInventory(msg: any, sessionCwd?: string): void {
  const state = useCommandStore.getState();
  const rawCwd = typeof msg.cwd === 'string' ? msg.cwd : sessionCwd || state.activeCwd;
  const cwd = rawCwd === '/' ? rawCwd : rawCwd.replace(/\/+$/, '');
  const inventory = runtimeInventoryFromMessage(
    msg,
    cwd,
    state.runtimeByCwd[cwd],
  );
  if (inventory) state.recordRuntimeInventory(inventory);
}

function recordApiRetry(tabId: string, msg: any): void {
  useChatStore.getState().setSessionMeta(tabId, {
    apiRetry: buildApiRetryStatus(msg),
    lastProgressAt: Date.now(),
  });
}

/**
 * Configuration refs and callbacks that the stream processor needs
 * from the parent InputBar component.
 */
export interface StreamProcessorConfig {
  exitPlanModeSeenRef: MutableRefObject<boolean>;
  silentRestartRef: MutableRefObject<boolean>;
  handleSubmitRef: MutableRefObject<() => void>;
  handleStderrLineRef: MutableRefObject<(line: string, sid: string) => void>;
  /** Last stderr error line — displayed to user if process exits without response */
  lastStderrRef: MutableRefObject<string>;
  setInputSync: (text: string) => void;
}

/**
 * useStreamProcessor — extracts stream message handling from InputBar.
 *
 * Returns handleStreamMessage (foreground) and handleBackgroundStreamMessage
 * (background tab routing) as stable callbacks.
 */
export function useStreamProcessor(config: StreamProcessorConfig) {
  const {
    exitPlanModeSeenRef,
    silentRestartRef,
    handleSubmitRef,
    handleStderrLineRef,
    lastStderrRef,
    setInputSync,
  } = config;
  const lastProgressWriteRef = useRef<Record<string, number>>({});

  const markStreamProgress = useCallback((tabId: string, msg: any) => {
    const isHighFrequencyDelta =
      (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta')
      || msg.type === 'content_block_delta';
    const now = Date.now();
    const last = lastProgressWriteRef.current[tabId] ?? 0;
    const tab = useChatStore.getState().getTab(tabId);
    const shouldClearApiRetry = shouldClearApiRetryForEvent(msg);
    if (isHighFrequencyDelta && now - last < 250 && !(shouldClearApiRetry && tab?.sessionMeta.apiRetry)) return;
    lastProgressWriteRef.current[tabId] = now;
    const shouldClearTurnMeta = msg.type !== 'system'
      && msg.type !== 'process_exit'
      && tab?.sessionStatus !== 'stopping';
    const hasResumeEvidence = isAssistantResumeEvidenceEvent(msg);

    useChatStore.getState().setSessionMeta(tabId, {
      lastProgressAt: now,
      ...(hasResumeEvidence ? { turnAcceptedForResume: true } : {}),
      ...(shouldClearApiRetry ? { apiRetry: undefined } : {}),
      ...(shouldClearTurnMeta
        ? {
          pendingTurnMessageId: undefined,
          pendingTurnInput: undefined,
          pendingTurnAttachments: undefined,
          interruptedAssistantText: undefined,
        }
        : {}),
    });
  }, []);

  /**
   * Handle stream messages for a background (non-active) tab — route to cache.
   */
  const handleBackgroundStreamMessage = useCallback((msg: any, tabId: string) => {
    const store = useChatStore.getState();

    // Ownership guard: reject stale messages from old processes (F5 fix).
    if (msg.__stdinId) {
      const bgTab = store.getTab(tabId);
      if (bgTab?.sessionMeta.stdinId && bgTab.sessionMeta.stdinId !== msg.__stdinId) {
        return; // stale message — discard
      }
    }

    // Update progress for stall detection without writing Zustand state for every token.
    markStreamProgress(tabId, msg);
    useWorkflowStore.getState().applyStreamEvent(tabId, msg);

    switch (msg.type) {
      case 'blackbox_control_request_cancelled': {
        expireSdkControlRequest(tabId, msg);
        return;
      }
      case 'blackbox_permission_request': {
        // ExitPlanMode: auto-approve in non-plan modes; add plan_review card in plan mode
        if (msg.tool_name === 'ExitPlanMode') {
          const bgMeta = store.getTab(tabId)?.sessionMeta;
          if (getEffectiveMode(bgMeta) !== 'plan') {
            const stdinId = msg.__stdinId;
            if (stdinId) {
              bridge.respondPermission(stdinId, msg.request_id, true, undefined, msg.tool_use_id, msg.input);
            }
            return;
          }
          const bgTab = store.getTab(tabId);
          const bgExisting = bgTab?.messages.find((m) => m.id === 'plan_review_current' && !m.resolved);
          if (!bgExisting) {
            let bgPlanContent = '';
            if (bgTab) {
              for (let i = bgTab.messages.length - 1; i >= 0; i--) {
                if (bgTab.messages[i].role === 'assistant' && bgTab.messages[i].type === 'text' && bgTab.messages[i].content) {
                  bgPlanContent = bgTab.messages[i].content;
                  break;
                }
              }
            }
            store.addMessage(tabId, {
              id: 'plan_review_current',
              role: 'assistant', type: 'plan_review',
              content: bgPlanContent, planContent: bgPlanContent,
              resolved: false, timestamp: Date.now(),
              permissionData: {
                requestId: msg.request_id,
                toolName: msg.tool_name,
                input: msg.input,
                toolUseId: msg.tool_use_id,
              },
            });
          } else {
            store.updateMessage(tabId, 'plan_review_current', {
              permissionData: {
                requestId: msg.request_id,
                toolName: msg.tool_name,
                input: msg.input,
                toolUseId: msg.tool_use_id,
              },
            });
          }
          store.setActivityStatus(tabId, { phase: 'awaiting' });
          return;
        }
        // AskUserQuestion: add question card to tab
        if (msg.tool_name === 'AskUserQuestion') {
          const bgTab = store.getTab(tabId);
          const questionId = msg.tool_use_id || 'ask_question_current';
          const existing = bgTab?.messages.find((m) => m.id === questionId && m.type === 'question')
            || bgTab?.messages.find((m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion');
          const ownerStdinId = (msg.__stdinId as string | undefined)
            ?? bgTab?.sessionMeta.stdinId;
          clearLivePartialText(tabId, ownerStdinId);
          if (existing) {
            store.updateMessage(tabId, existing.id, {
              permissionData: {
                requestId: msg.request_id,
                toolName: msg.tool_name,
                input: msg.input,
                toolUseId: msg.tool_use_id,
              },
              toolInput: msg.input,
              owner: existing.owner
                ?? (ownerStdinId ? { tabId, stdinId: ownerStdinId } : undefined),
            });
            return;
          }
          const questions = msg.input?.questions;
          store.addMessage(tabId, {
            id: questionId,
            role: 'assistant', type: 'question',
            content: '', toolName: 'AskUserQuestion',
            toolInput: msg.input,
            questions: Array.isArray(questions) ? questions : [],
            resolved: false, timestamp: Date.now(),
            permissionData: {
              requestId: msg.request_id,
              toolName: msg.tool_name,
              input: msg.input,
              toolUseId: msg.tool_use_id,
            },
            owner: ownerStdinId ? { tabId, stdinId: ownerStdinId } : undefined,
          });
          store.setActivityStatus(tabId, { phase: 'awaiting' });
          return;
        }
        // Regular permission: exact rules approved for this same live stdin can
        // continue without another card. Manual mode still asks for every
        // unrelated rule.
        const bgTab = store.getTab(tabId);
        const ownerStdinId = (msg.__stdinId as string | undefined)
          ?? bgTab?.sessionMeta.stdinId;
        if (autoAllowRegisteredSessionPermission(tabId, msg, ownerStdinId)) return;
        addRegularPermissionCard(tabId, msg, ownerStdinId);
        break;
      }
      case 'stream_event': {
        const evt = msg.event;
        if (!evt) break;
        const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
        const bgAgentId = resolveAgentId(msg.parent_tool_use_id, bgAgents);
        const bgForwardedSubagentEvent = isForwardedSubagentEvent(msg);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          if (text) {
            if (bgForwardedSubagentEvent) {
              appendCachedAgentActivity(tabId, bgAgentId, {
                kind: 'text',
                content: text,
                append: true,
              });
            } else {
              store.updatePartialMessage(tabId, text);
            }
            updateCachedAgentPhase(tabId, bgAgentId, 'writing');
          }
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          // F1 (#57): background tabs must handle thinking_delta too,
          // otherwise thinking content is silently lost on tab switch.
          const thinking = evt.delta.thinking || '';
          if (bgForwardedSubagentEvent) {
            updateCachedAgentPhase(tabId, bgAgentId, 'thinking');
          } else if (shouldRenderThinkingForTab(tabId)) {
            appendLiveThinkingDelta(tabId, thinking, msg.__stdinId as string | undefined);
          } else if (msg.__stdinId) {
            streamController.clearThinking(msg.__stdinId as string);
          }
        }
        if (
          bgForwardedSubagentEvent
          && evt.type === 'content_block_start'
          && evt.content_block?.type === 'tool_use'
        ) {
          appendCachedAgentActivity(tabId, bgAgentId, {
            kind: 'tool',
            content: evt.content_block.name || 'Tool',
            toolName: evt.content_block.name,
          });
          updateCachedAgentPhase(tabId, bgAgentId, 'tool', evt.content_block.name);
        }
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'Task' || evt.content_block?.name === 'Agent')) {
          const identity = agentToolIdentity(evt.content_block);
          upsertCachedAgent(tabId, {
            id: evt.content_block.id || `task_${Date.now()}`,
            parentId: bgAgentId,
            description: identity.description,
            phase: 'spawning',
            startTime: Date.now(),
            isMain: false,
            kind: identity.kind,
            name: identity.name,
            model: identity.model,
          });
        }
        // Early detection: create plan_review card for background tab (Plan mode only).
        // Bypass auto-approves via Rust backend — no UI card needed.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && evt.content_block?.name === 'ExitPlanMode'
            && !bgForwardedSubagentEvent
            && getEffectiveMode(store.getTab(tabId)?.sessionMeta) === 'plan') {
          const bgTab = store.getTab(tabId);
          const bgExisting = bgTab?.messages.find((m) => m.id === 'plan_review_current');
          if (!bgExisting || !bgExisting.resolved) {
            let bgPlanContent = '';
            if (bgTab) {
              for (let i = bgTab.messages.length - 1; i >= 0; i--) {
                const m = bgTab.messages[i];
                if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                  bgPlanContent = m.toolInput.content;
                  break;
                }
              }
            }
            store.addMessage(tabId, {
              id: 'plan_review_current',
              role: 'assistant', type: 'plan_review',
              content: bgPlanContent, planContent: bgPlanContent,
              resolved: false, timestamp: Date.now(),
            });
            store.setActivityStatus(tabId, { phase: 'awaiting' });
          }
        }
        // Track tokens in background sessions (per-turn + cumulative total)
        if (evt.type === 'message_start' && evt.message?.usage?.input_tokens) {
          const bgTab = store.getTab(tabId);
          const delta = evt.message.usage.input_tokens;
          store.setSessionMeta(tabId, {
            inputTokens: (bgTab?.sessionMeta.inputTokens || 0) + delta,
            totalInputTokens: (bgTab?.sessionMeta.totalInputTokens || 0) + delta,
          });
        }
        if (evt.type === 'message_delta' && evt.usage?.output_tokens) {
          const bgTab = store.getTab(tabId);
          const delta = evt.usage.output_tokens;
          store.setSessionMeta(tabId, {
            outputTokens: (bgTab?.sessionMeta.outputTokens || 0) + delta,
            totalOutputTokens: (bgTab?.sessionMeta.totalOutputTokens || 0) + delta,
          });
        }
        break;
      }
      case 'assistant': {
        // Clear pending command on assistant event (same as foreground)
        completePendingCommand(tabId);
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        const bgAssistantMessageId = logicalAssistantMessageId(msg);
        // Selectively clear partial in tab — only wipe partialText if a text
        // block is present (which supersedes streaming text). Otherwise, preserve
        // it to avoid intermediate thinking-only messages destroying streaming text.
        const bgHasTextBlock = content.some((b: any) => b.type === 'text' && b.text);
        const bgHasAskUserQuestion = content.some(
          (b: any) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
        );
        const bgShouldRenderThinking = shouldRenderThinkingForTab(tabId);
        const bgIsPureThinkingOnly = bgShouldRenderThinking && isPureThinkingOnlySnapshot(content);
        const bgShouldMaterializeThinking = bgShouldRenderThinking
          && shouldMaterializeThinkingSnapshot(content, bgHasTextBlock);
        const bgTab = store.getTab(tabId);
        const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
        const bgAgentId = resolveAgentId(msg.parent_tool_use_id, bgAgents);
        const bgAgentDepth = getAgentDepth(bgAgentId, bgAgents);
        const bgStdinId = msg.__stdinId as string | undefined;
        if (isForwardedSubagentEvent(msg)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              const safeText = sanitizeAssistantTextForDisplay(block.text).trim();
              if (safeText) {
                appendCachedAgentActivity(tabId, bgAgentId, {
                  kind: 'text',
                  content: safeText,
                });
                updateCachedAgentPhase(tabId, bgAgentId, 'writing');
              }
            } else if (block.type === 'tool_use') {
              appendCachedAgentActivity(tabId, bgAgentId, {
                kind: 'tool',
                content: block.name || 'Tool',
                toolName: block.name,
              });
              if (block.name === 'Agent' || block.name === 'Task') {
                const identity = agentToolIdentity(block);
                upsertCachedAgent(tabId, {
                  id: block.id || generateMessageId(),
                  parentId: bgAgentId,
                  description: identity.description,
                  phase: 'spawning',
                  startTime: Date.now(),
                  isMain: false,
                  kind: identity.kind,
                  name: identity.name,
                  model: identity.model,
                });
              } else {
                updateCachedAgentPhase(tabId, bgAgentId, 'tool', block.name);
              }
            } else if (block.type === 'thinking') {
              updateCachedAgentPhase(tabId, bgAgentId, 'thinking');
            }
          }
          // Forwarded subagent frames are projected only into Agent activity.
          // The lead conversation waits for the main agent's synthesis.
          break;
        }
        store.setSessionMeta(tabId, {
          awaitingVisibleAssistantResponse:
            !assistantContentHasVisibleTerminalResponse(content),
        });
        const bgBufferedThinking = bgStdinId
          ? streamController.peekBufferedThinking(bgStdinId)
          : undefined;
        const bgThinkingPersistence = bgShouldRenderThinking
          ? resolveThinkingPersistence(
            bgAssistantMessageId,
            content,
            bgTab?.partialThinking,
            bgBufferedThinking,
          )
          : null;
        if (!bgShouldMaterializeThinking && bgIsPureThinkingOnly && bgThinkingPersistence) {
          preserveLiveThinkingSnapshot({
            tabId,
            thinkingPersistence: bgThinkingPersistence,
            stdinId: bgStdinId,
          });
        }
        let bgThinkingMessageEmitted = bgHasTextBlock
          ? commitThinkingBeforeAssistantText({
            tabId,
            msgUuid: bgAssistantMessageId,
            thinkingPersistence: bgThinkingPersistence,
            timestamp: Date.now(),
            stdinId: bgStdinId,
          })
          : false;
        finalizeBackgroundAssistantStreamingState({
          tabId,
          hasTextBlock: bgHasTextBlock,
          hasAskUserQuestion: bgHasAskUserQuestion,
          shouldMaterializeThinking: bgShouldMaterializeThinking,
          thinkingPersistence: bgThinkingPersistence,
          stdinId: bgStdinId,
        });
        // Skip text blocks when AskUserQuestion is present — the
        // interactive question UI makes them redundant.
        for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
          const block = content[blockIdx];
          if (block.type === 'text') {
            const displayText = sanitizeAssistantTextForDisplay(block.text);
            if (
              bgHasAskUserQuestion
              || isCliPlaceholder(block.text)
              || shouldHoldPotentialContextDropGreeting(tabId, block.text)
              || !displayText.trim()
            ) continue;
            const textId = bgAssistantMessageId
              ? `${bgAssistantMessageId}_text_${blockIdx}`
              : generateMessageId();
            store.addMessage(tabId, {
              id: textId,
              role: 'assistant', type: 'text',
              content: displayText,
              isFinalResponse: msg.message?.stop_reason === 'end_turn',
              subAgentDepth: bgAgentDepth,
              timestamp: Date.now(),
            });
            updateCachedAgentPhase(tabId, bgAgentId, 'writing');
          } else if (block.type === 'tool_use') {
            // Code mode: suppress EnterPlanMode/ExitPlanMode (transparent to user)
            if (getEffectiveMode(store.getTab(tabId)?.sessionMeta) === 'code'
                && (block.name === 'EnterPlanMode' || block.name === 'ExitPlanMode')) {
              if (block.name === 'ExitPlanMode') exitPlanModeSeenRef.current = true;
              continue;
            }
            if (block.name === 'Agent' || block.name === 'Task') {
              const identity = agentToolIdentity(block);
              upsertCachedAgent(tabId, {
                id: block.id || generateMessageId(),
                parentId: bgAgentId,
                description: identity.description,
                phase: 'spawning',
                startTime: Date.now(),
                isMain: false,
                kind: identity.kind,
                name: identity.name,
                model: identity.model,
              });
            } else {
              updateCachedAgentPhase(tabId, bgAgentId, 'tool', block.name);
              if (block.name === 'TaskCreate' && block.id) {
                registerCachedTeamTask(tabId, block.id, block.input || {});
              } else if (block.name === 'TaskUpdate') {
                updateCachedTeamTask(tabId, block.input || {});
              }
            }
            if (
              bgAgentDepth === 0
              && !msg.parent_tool_use_id
              && (block.name === 'TaskCreate' || block.name === 'TaskUpdate')
            ) {
              const tasks = useAgentStore.getState().teamTaskCache.get(tabId) ?? new Map();
              try {
                syncNativeTaskPlan(tabId, tasks.values());
              } catch (error) {
                console.warn('[BLACKBOX Plan] Ignored invalid native Task state:', error);
              }
            }
            if (block.name === 'AskUserQuestion') {
              const questions = block.input?.questions;
              const bgQuestionId = block.id || generateMessageId();
              // Guard: skip if question already exists in background tab (resolved or not)
              const bgSnap = store.getTab(tabId);
              const bgExisting = bgSnap?.messages.find(
                (m) => m.id === bgQuestionId && m.type === 'question',
              );
              if (bgExisting) break;

              const bgOwnerStdinId = (msg.__stdinId as string | undefined)
                ?? bgSnap?.sessionMeta.stdinId;
              store.addMessage(tabId, {
                id: bgQuestionId,
                role: 'assistant', type: 'question',
                content: '', toolName: block.name,
                toolInput: block.input,
                questions: Array.isArray(questions) ? questions : [],
                resolved: false, subAgentDepth: bgAgentDepth, timestamp: Date.now(),
                owner: bgOwnerStdinId ? { tabId, stdinId: bgOwnerStdinId } : undefined,
              });
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              if (bgAgentDepth === 0 && !msg.parent_tool_use_id) {
                try {
                  usePlanStore.getState().setPlan(tabId, block.input.todos, undefined, 'todo');
                } catch (error) {
                  console.warn('[BLACKBOX Plan] Ignored invalid TodoWrite plan:', error);
                }
              }
              store.addMessage(tabId, {
                id: block.id || generateMessageId(),
                role: 'assistant', type: 'todo',
                content: '', toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                subAgentDepth: bgAgentDepth, timestamp: Date.now(),
              });
            } else if (block.name === 'ExitPlanMode') {
              // Show as regular tool_use in plan/bypass modes
              store.addMessage(tabId, {
                id: block.id || generateMessageId(),
                role: 'assistant', type: 'tool_use',
                content: '', toolName: block.name,
                toolInput: block.input, subAgentDepth: bgAgentDepth, timestamp: Date.now(),
              });
              // Only create plan_review card in Plan mode.
              // Bypass auto-approves via Rust backend — no UI card needed.
              if (getEffectiveMode(store.getTab(tabId)?.sessionMeta) === 'plan') {
                const bgSnap2 = store.getTab(tabId);
                let bgPlanContent = '';
                if (bgSnap2) {
                  for (let i = bgSnap2.messages.length - 1; i >= 0; i--) {
                    const m = bgSnap2.messages[i];
                    if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                      bgPlanContent = m.toolInput.content;
                      break;
                    }
                  }
                }
                const bgToolExists = block.id && bgSnap2?.messages.some(
                  (m) => m.id === block.id && m.toolName === 'ExitPlanMode',
                );
                const bgResolvedReview = bgSnap2?.messages.find(
                  (m) => m.type === 'plan_review' && m.resolved,
                );
                if (!(bgToolExists && bgResolvedReview)) {
                  store.addMessage(tabId, {
                    id: 'plan_review_current',
                    role: 'assistant', type: 'plan_review',
                    content: bgPlanContent, planContent: bgPlanContent,
                    resolved: false, timestamp: Date.now(),
                  });
                  store.setActivityStatus(tabId, { phase: 'awaiting' });
                }
              }
            } else {
              store.addMessage(tabId, {
                id: block.id || generateMessageId(),
                role: 'assistant', type: 'tool_use',
                content: '', toolName: block.name,
                toolInput: block.input, subAgentDepth: bgAgentDepth, timestamp: Date.now(),
              });
            }
          } else if (block.type === 'thinking') {
            if (!bgShouldRenderThinking) continue;
            if (bgThinkingMessageEmitted) continue;
            store.setActivityStatus(tabId, { phase: 'thinking' });
            if (bgShouldMaterializeThinking && bgThinkingPersistence) {
              bgThinkingMessageEmitted = commitThinkingBeforeAssistantText({
                tabId,
                msgUuid: bgAssistantMessageId,
                thinkingPersistence: bgThinkingPersistence,
                timestamp: Date.now(),
                stdinId: bgStdinId,
              });
            }
          }
        }
        if (bgShouldMaterializeThinking && bgThinkingPersistence && !bgThinkingMessageEmitted) {
          commitThinkingBeforeAssistantText({
            tabId,
            msgUuid: bgAssistantMessageId,
            thinkingPersistence: bgThinkingPersistence,
            timestamp: Date.now(),
            stdinId: bgStdinId,
          });
        }
        break;
      }
      case 'user':
      case 'human': {
        const bgLaunch = parseAsyncAgentLaunch(msg);
        if (bgLaunch) {
          const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
          upsertCachedAgent(tabId, backgroundAgentNode(bgLaunch, bgAgents));
        }
        const bgNotification = parseAgentTaskNotification(messageTextContent(msg));
        if (bgNotification) {
          const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
          const bgEventAgentId = resolveAgentEventId(
            bgNotification.toolUseId,
            bgNotification.taskId,
            bgAgents,
          );
          if (bgEventAgentId) {
            const safeResult = bgNotification.resultText
              ? sanitizeAssistantTextForDisplay(bgNotification.resultText).trim()
              : '';
            if (safeResult) {
              appendCachedAgentActivity(tabId, bgEventAgentId, {
                kind: 'text',
                content: safeResult,
              });
            }
            settleCachedAgent(
              tabId,
              bgEventAgentId,
              isFailedAgentTaskStatus(bgNotification.status),
            );
          }
        }
        const userContent = msg.message?.content;
        if (Array.isArray(userContent)) {
          if (
            !isForwardedSubagentEvent(msg)
            && userContent.some((block: any) => block.type === 'tool_result')
          ) {
            store.setSessionMeta(tabId, { awaitingVisibleAssistantResponse: true });
          }
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              const resultText = Array.isArray(block.content)
                ? block.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
                : typeof block.content === 'string' ? block.content : '';
              const targetId = resolveToolResultTargetMessageId(
                store.getTab(tabId)?.messages ?? [],
                block.tool_use_id,
                undefined,
              );
              if (targetId) {
                const parentMsg = store.getTab(tabId)?.messages.find((m) => m.id === targetId);
                if (parentMsg?.toolName === 'TaskCreate') {
                  resolveCachedTeamTask(tabId, block.tool_use_id, resultText);
                }
                recordNativeLoopReceipt(tabId, parentMsg, resultText);
                const safeResult = sanitizeToolResultForDisplay(parentMsg?.toolName, resultText);
                store.updateMessage(tabId, targetId, {
                  toolCompleted: true,
                  ...(safeResult ? { toolResultContent: safeResult } : {}),
                });
              }
            }
          }
        }
        break;
      }
      case 'tool_result': {
        if (!isForwardedSubagentEvent(msg)) {
          store.setSessionMeta(tabId, { awaitingVisibleAssistantResponse: true });
        }
        const resultContent = Array.isArray(msg.content)
          ? msg.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
          : typeof msg.content === 'string' ? msg.content : msg.output || '';
        const targetId = resolveToolResultTargetMessageId(
          store.getTab(tabId)?.messages ?? [],
          msg.tool_use_id,
          msg.tool_name,
        );
        if (targetId) {
          // Backfill AskUserQuestion type/questions in background tab
          const bgTab = store.getTab(tabId);
          const parentMsg = bgTab?.messages.find((m) => m.id === targetId);
          if (parentMsg?.toolName === 'TaskCreate') {
            resolveCachedTeamTask(tabId, msg.tool_use_id, resultContent);
          }
          recordNativeLoopReceipt(tabId, parentMsg, resultContent, msg.tool_name);
          const safeResult = sanitizeToolResultForDisplay(parentMsg?.toolName ?? msg.tool_name, resultContent);
          const bgUpdates: Partial<ChatMessage> = {
            toolCompleted: true,
            ...(safeResult ? { toolResultContent: safeResult } : {}),
          };
          if (parentMsg?.toolName === 'AskUserQuestion') {
            if (parentMsg.type !== 'question') {
              bgUpdates.type = 'question';
              bgUpdates.resolved = false;
            }
            if (!parentMsg.questions || parentMsg.questions.length === 0) {
              const qs = parentMsg.toolInput?.questions;
              if (Array.isArray(qs) && qs.length > 0) {
                bgUpdates.questions = qs;
              }
            }
          }
          store.updateMessage(tabId, targetId, bgUpdates);
          // Auto-refresh file tree when file-mutating tools complete
          _maybeRefreshFileTree(tabId, targetId, msg.tool_name);
        }
        break;
      }
      case 'result': {
        if (msg.parent_tool_use_id) {
          const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
          const bgResultAgentId = resolveAgentId(msg.parent_tool_use_id, bgAgents);
          const safeResult = typeof msg.result === 'string'
            ? sanitizeAssistantTextForDisplay(msg.result).trim()
            : '';
          if (safeResult && !isCliPlaceholder(safeResult)) {
            appendCachedAgentActivity(tabId, bgResultAgentId, {
              kind: 'text',
              content: safeResult,
            });
          }
          settleCachedAgent(
            tabId,
            bgResultAgentId,
            msg.subtype !== 'success',
          );
          break;
        }
        // Capture stopping state BEFORE status update — needed for drain guard below
        const bgWasStopping = store.getTab(tabId)?.sessionStatus === 'stopping';
        const bgResultTab = store.getTab(tabId);
        const bgResultStdinId = (msg.__stdinId as string | undefined)
          ?? bgResultTab?.sessionMeta.stdinId;
        const bgFinalizedRoute = bgResultStdinId ? getRecentlyFinalizedStdin(bgResultStdinId) : undefined;
        const bgIsUserStopResult = msg.subtype !== 'success'
          && (
            bgWasStopping
            || bgResultTab?.sessionMeta.teardownReason === 'stop'
            || bgFinalizedRoute?.reason === 'stop'
            || msg.subtype === 'user_abort'
          );

        if (bgIsUserStopResult) {
          if (bgResultStdinId && bgWasStopping) {
            handleProcessExitFinalize(bgResultStdinId);
          } else {
            store.setSessionStatus(tabId, 'stopped');
            store.setSessionMeta(tabId, {
              stdinReady: false,
              pendingReadyMessage: undefined,
              turnStartTime: undefined,
              lastProgressAt: undefined,
              apiRetry: undefined,
              activeTurnInput: undefined,
              contextRecoveryAttempts: undefined,
              awaitingVisibleAssistantResponse: undefined,
              emptyTerminalRecoveryAfterCompact: undefined,
            });
          }
          useSessionStore.getState().fetchSessions();
          break;
        }

        commitThinkingAtTurnBoundary({
          tabId,
          msgUuid: logicalAssistantMessageId(msg),
          timestamp: Date.now(),
          stdinId: bgResultStdinId,
        });

        const bgResultDisplayText = typeof msg.result === 'string'
          ? sanitizeAssistantTextForDisplay(msg.result)
          : typeof msg.content === 'string'
            ? sanitizeAssistantTextForDisplay(msg.content)
            : '';
        const bgRecoveryMeta = store.getTab(tabId)?.sessionMeta;
        if (
          bgResultStdinId
          && shouldRetryContextDrop({
            prompt: bgRecoveryMeta?.activeTurnInput,
            response: bgResultDisplayText,
            usage: msg.usage,
            subtype: msg.subtype,
            attempts: bgRecoveryMeta?.contextRecoveryAttempts,
          })
        ) {
          const bgMessages = store.getTab(tabId)?.messages ?? [];
          const greeting = [...bgMessages].reverse().find(
            (message) => message.role === 'assistant'
              && message.type === 'text'
              && isGenericContextGreeting(message.content),
          );
          if (greeting) store.removeMessage(tabId, greeting.id);
          const retryPrompt = bgRecoveryMeta!.activeTurnInput!;
          const retryStartedAt = Date.now();
          store.setSessionStatus(tabId, 'running');
          store.setActivityStatus(tabId, { phase: 'thinking' });
          store.setSessionMeta(tabId, {
            contextRecoveryAttempts: (bgRecoveryMeta?.contextRecoveryAttempts ?? 0) + 1,
            awaitingVisibleAssistantResponse: true,
            emptyTerminalRecoveryAfterCompact: false,
            turnStartTime: retryStartedAt,
            lastProgressAt: retryStartedAt,
            inputTokens: 0,
            outputTokens: 0,
            apiRetry: undefined,
          });
          console.warn('[BLACKBOX] Tiny zero-cache greeting detected; retrying the active turn once');
          bridge.sendStdin(bgResultStdinId, retryPrompt).catch((error) => {
            console.error('[BLACKBOX] Context-drop recovery retry failed:', error);
            const draft = store.getTab(tabId)?.inputDraft.trim() || '';
            store.setInputDraft(tabId, draft ? `${draft}\n\n${retryPrompt}` : retryPrompt);
            store.setSessionMeta(tabId, {
              activeTurnInput: undefined,
              contextRecoveryAttempts: undefined,
              awaitingVisibleAssistantResponse: undefined,
              emptyTerminalRecoveryAfterCompact: undefined,
            });
            store.setSessionStatus(tabId, 'error');
            store.addMessage(tabId, {
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: '检测到会话上下文未载入，自动重试失败。原消息已放回输入框。',
              commandType: 'error',
              timestamp: Date.now(),
            });
          });
          break;
        }

        if (handleEmptyTerminalRecoveryResult({
          tabId,
          stdinId: bgResultStdinId,
          subtype: msg.subtype,
          resultDisplayText: bgResultDisplayText,
          usage: msg.usage,
        })) {
          break;
        }

        // Clear pending command on result (e.g. /compact completing on background tab)
        completePendingCommand(tabId, {
          costSummary: msg.total_cost_usd != null ? {
            cost: `$${msg.total_cost_usd?.toFixed(4) || '0'}`,
            duration: msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '',
            turns: msg.num_turns ?? '',
            input: msg.usage?.input_tokens?.toLocaleString() ?? '',
            output: msg.usage?.output_tokens?.toLocaleString() ?? '',
          } : undefined,
        });
        store.setSessionStatus(tabId, msg.subtype === 'success' ? 'completed' : 'error');
        settleCachedTurn(
          tabId,
          msg.subtype !== 'success',
          msg.subtype === 'success' && useSettingsStore.getState().agentTeamsEnabled,
          msg.subtype === 'success',
        );
        {
          const bgTab = store.getTab(tabId);
          const prevMeta = bgTab?.sessionMeta;
          const resultInput = msg.usage?.input_tokens || 0;
          const resultOutput = msg.usage?.output_tokens || 0;
          const streamedInput = prevMeta?.inputTokens || 0;
          const streamedOutput = prevMeta?.outputTokens || 0;
          store.setSessionMeta(tabId, {
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            turns: msg.num_turns,
            inputTokens: resultInput,
            outputTokens: resultOutput,
            totalInputTokens: (prevMeta?.totalInputTokens || 0) + (resultInput - streamedInput),
            totalOutputTokens: (prevMeta?.totalOutputTokens || 0) + (resultOutput - streamedOutput),
            turnStartTime: undefined,
            lastProgressAt: undefined,
            apiRetry: undefined,
            activeTurnInput: undefined,
            contextRecoveryAttempts: undefined,
            awaitingVisibleAssistantResponse: undefined,
            emptyTerminalRecoveryAfterCompact: undefined,
          });
        }
        if (bgResultDisplayText && !isCliPlaceholder(bgResultDisplayText)) {
          // Only add if not already delivered via 'assistant' event
          const bgTab = store.getTab(tabId);
          const bgIsDuplicate = bgTab?.messages.some(
            (m) => m.role === 'assistant' && m.type === 'text'
              && m.content === bgResultDisplayText,
          );
          if (!bgIsDuplicate) {
            store.addMessage(tabId, {
              id: msg.uuid || generateMessageId(),
              role: 'assistant', type: 'text',
              content: bgResultDisplayText,
              isFinalResponse: true,
              timestamp: Date.now(),
            });
          }
        }
        // Auto-compact must outrank pending follow-ups on background tabs just
        // as it does on the foreground path. The compact result will re-enter
        // this handler and only then drain the next queued stage.
        let bgAutoCompactTriggered = false;
        {
          const bgCompactTab = store.getTab(tabId);
          const bgResultInputTokens = effectiveContextInputTokens(msg.usage);
          const bgCompactStdinId = bgCompactTab?.sessionMeta.stdinId;
          const bgCompactThreshold = getAutoCompactThreshold(bgCompactTab?.sessionMeta.spawnedModel);
          if (bgResultInputTokens > bgCompactThreshold && !hasAutoCompactFired(tabId) && bgCompactStdinId && msg.subtype === 'success') {
            bgAutoCompactTriggered = true;
            markAutoCompactFired(tabId);
            console.log('[BLACKBOX] Background tab auto-compact triggered:', tabId, 'inputTokens =', bgResultInputTokens);
            const queuedCompact = bgCompactTab?.pendingUserMessages.find(
              (item) => item.kind === 'command' && item.text.trim().toLowerCase() === '/compact',
            );
            const bgCompactMsgId = queuedCompact?.commandMessageId || generateMessageId();
            if (queuedCompact?.commandMessageId) {
              store.removePendingCommand(tabId, queuedCompact.commandMessageId);
            }
            const bgCompactStartedAt = Date.now();
            if (queuedCompact?.commandMessageId) {
              const existing = store.getTab(tabId)?.messages.find(
                (message) => message.id === bgCompactMsgId,
              );
              store.updateMessage(tabId, bgCompactMsgId, {
                content: t('chat.autoCompacting'),
                commandStartTime: bgCompactStartedAt,
                commandCompleted: false,
                commandData: { ...existing?.commandData, queued: false, automatic: true },
              });
            } else {
              store.addMessage(tabId, {
                id: bgCompactMsgId,
                role: 'system',
                type: 'text',
                content: t('chat.autoCompacting'),
                commandType: 'processing',
                commandData: { command: '/compact', automatic: true },
                commandStartTime: bgCompactStartedAt,
                timestamp: Date.now(),
              });
            }
            store.setSessionMeta(tabId, { pendingCommandMsgId: bgCompactMsgId });
            store.setSessionStatus(tabId, 'running');
            store.setSessionMeta(tabId, {
              turnStartTime: bgCompactStartedAt,
              lastProgressAt: bgCompactStartedAt,
              inputTokens: 0,
              outputTokens: 0,
            });
            store.setActivityStatus(tabId, { phase: 'thinking' });
            bridge.sendStdin(bgCompactStdinId, '/compact').catch((err) => {
              console.error('[BLACKBOX] Background tab auto-compact failed:', err);
              completePendingCommand(tabId, { output: 'Compact failed to start' });
              if (store.getTab(tabId)?.sessionStatus === 'running') {
                store.setSessionStatus(tabId, 'error');
              }
            });
            setTimeout(() => {
              const meta = store.getTab(tabId)?.sessionMeta ?? {};
              if (meta.pendingCommandMsgId === bgCompactMsgId) {
                markPendingCommandSlow(tabId, bgCompactMsgId, t('chat.compactStillRunning'));
              }
            }, 15_000);
          }
        }

        if (!bgAutoCompactTriggered) {
          const bgDrainTab = store.getTab(tabId);
          drainPendingQueueAfterSettlement({
            tabId,
            stdinId: bgDrainTab?.sessionMeta.stdinId,
            wasStopping: bgWasStopping,
            onDraftRestored: useSessionStore.getState().selectedSessionId === tabId
              ? setInputSync
              : undefined,
          });
        }

        useSessionStore.getState().fetchSessions();

        // AI Title Generation for background tabs (same 3rd-turn logic)
        if (msg.subtype === 'success') {
          const customPreviews = useSessionStore.getState().customPreviews;
          if (!customPreviews[tabId]) {
            const bgTab = store.getTab(tabId);
            const bgUserMsgs = bgTab?.messages.filter(
              (m) => m.role === 'user' && m.type === 'text' && m.content,
            ) || [];
            const bgAssistantMsgs = bgTab?.messages.filter(
              (m) => m.role === 'assistant' && m.type === 'text' && m.content,
            ) || [];
            if (bgUserMsgs.length >= 3 && bgAssistantMsgs.length >= 3) {
              const userMsg = bgUserMsgs.map((m) => m.content).join('\n').slice(0, 500);
              const assistantMsg = bgAssistantMsgs.map((m) => m.content).join('\n').slice(0, 500);
              generateSessionTitleWithPersistedProvider(userMsg, assistantMsg)
                .then((title) => {
                  if (title) {
                    useSessionStore.getState().setCustomPreview(tabId, title);
                  }
                })
                .catch((e) => {
                  // Silently ignore SKIP errors (e.g. no haiku mapping for provider)
                  if (!String(e).includes('SKIP:')) console.warn('Title gen failed:', e);
                });
            }
          }
        }
        break;
      }
      case 'rate_limit_event': {
        const bgRli = msg.rate_limit_info;
        if (bgRli && bgRli.rateLimitType) {
          const bgTab = store.getTab(tabId);
          const prevLimits = bgTab?.sessionMeta?.rateLimits || {};
          store.setSessionMeta(tabId, {
            rateLimits: {
              ...prevLimits,
              [bgRli.rateLimitType]: {
                rateLimitType: bgRli.rateLimitType,
                resetsAt: bgRli.resetsAt,
                isUsingOverage: bgRli.isUsingOverage,
                overageStatus: bgRli.overageStatus,
                overageDisabledReason: bgRli.overageDisabledReason,
              },
            },
          });
        }
        break;
      }
      case 'process_exit': {
        const bgStdinId = msg.__stdinId;
        settleCachedTurn(tabId, false, false);

        // Ownership guard for background exit
        if (bgStdinId) {
          const ownership = checkOwnership(bgStdinId);
          if (!ownership.valid) {
            cleanupStdinRoute(bgStdinId);
            break;
          }
        }

        // Delegate full finalization to lifecycle module (idempotent)
        if (bgStdinId) {
          store.setSessionMeta(tabId, {
            stdinReady: false,
            pendingReadyMessage: undefined,
          });
          handleProcessExitFinalize(bgStdinId);
        } else {
          // Fallback: no stdinId on message
          store.setSessionStatus(tabId, 'idle');
          store.setSessionMeta(tabId, {
            stdinId: undefined,
            stdinReady: false,
            pendingReadyMessage: undefined,
          });
          useSessionStore.getState().fetchSessions();
        }
        break;
      }
      case 'system':
        if (msg.subtype === 'init') {
          markStdinReady(tabId, msg.__stdinId, msg.model);
          recordRuntimeCommandInventory(
            msg,
            store.getTab(tabId)?.sessionMeta.cwdSnapshot,
          );
          useMcpStore.getState().recordRuntimeServers(
            Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [],
            Array.isArray(msg.tools) ? msg.tools : [],
          );
        } else if (msg.subtype === 'commands_changed') {
          // Claude sends the complete current command set. Replace the prior
          // runtime inventory so nested skills/plugins disappearing mid-session
          // cannot linger as callable UI entries.
          recordRuntimeCommandInventory(
            msg,
            store.getTab(tabId)?.sessionMeta.cwdSnapshot,
          );
        } else if (msg.subtype === 'error') {
          // FI-3: Surface system errors in background tabs too
          store.addMessage(tabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: formatErrorForUser(msg.message || msg.error || 'System error'),
            timestamp: Date.now(),
          });
        } else if (msg.subtype === 'api_retry') {
          recordApiRetry(tabId, msg);
        } else if (msg.subtype === 'task_started') {
          const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined;
          const taskId = typeof msg.task_id === 'string' ? msg.task_id : undefined;
          const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
          const bgEventAgentId = resolveAgentEventId(toolUseId, taskId, bgAgents);
          if (bgEventAgentId) {
            const existingToolUseIds = bgAgents.get(bgEventAgentId)?.toolUseIds ?? [];
            upsertCachedAgent(tabId, {
              id: bgEventAgentId,
              taskId,
              toolUseIds: Array.from(new Set([
                ...existingToolUseIds,
                ...(toolUseId ? [toolUseId] : []),
              ])),
              background: true,
              phase: 'thinking',
            });
          }
        } else if (msg.subtype === 'task_progress') {
          const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
          const bgEventAgentId = resolveAgentEventId(msg.tool_use_id, msg.task_id, bgAgents);
          if (bgEventAgentId) {
            upsertCachedAgent(tabId, { id: bgEventAgentId, phase: 'thinking', background: true });
          }
        } else if (msg.subtype === 'task_notification') {
          const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
          const bgEventAgentId = resolveAgentEventId(msg.tool_use_id, msg.task_id, bgAgents);
          if (bgEventAgentId) {
            settleCachedAgent(
              tabId,
              bgEventAgentId,
              isFailedAgentTaskStatus(msg.status),
            );
          }
        }
        break;
      default:
        if (msg.type === 'content_block_delta') {
          if (msg.delta?.type === 'text_delta') {
            const text = msg.delta?.text || '';
            if (text) {
              const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
              const bgAgentId = resolveAgentId(msg.parent_tool_use_id, bgAgents);
              if (isForwardedSubagentEvent(msg)) {
                appendCachedAgentActivity(tabId, bgAgentId, {
                  kind: 'text',
                  content: text,
                  append: true,
                });
              } else {
                store.updatePartialMessage(tabId, text);
              }
            }
          } else if (msg.delta?.type === 'thinking_delta') {
            const thinking = msg.delta?.thinking || '';
            if (thinking && isForwardedSubagentEvent(msg)) {
              const bgAgents = useAgentStore.getState().agentCache.get(tabId) ?? new Map();
              const bgAgentId = resolveAgentId(msg.parent_tool_use_id, bgAgents);
              updateCachedAgentPhase(tabId, bgAgentId, 'thinking');
            } else if (thinking && shouldRenderThinkingForTab(tabId)) {
              appendLiveThinkingDelta(tabId, thinking, msg.__stdinId as string | undefined);
            } else if (thinking && msg.__stdinId) {
              streamController.clearThinking(msg.__stdinId as string);
            }
          }
        }
        break;
    }
  }, [exitPlanModeSeenRef, markStreamProgress]);

  /**
   * Handle stream messages for the foreground (active) tab.
   */
  const handleStreamMessage = useCallback((msg: any) => {
    if (!msg || !msg.type) return;

    try { // P1-4: error boundary — prevent uncaught exceptions from crashing the stream pipeline

    // Diagnostic: log first message and unrecognized types
    const KNOWN_TYPES = new Set([
      'blackbox_permission_request', 'blackbox_control_request_cancelled',
      'stream_event', 'system', 'assistant',
      'user', 'human', 'tool_result', 'tool_use_summary', 'result', 'process_exit',
      'content_block_delta', 'rate_limit_event',
    ]);
    if (msg.type === 'system' || msg.type === 'process_exit') {
      console.log('[BLACKBOX:stream]', msg.type, msg.subtype || '', msg.__stdinId || '');
    }
    if (!KNOWN_TYPES.has(msg.type)) {
      console.warn('[BLACKBOX:stream] unhandled message type:', msg.type, msg);
    }

    // --- Background routing: detect if this stream belongs to a non-active tab ---
    // MUST run before blackbox_permission_request and all other handlers
    // to prevent messages from background sessions leaking into the active tab.
    const msgStdinId = msg.__stdinId;
    const directOwnerTabId = msgStdinId
      ? useSessionStore.getState().getTabForStdin(msgStdinId)
      : undefined;
    const finalizedRoute = msgStdinId ? getRecentlyFinalizedStdin(msgStdinId) : undefined;
    const isFinalizedUserStopEvent = !directOwnerTabId && finalizedRoute?.reason === 'stop';
    if (isFinalizedUserStopEvent) {
      if (msg.type === 'result') {
        useChatStore.getState().setSessionStatus(finalizedRoute.tabId, 'stopped');
        useChatStore.getState().setSessionMeta(finalizedRoute.tabId, {
          stdinReady: false,
          pendingReadyMessage: undefined,
          turnStartTime: undefined,
          lastProgressAt: undefined,
          apiRetry: undefined,
        });
        useSessionStore.getState().fetchSessions();
      }
      return;
    }
    let ownerTabId = directOwnerTabId;
    if (ownerTabId) {
      // Identity adoption must happen before foreground/background branching.
      // Otherwise a system:init arriving after a tab switch leaves draft_* as
      // the UI key while Claude persists the same conversation under its UUID.
      ownerTabId = captureCliSessionIdentity(ownerTabId, msg, msgStdinId);
    }
    const activeTabId = useSessionStore.getState().selectedSessionId;

    const isBackground = Boolean(ownerTabId && ownerTabId !== activeTabId);

    // If stream belongs to a background tab, route key events to cache and return
    if (isBackground && ownerTabId) {
      // Diagnostic: log background routing for non-trivial message types
      if (msg.type !== 'stream_event') {
        console.log('[BLACKBOX:route] background:', msg.type, 'owner:', ownerTabId, 'active:', activeTabId);
      }
      handleBackgroundStreamMessage(msg, ownerTabId);
      return;
    }

    // Resolve tabId once for all foreground store calls.
    // NEW-E fix: if ownerTabId is undefined (no stdinToTab mapping), stash to
    // orphan queue instead of falling through to activeTabId.
    if (!ownerTabId && msgStdinId) {
      streamController.stashOrphanEvent(msgStdinId, msg);
      return;
    }

    const initialTabId = ownerTabId || activeTabId;
    if (!initialTabId) return;
    let tabId: string = initialTabId;

    // Ownership guard: reject stale messages BEFORE any state writes (F4 fix).
    // Must run before permission handling, cliResumeId capture, or switch block.
    if (msgStdinId) {
      const guardTab = useChatStore.getState().getTab(tabId);
      if (guardTab?.sessionMeta.stdinId && guardTab.sessionMeta.stdinId !== msgStdinId) {
        return; // stale message from old process — discard
      }
    }

    // Update progress for stall detection without writing Zustand state for every token.
    markStreamProgress(tabId, msg);
    useWorkflowStore.getState().applyStreamEvent(tabId, msg);

    if (msg.type === 'blackbox_control_request_cancelled') {
      expireSdkControlRequest(tabId, msg);
      return;
    }

    // --- SDK Permission Request (routed through stream channel for reliability) ---
    if (msg.type === 'blackbox_permission_request') {

      // ExitPlanMode: only show PlanReviewCard in Plan mode.
      // In other modes, auto-approve so the CLI continues without blocking.
      if (msg.tool_name === 'ExitPlanMode') {
        const tabState = useChatStore.getState().getTab(tabId);
        if (getEffectiveMode(tabState?.sessionMeta) !== 'plan') {
          // Auto-approve: CLI doesn't need user confirmation outside Plan mode
          const stdinId = msg.__stdinId;
          if (stdinId) {
            bridge.respondPermission(stdinId, msg.request_id, true, undefined, msg.tool_use_id, msg.input);
          }
          return;
        }
        const chatStore = useChatStore.getState();
        const messages = tabState?.messages ?? [];
        const permData = {
          requestId: msg.request_id,
          toolName: msg.tool_name,
          input: msg.input,
          description: msg.description,
          toolUseId: msg.tool_use_id,
        };
        const planReview = messages.find((m) => m.id === 'plan_review_current' && !m.resolved);
        if (planReview) {
          chatStore.updateMessage(tabId, 'plan_review_current', { permissionData: permData });
        } else {
          // PlanReviewCard not yet created — create one with permission data
          let planContent = '';
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant' && messages[i].type === 'text' && messages[i].content) {
              planContent = messages[i].content;
              break;
            }
          }
          chatStore.addMessage(tabId, {
            id: 'plan_review_current',
            role: 'assistant',
            type: 'plan_review',
            content: planContent,
            planContent: planContent,
            resolved: false,
            permissionData: permData,
            timestamp: Date.now(),
          });
          chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
        }
        return;
      }

      // AskUserQuestion: create QuestionCard instead of PermissionCard.
      // User answers are sent back via respondPermission(updatedInput) — NOT sendStdin.
      if (msg.tool_name === 'AskUserQuestion') {
        const chatStore = useChatStore.getState();
        const messages = chatStore.getTab(tabId)?.messages ?? [];
        const questionId = msg.tool_use_id || 'ask_question_current';
        // Search by exact ID first, then fall back to any unresolved AskUserQuestion.
        // This handles the race condition where the assistant message arrives first
        // with block.id (e.g. "toolu_01abc") and the control_request arrives later
        // with a different or missing tool_use_id.
        const existing = messages.find((m) => m.id === questionId && m.type === 'question')
          || messages.find((m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion');
        if (existing) {
          // Patch permissionData so QuestionCard uses respondPermission (SDK path)
          // instead of sendStdin (legacy path). Always update — even if permissionData
          // exists — because a new control_request supersedes a stale one.
          const existingOwnerStdin = (msg.__stdinId as string | undefined)
            ?? chatStore.getTab(tabId)?.sessionMeta.stdinId;
          clearLivePartialText(tabId, existingOwnerStdin);
          chatStore.updateMessage(tabId, existing.id, {
            permissionData: {
              requestId: msg.request_id,
              toolName: msg.tool_name,
              input: msg.input,
              toolUseId: msg.tool_use_id,
            },
            toolInput: msg.input,
            owner: existing.owner
              ?? (existingOwnerStdin ? { tabId, stdinId: existingOwnerStdin } : undefined),
          });
          return;
        }
        const questions = msg.input?.questions;
        // Phase 4 §5.3 (S3): stamp the owning tab/stdin so the card's answer
        // handler can use the spawning context instead of getActiveTabState().
        const ownerStdinId = (msg.__stdinId as string | undefined)
          ?? chatStore.getTab(tabId)?.sessionMeta.stdinId;
        clearLivePartialText(tabId, ownerStdinId);
        chatStore.addMessage(tabId, {
          id: questionId,
          role: 'assistant',
          type: 'question',
          content: '',
          toolName: 'AskUserQuestion',
          toolInput: msg.input,
          questions: Array.isArray(questions) ? questions : [],
          resolved: false,
          timestamp: Date.now(),
          // Attach permission data so QuestionCard uses respondPermission instead of sendStdin
          permissionData: {
            requestId: msg.request_id,
            toolName: msg.tool_name,
            input: msg.input,
            toolUseId: msg.tool_use_id,
          },
          owner: ownerStdinId ? { tabId, stdinId: ownerStdinId } : undefined,
        });
        chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
        return;
      }

      const ownerStdinId = (msg.__stdinId as string | undefined)
        ?? useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
      if (autoAllowRegisteredSessionPermission(tabId, msg, ownerStdinId)) return;
      addRegularPermissionCard(tabId, msg, ownerStdinId);
      return;
    }

    const cs = useChatStore.getState();
    const addMessage = (message: ChatMessage) => cs.addMessage(tabId, message);
    const setSessionStatus = (status: import('../stores/chatStore').SessionStatus) => cs.setSessionStatus(tabId, status);
    const setSessionMeta = (meta: Partial<import('../stores/chatStore').SessionMeta>) => cs.setSessionMeta(tabId, meta);
    const setActivityStatus = (status: import('../stores/chatStore').ActivityStatus) => cs.setActivityStatus(tabId, status);
    const agentActions = useAgentStore.getState();
    const agentId = resolveAgentId(msg.parent_tool_use_id, agentActions.agents);
    const agentDepth = getAgentDepth(agentId, agentActions.agents);

    // Capture the CLI's own session ID from stream events (used for --resume)
    tabId = captureCliSessionIdentity(tabId, msg, msgStdinId);

    // Helper: clear accumulated partial text for THIS tab only.
    // B1: flush must be scoped to msgStdinId — calling flushStreamBuffer() with
    //     no args previously wiped every active session's rAF buffer, causing
    //     cross-tab data loss when one tab's turn completed while another was
    //     streaming. B2: buffer drop happens inside flushStreamBuffer (delete
    //     from _streamBuffers) so no late rAF can repopulate this tab's partial
    //     after we clear it below — flush → clear is atomic w.r.t. this tab.
    const clearPartial = () => {
      if (msgStdinId) flushStreamBuffer(msgStdinId);
      const tabData = useChatStore.getState().getTab(tabId);
      if (tabData && (tabData.isStreaming || tabData.partialText || tabData.partialThinking)) {
        const newTabs = new Map(useChatStore.getState().tabs);
        newTabs.set(tabId, { ...tabData, partialText: '', partialThinking: '', isStreaming: false });
        useChatStore.setState({ tabs: newTabs, sessionCache: newTabs });
      }
    };

    // Ownership guard: verify that the message's stdinId still matches
    // the tab's current stdinId. Stale messages from old processes that
    // arrive after a Provider/Model switch are silently dropped.
    if (msgStdinId) {
      const currentTab = useChatStore.getState().getTab(tabId);
      if (currentTab?.sessionMeta.stdinId && currentTab.sessionMeta.stdinId !== msgStdinId) {
        // Stale message from old process — skip
        return;
      }
    }

    switch (msg.type) {
      // --- stream_event: wrapper for real-time streaming events from --include-partial-messages ---
      case 'stream_event': {
        const evt = msg.event;
        if (!evt) break;
        const forwardedSubagentEvent = isForwardedSubagentEvent(msg);

        // Diagnostic: log tool_use starts for debugging plan mode flow
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          console.log('[BLACKBOX:stream] tool_use start:', evt.content_block.name);

          // UX: immediately surface that a tool is running. Without this, the
          // user sees no feedback during long tool input streams (e.g. Write
          // streaming a 2000-word article takes ~50s, during which the
          // ActivityIndicator stays in 'thinking' phase and no card appears).
          // We add a placeholder tool_use card keyed by the content_block.id;
          // when case 'assistant' arrives with the full message, addMessage's
          // id-based dedup will merge the actual toolInput into this card.
          // Skip ExitPlanMode (handled by plan_review path) and Task/Agent/
          // TaskCreate/SendMessage (handled by agent registration below).
          const toolName = evt.content_block.name;
          if (!forwardedSubagentEvent && shouldCreateStreamingToolPlaceholder(toolName)) {
            setActivityStatus({ phase: 'tool', toolName });
            agentActions.updatePhase(agentId, 'tool', toolName);
            addMessage({
              id: evt.content_block.id || `tool_placeholder_${Date.now()}`,
              role: 'assistant',
              type: 'tool_use',
              content: '',
              toolName,
              toolInput: {},
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          }
        }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          if (text && msgStdinId) {
            if (forwardedSubagentEvent) {
              agentActions.appendActivity(agentId, {
                kind: 'text',
                content: text,
                append: true,
              });
            } else {
              streamController.appendText(msgStdinId, text);
            }
            agentActions.updatePhase(agentId, 'writing');
          }
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          const thinkingText = evt.delta.thinking || '';
          if (thinkingText && msgStdinId) {
            if (forwardedSubagentEvent) {
              agentActions.updatePhase(agentId, 'thinking');
            } else if (shouldRenderThinkingForTab(tabId)) {
              streamController.appendThinking(msgStdinId, thinkingText);
              agentActions.updatePhase(agentId, 'thinking');
            } else {
              streamController.clearThinking(msgStdinId);
              setActivityStatus({ phase: 'writing' });
              agentActions.updatePhase(agentId, 'writing');
            }
          } else {
            setActivityStatus({ phase: shouldRenderThinkingForTab(tabId) ? 'thinking' : 'writing' });
            agentActions.updatePhase(agentId, shouldRenderThinkingForTab(tabId) ? 'thinking' : 'writing');
          }
        }

        if (
          forwardedSubagentEvent
          && evt.type === 'content_block_start'
          && evt.content_block?.type === 'tool_use'
        ) {
          agentActions.appendActivity(agentId, {
            kind: 'tool',
            content: evt.content_block.name || 'Tool',
            toolName: evt.content_block.name,
          });
          agentActions.updatePhase(agentId, 'tool', evt.content_block.name);
        }

        // Early agent creation: register sub-agent as soon as Agent/Task tool_use
        // starts streaming, so subsequent events resolve to the correct agent.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'Task' || evt.content_block?.name === 'Agent')) {
          const identity = agentToolIdentity(evt.content_block);
          agentActions.upsertAgent({
            id: evt.content_block.id || `task_${Date.now()}`,
            parentId: agentId,
            description: identity.description,
            phase: 'spawning',
            startTime: Date.now(),
            isMain: false,
            kind: identity.kind,
            name: identity.name,
            model: identity.model,
          });
        }
        // Early detection: create plan_review card ONLY in explicit Plan mode.
        // In Code mode the CLI handles ExitPlanMode natively.
        // In Bypass mode the Rust backend auto-approves — no UI card needed.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && evt.content_block?.name === 'ExitPlanMode'
            && !forwardedSubagentEvent
            && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
          const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

          // Guard: if plan_review_current already exists and was resolved,
          // this is a replay after plan approval — don't create a new card.
          const existingReview = currentMessages.find((m) => m.id === 'plan_review_current');
          if (!existingReview || !existingReview.resolved) {
            let planContent = '';
            for (let i = currentMessages.length - 1; i >= 0; i--) {
              const m = currentMessages[i];
              if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                planContent = m.toolInput.content;
                break;
              }
            }

            addMessage({
              id: 'plan_review_current',
              role: 'assistant',
              type: 'plan_review',
              content: planContent,
              planContent: planContent,
              resolved: false,
              timestamp: Date.now(),
            });
            setActivityStatus({ phase: 'awaiting' });
          }
        }

        // Track input tokens from message_start (per-turn + cumulative total)
        if (evt.type === 'message_start' && evt.message?.usage?.input_tokens) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const delta = evt.message.usage.input_tokens;
          setSessionMeta({
            inputTokens: (meta.inputTokens || 0) + delta,
            totalInputTokens: (meta.totalInputTokens || 0) + delta,
          });
        }

        // Track output tokens from message_delta (per-turn + cumulative total)
        if (evt.type === 'message_delta' && evt.usage?.output_tokens) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const delta = evt.usage.output_tokens;
          setSessionMeta({
            outputTokens: (meta.outputTokens || 0) + delta,
            totalOutputTokens: (meta.totalOutputTokens || 0) + delta,
          });
        }
        break;
      }

      case 'system':
        if (msg.subtype === 'init') {
          markStdinReady(tabId, msg.__stdinId, msg.model);
          recordRuntimeCommandInventory(
            msg,
            useChatStore.getState().getTab(tabId)?.sessionMeta.cwdSnapshot,
          );
          useMcpStore.getState().recordRuntimeServers(
            Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [],
            Array.isArray(msg.tools) ? msg.tools : [],
          );
        } else if (msg.subtype === 'commands_changed') {
          recordRuntimeCommandInventory(
            msg,
            useChatStore.getState().getTab(tabId)?.sessionMeta.cwdSnapshot,
          );
        } else if (msg.subtype === 'error') {
          // FI-3: Surface system-level errors instead of silently dropping them
          const rawError = msg.message || msg.error || 'System error';
          addMessage({
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: formatErrorForUser(rawError),
            timestamp: Date.now(),
          });
        } else if (msg.subtype === 'api_retry') {
          recordApiRetry(tabId, msg);
        } else if (msg.subtype === 'task_started') {
          const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined;
          const taskId = typeof msg.task_id === 'string' ? msg.task_id : undefined;
          const eventAgentId = resolveAgentEventId(
            toolUseId,
            taskId,
            useAgentStore.getState().agents,
          );
          if (eventAgentId) {
            const currentAgent = useAgentStore.getState().agents.get(eventAgentId);
            agentActions.upsertAgent({
              id: eventAgentId,
              taskId,
              toolUseIds: Array.from(new Set([
                ...(currentAgent?.toolUseIds ?? []),
                ...(toolUseId ? [toolUseId] : []),
              ])),
              background: true,
              phase: 'thinking',
            });
          }
        } else if (msg.subtype === 'task_progress') {
          const eventAgentId = resolveAgentEventId(
            msg.tool_use_id,
            msg.task_id,
            useAgentStore.getState().agents,
          );
          if (eventAgentId) {
            agentActions.upsertAgent({ id: eventAgentId, phase: 'thinking', background: true });
          }
        } else if (msg.subtype === 'task_notification') {
          const eventAgentId = resolveAgentEventId(
            msg.tool_use_id,
            msg.task_id,
            useAgentStore.getState().agents,
          );
          if (eventAgentId) {
            if (isFailedAgentTaskStatus(msg.status)) {
              agentActions.completeAgent(eventAgentId, 'error');
            } else {
              agentActions.setAgentIdle(eventAgentId);
            }
          }
        } else if (
          msg.subtype === 'hook_started' ||
          msg.subtype === 'hook_progress' ||
          msg.subtype === 'hook_response' ||
          msg.subtype === 'status'
        ) {
          // Hook lifecycle + status events — silently ignore (no UI for these in TC)
        } else {
          // FI-3: Log unknown subtypes so we know what we're missing
          console.warn('[BLACKBOX] Unhandled system subtype:', msg.subtype, msg);
        }
        break;

      case 'assistant': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        const assistantMessageId = logicalAssistantMessageId(msg);
        if (isForwardedSubagentEvent(msg)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              const safeText = sanitizeAssistantTextForDisplay(block.text).trim();
              if (safeText) {
                agentActions.appendActivity(agentId, {
                  kind: 'text',
                  content: safeText,
                });
                agentActions.updatePhase(agentId, 'writing');
              }
            } else if (block.type === 'tool_use') {
              agentActions.appendActivity(agentId, {
                kind: 'tool',
                content: block.name || 'Tool',
                toolName: block.name,
              });
              if (block.name === 'Task' || block.name === 'Agent') {
                const identity = agentToolIdentity(block);
                agentActions.upsertAgent({
                  id: block.id || generateMessageId(),
                  parentId: agentId,
                  description: identity.description,
                  phase: 'spawning',
                  startTime: Date.now(),
                  isMain: false,
                  kind: identity.kind,
                  name: identity.name,
                  model: identity.model,
                });
              } else {
                agentActions.updatePhase(agentId, 'tool', block.name);
              }
            } else if (block.type === 'thinking') {
              agentActions.updatePhase(agentId, 'thinking');
            }
          }
          break;
        }

        setSessionMeta({
          awaitingVisibleAssistantResponse:
            !assistantContentHasVisibleTerminalResponse(content),
        });

        // With --include-partial-messages, intermediate assistant messages arrive
        // frequently. We must NOT aggressively wipe streaming text state when the
        // message only contains a thinking block (no text block yet).
        const hasTextBlock = content.some((b: any) => b.type === 'text' && b.text);
        const hasAskUserQuestion = content.some(
          (b: any) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
        );
        const shouldRenderThinking = shouldRenderThinkingForTab(tabId);
        const isPureThinkingOnly = shouldRenderThinking && isPureThinkingOnlySnapshot(content);
        const shouldMaterializeThinking = shouldRenderThinking
          && shouldMaterializeThinkingSnapshot(content, hasTextBlock);
        const currentTab = useChatStore.getState().getTab(tabId);
        const bufferedThinking = msgStdinId
          ? streamController.peekBufferedThinking(msgStdinId)
          : undefined;
        const thinkingPersistence = shouldRenderThinking
          ? resolveThinkingPersistence(
            assistantMessageId,
            content,
            currentTab?.partialThinking,
            bufferedThinking,
          )
          : null;
        if (!shouldMaterializeThinking && isPureThinkingOnly && thinkingPersistence) {
          preserveLiveThinkingSnapshot({
            tabId,
            thinkingPersistence,
            stdinId: msgStdinId,
          });
        }
        const committedThinkingBeforeText = hasTextBlock
          ? commitThinkingBeforeAssistantText({
            tabId,
            msgUuid: assistantMessageId,
            thinkingPersistence,
            timestamp: Date.now(),
            subAgentDepth: agentDepth,
            stdinId: msgStdinId,
          })
          : false;

        if (hasTextBlock) {
          // Full clear — the text block supersedes streaming partial text
          clearPartial();
        } else if (hasAskUserQuestion) {
          clearLivePartialText(tabId, msgStdinId);
        }

        // If there's a pending slash command processing card, mark it as
        // completed now — the assistant response means the CLI has responded.
        // Some commands (e.g. /compact) may not emit a 'result' event.
        const pendingCmd = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (pendingCmd) {
          useChatStore.getState().updateMessage(tabId, pendingCmd, {
            commandCompleted: true,
            commandData: {
              ...(useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmd)?.commandData,
              completedAt: Date.now(),
            },
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // If this message contains AskUserQuestion, skip text blocks —
        // the interactive question UI makes them redundant and avoids
        // showing raw question descriptions alongside the rich UI.
        let thinkingMessageEmitted = committedThinkingBeforeText;

        for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
          const block = content[blockIdx];
          if (block.type === 'text') {
            const displayText = sanitizeAssistantTextForDisplay(block.text);
            if (
              hasAskUserQuestion
              || isCliPlaceholder(block.text)
              || shouldHoldPotentialContextDropGreeting(tabId, block.text)
              || !displayText.trim()
            ) continue;
            setActivityStatus({ phase: 'writing' });
            agentActions.updatePhase(agentId, 'writing');
            // Use msg.uuid + block index as stable ID so re-delivered
            // messages de-duplicate correctly in the store.
            const textId = assistantMessageId
              ? `${assistantMessageId}_text_${blockIdx}`
              : generateMessageId();
            addMessage({
              id: textId,
              role: 'assistant',
              type: 'text',
              content: displayText,
              isFinalResponse: msg.message?.stop_reason === 'end_turn',
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          } else if (block.type === 'tool_use') {
            // Code mode: EnterPlanMode/ExitPlanMode are transparent — CLI handles internally.
            // Don't show tool cards; track ExitPlanMode for auto-restart if CLI exits.
            if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
                && (block.name === 'EnterPlanMode' || block.name === 'ExitPlanMode')) {
              if (block.name === 'ExitPlanMode') exitPlanModeSeenRef.current = true;
              continue;
            }
            setActivityStatus({ phase: 'tool', toolName: block.name });
            if (block.name === 'Task' || block.name === 'Agent') {
              const identity = agentToolIdentity(block);
              agentActions.upsertAgent({
                id: block.id || generateMessageId(),
                parentId: agentId,
                description: identity.description,
                phase: 'spawning',
                startTime: Date.now(),
                isMain: false,
                kind: identity.kind,
                name: identity.name,
                model: identity.model,
              });
            } else {
              agentActions.updatePhase(agentId, 'tool', block.name);
              if (block.name === 'TaskCreate' && block.id) {
                agentActions.registerTeamTask(block.id, block.input || {});
              } else if (block.name === 'TaskUpdate') {
                agentActions.updateTeamTask(block.input || {});
              }
            }

            if (
              agentDepth === 0
              && !msg.parent_tool_use_id
              && (block.name === 'TaskCreate' || block.name === 'TaskUpdate')
            ) {
              try {
                syncNativeTaskPlan(tabId, useAgentStore.getState().teamTasks.values());
              } catch (error) {
                console.warn('[BLACKBOX Plan] Ignored invalid native Task state:', error);
              }
            }

            if (block.name === 'AskUserQuestion') {
              // Use a stable sentinel ID so re-delivered blocks de-duplicate
              // instead of creating duplicate question cards (TK-103).
              const questionId = block.id || 'ask_question_current';

              // Guard: skip if question already exists (resolved or not).
              // Search by exact ID first, then by any AskUserQuestion card —
              // the control_request handler may have already created one with
              // a different ID (e.g. 'ask_question_current' vs 'toolu_01abc').
              const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
              const existingQuestion = currentMessages.find(
                (m) => m.id === questionId && m.type === 'question',
              ) || currentMessages.find(
                (m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion',
              );
              if (existingQuestion) {
                // Already exists — just ensure awaiting state if unresolved
                if (!existingQuestion.resolved) {
                  setActivityStatus({ phase: 'awaiting' });
                }
                break;
              }

              const questions = block.input?.questions;
              const fgOwnerStdinId = (msg.__stdinId as string | undefined)
                ?? useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
              addMessage({
                id: questionId,
                role: 'assistant',
                type: 'question',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                questions: Array.isArray(questions) ? questions : [],
                resolved: false,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
                owner: fgOwnerStdinId ? { tabId, stdinId: fgOwnerStdinId } : undefined,
              });
              // Mark as awaiting user input (consistent with ExitPlanMode)
              setActivityStatus({ phase: 'awaiting' });
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              if (agentDepth === 0 && !msg.parent_tool_use_id) {
                try {
                  usePlanStore.getState().setPlan(tabId, block.input.todos, undefined, 'todo');
                } catch (error) {
                  console.warn('[BLACKBOX Plan] Ignored invalid TodoWrite plan:', error);
                }
              }
              addMessage({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'todo',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });
            } else if (block.name === 'ExitPlanMode') {
              // Show ExitPlanMode as a collapsible tool_use (like other tools)
              addMessage({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });

              // Only create plan_review card in Plan mode.
              // In Code mode the CLI handles ExitPlanMode natively.
              // In Bypass mode the Rust backend auto-approves — no UI card needed.
              if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
                const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

                // Guard: skip if already approved (replay)
                const toolAlreadyExisted = block.id && currentMessages.some(
                  (m) => m.id === block.id && m.toolName === 'ExitPlanMode',
                );
                const existingReview = currentMessages.find(
                  (m) => m.type === 'plan_review' && m.resolved,
                );
                if (!(toolAlreadyExisted && existingReview)) {
                  let planContent = '';
                  for (let i = currentMessages.length - 1; i >= 0; i--) {
                    const m = currentMessages[i];
                    if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                      planContent = m.toolInput.content;
                      break;
                    }
                  }

                  addMessage({
                    id: 'plan_review_current',
                    role: 'assistant',
                    type: 'plan_review',
                    content: planContent,
                    planContent: planContent,
                    resolved: false,
                    timestamp: Date.now(),
                  });
                  setActivityStatus({ phase: 'awaiting' });
                }
              }
            } else {
              addMessage({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });

            }
          } else if (block.type === 'thinking') {
            if (!shouldRenderThinking) continue;
            // Complete thinking block arrived — clear streaming thinking text.
            // DON'T override activityStatus here: if text is currently streaming,
            // the phase should remain 'writing'. The streaming events (thinking_delta,
            // text_delta) are the source of truth for activity phase.
            if (thinkingMessageEmitted) continue;
            agentActions.updatePhase(agentId, 'thinking');
            if (shouldMaterializeThinking && thinkingPersistence) {
              thinkingMessageEmitted = commitThinkingBeforeAssistantText({
                tabId,
                msgUuid: assistantMessageId,
                thinkingPersistence,
                timestamp: Date.now(),
                subAgentDepth: agentDepth,
                stdinId: msgStdinId,
              });
            }
          }
        }
        if (shouldMaterializeThinking && thinkingPersistence && !thinkingMessageEmitted) {
          commitThinkingBeforeAssistantText({
            tabId,
            msgUuid: assistantMessageId,
            thinkingPersistence,
            timestamp: Date.now(),
            subAgentDepth: agentDepth,
            stdinId: msgStdinId,
          });
        }

        // NOTE: No save/restore hack needed here. addMessage no longer clears
        // partialText/isStreaming as a side effect (TK-322 fix), so intermediate
        // assistant messages with only thinking/tool_use blocks won't wipe
        // streaming text state.
        break;
      }

      case 'user':
      case 'human': {
        // Store CLI checkpoint UUID on the most recent user message (for rewind).
        // Only store from genuine user-input messages, NOT tool-result messages.
        // Tool-result user messages have content with tool_result blocks and their
        // UUIDs don't match the file-history-snapshot messageId used by --rewind-files.
        {
          const content = msg.message?.content;
          const isToolResult = Array.isArray(content)
            && content.some((b: any) => b.type === 'tool_result');
          if (msg.uuid && !isToolResult) {
            const allMsgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
            for (let i = allMsgs.length - 1; i >= 0; i--) {
              if (allMsgs[i].role === 'user') {
                console.log('[stream] Storing checkpointUuid:', msg.uuid, 'on msg:', allMsgs[i].id);
                useChatStore.getState().updateMessage(tabId, allMsgs[i].id, { checkpointUuid: msg.uuid });
                break;
              }
            }
          }
        }

        const launch = parseAsyncAgentLaunch(msg);
        if (launch) {
          const currentAgents = useAgentStore.getState().agents;
          agentActions.upsertAgent(backgroundAgentNode(launch, currentAgents));
        }
        const notification = parseAgentTaskNotification(messageTextContent(msg));
        if (notification) {
          const currentAgents = useAgentStore.getState().agents;
          const eventAgentId = resolveAgentEventId(
            notification.toolUseId,
            notification.taskId,
            currentAgents,
          );
          if (eventAgentId) {
            const safeResult = notification.resultText
              ? sanitizeAssistantTextForDisplay(notification.resultText).trim()
              : '';
            if (safeResult) {
              agentActions.appendActivity(eventAgentId, {
                kind: 'text',
                content: safeResult,
              });
            }
            if (isFailedAgentTaskStatus(notification.status)) {
              agentActions.completeAgent(eventAgentId, 'error');
            } else {
              agentActions.setAgentIdle(eventAgentId);
            }
          }
        }
        const userContent = msg.message?.content;
        if (Array.isArray(userContent)) {
          if (
            !isForwardedSubagentEvent(msg)
            && userContent.some((block: any) => block.type === 'tool_result')
          ) {
            setSessionMeta({ awaitingVisibleAssistantResponse: true });
          }
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              const resultText = Array.isArray(block.content)
                ? block.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
                : typeof block.content === 'string'
                  ? block.content
                  : '';
              const targetId = resolveToolResultTargetMessageId(
                useChatStore.getState().getTab(tabId)?.messages ?? [],
                block.tool_use_id,
                undefined,
              );
              if (targetId) {
                const parentMsg = useChatStore.getState().getTab(tabId)?.messages.find((m) => m.id === targetId);
                if (parentMsg?.toolName === 'TaskCreate') {
                  agentActions.resolveTeamTask(block.tool_use_id, resultText);
                }
                recordNativeLoopReceipt(tabId, parentMsg, resultText);
                const safeResult = sanitizeToolResultForDisplay(parentMsg?.toolName, resultText);
                useChatStore.getState().updateMessage(tabId, targetId, {
                  toolCompleted: true,
                  ...(safeResult ? { toolResultContent: safeResult } : {}),
                });
              }
            }
          }
        }
        if (msg.tool_use_result || msg.toolUseResult) {
          const tur = msg.tool_use_result ?? msg.toolUseResult;
          const resultText = typeof tur === 'string' ? tur
            : typeof tur.stdout === 'string' ? tur.stdout
            : typeof tur.content === 'string' ? tur.content
            : Array.isArray(tur.content) ? tur.content.map((b: any) => typeof b.text === 'string' ? b.text : '').join('')
            : typeof tur.content === 'object' && tur.content?.text ? String(tur.content.text)
            : '';
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              const targetId = resolveToolResultTargetMessageId(
                useChatStore.getState().getTab(tabId)?.messages ?? [],
                block.tool_use_id,
                undefined,
              );
              if (targetId) {
                const parentMsg = useChatStore.getState().getTab(tabId)?.messages.find((m) => m.id === targetId);
                if (parentMsg?.toolName === 'TaskCreate') {
                  agentActions.resolveTeamTask(block.tool_use_id, resultText);
                }
                recordNativeLoopReceipt(tabId, parentMsg, resultText);
                const safeResult = sanitizeToolResultForDisplay(parentMsg?.toolName, resultText);
                useChatStore.getState().updateMessage(tabId, targetId, {
                  toolCompleted: true,
                  ...(safeResult ? { toolResultContent: safeResult } : {}),
                });
              }
            }
          }
        }
        break;
      }

      case 'tool_result': {
        const resultContent = Array.isArray(msg.content)
          ? msg.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
          : typeof msg.content === 'string'
            ? msg.content
            : msg.output || '';

        if (isForwardedSubagentEvent(msg)) {
          agentActions.updatePhase(agentId, 'thinking');
          break;
        }
        setSessionMeta({ awaitingVisibleAssistantResponse: true });

        const toolUseId = msg.tool_use_id;
        // Auto-refresh file tree when file-mutating tools complete
        _maybeRefreshFileTree(tabId, toolUseId, msg.tool_name);
        const targetId = resolveToolResultTargetMessageId(
          useChatStore.getState().getTab(tabId)?.messages ?? [],
          toolUseId,
          msg.tool_name,
        );

        if (targetId) {
          const currentMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
          const parentMsg = currentMessages.find((m) => m.id === targetId);
          if (parentMsg) {
            if (parentMsg.toolName === 'TaskCreate') {
              agentActions.resolveTeamTask(toolUseId, resultContent);
            }
            recordNativeLoopReceipt(tabId, parentMsg, resultContent, msg.tool_name);
            const safeResult = sanitizeToolResultForDisplay(parentMsg.toolName ?? msg.tool_name, resultContent);
            const updates: Partial<ChatMessage> = {
              toolCompleted: true,
              ...(safeResult ? { toolResultContent: safeResult } : {}),
            };

            // Backfill: if parent is AskUserQuestion created with empty questions
            // (due to streaming), or was mis-typed as tool_use, fix it now.
            if (parentMsg.toolName === 'AskUserQuestion') {
              if (parentMsg.type !== 'question') {
                updates.type = 'question';
                updates.resolved = false;
              }
              if (!parentMsg.questions || parentMsg.questions.length === 0) {
                // Try to extract questions from toolInput (may have been populated
                // by a later assistant message with complete content)
                const qs = parentMsg.toolInput?.questions;
                if (Array.isArray(qs) && qs.length > 0) {
                  updates.questions = qs;
                }
              }
            }

            useChatStore.getState().updateMessage(tabId, targetId, updates);
            break;
          }
        }
        // Complete Agent Team agents when their tool result arrives
        if (toolUseId && agentActions.agents.has(toolUseId)) {
          agentActions.completeAgent(toolUseId, 'completed');
        }
        addMessage({
          id: msg.uuid || generateMessageId(),
          role: 'assistant',
          type: 'tool_result',
          content: resultContent,
          toolName: msg.tool_name,
          subAgentDepth: agentDepth,
          timestamp: Date.now(),
        });
        break;
      }

      case 'tool_use_summary':
        break;

      case 'result': {
        // Capture stopping state BEFORE any status updates — needed for drain guard later
        const fgResultTab = useChatStore.getState().getTab(tabId);
        const fgWasStopping = fgResultTab?.sessionStatus === 'stopping';
        const fgFinalizedRoute = msgStdinId ? getRecentlyFinalizedStdin(msgStdinId) : undefined;
        const fgErrorText = [msg.result, msg.error, msg.content]
          .filter(Boolean)
          .map(String)
          .join(' ')
          .trim();
        const fgIsUserStopResult = msg.subtype !== 'success'
          && (
            fgWasStopping
            || fgResultTab?.sessionMeta.teardownReason === 'stop'
            || fgFinalizedRoute?.reason === 'stop'
            || msg.subtype === 'user_abort'
          );

        // Sub-agent results carry parent_tool_use_id — they must NOT terminate the
        // main session. Only the main agent's result (no parent_tool_use_id) ends the
        // session. Without this guard, the first parallel sub-agent to complete would
        // call setSessionStatus('completed') and freeze the UI mid-run.
        if (msg.parent_tool_use_id) {
          const completedAgentId = resolveAgentId(msg.parent_tool_use_id, agentActions.agents);
          const safeResult = typeof msg.result === 'string'
            ? sanitizeAssistantTextForDisplay(msg.result).trim()
            : '';
          if (safeResult && !isCliPlaceholder(safeResult)) {
            agentActions.appendActivity(completedAgentId, {
              kind: 'text',
              content: safeResult,
            });
          }
          if (msg.subtype === 'success') agentActions.setAgentIdle(completedAgentId);
          else agentActions.completeAgent(completedAgentId, 'error');
          break;
        }

        if (fgIsUserStopResult) {
          if (msgStdinId && fgWasStopping) {
            handleProcessExitFinalize(msgStdinId);
          } else {
            setSessionStatus('stopped');
            setSessionMeta({
              stdinReady: false,
              pendingReadyMessage: undefined,
              turnStartTime: undefined,
              lastProgressAt: undefined,
              apiRetry: undefined,
              activeTurnInput: undefined,
              contextRecoveryAttempts: undefined,
              awaitingVisibleAssistantResponse: undefined,
              emptyTerminalRecoveryAfterCompact: undefined,
            });
          }
          agentActions.completeAll('error');
          useSessionStore.getState().fetchSessions();
          break;
        }

        commitThinkingAtTurnBoundary({
          tabId,
          msgUuid: logicalAssistantMessageId(msg),
          timestamp: Date.now(),
          subAgentDepth: agentDepth,
          stdinId: msgStdinId,
        });

        // Clear any remaining partial text before marking turn complete
        clearPartial();

        // A provider/model switch can reject old cryptographic thinking
        // signatures. Never "recover" by clearing the durable resume UUID and
        // silently opening a fresh thread: that makes the UI look successful
        // while discarding the exact context the user meant to continue.
        // Fail closed, preserve the thread identity, and return the unsent text
        // to the composer so the user can switch back and retry deliberately.
        if (msg.subtype !== 'success') {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          // Build a combined error string from all possible error fields
          const errorText = fgErrorText;
          const isThinkingSignatureError = /invalid.*signature.*thinking|thinking.*invalid.*signature/i.test(errorText);

          const switchedFlag = meta.providerSwitched || meta.modelSwitched;
          const pendingText = meta.providerSwitchPendingText || meta.modelSwitchPendingText;
          // Find last user message as fallback retry text when no pendingText is set
          const lastUserMsg = !pendingText
            ? [...(useChatStore.getState().getTab(tabId)?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content
            : undefined;
          const retryCandidate = pendingText || (typeof lastUserMsg === 'string' ? lastUserMsg : undefined);
          if (isThinkingSignatureError && retryCandidate) {
            const switchType = switchedFlag ? (meta.modelSwitched ? '模型' : 'API 配置') : '会话';
            console.warn(`[BLACKBOX] Thinking signature error after ${switchType} switch — preserving the original resume target`);
            const retryText = retryCandidate;

            // Stop only the failed process route. `sessionId` and the
            // sessionStore `cliResumeId` deliberately remain untouched.
            const failedStdinId = meta.stdinId;
            if (failedStdinId) {
              bridge.killSession(failedStdinId).catch(() => {});
              cleanupStdinRoute(failedStdinId);
            }

            setSessionMeta({
              stdinId: undefined,
              stdinReady: false,
              pendingReadyMessage: undefined,
              providerSwitched: false,
              providerSwitchPendingText: undefined,
              modelSwitched: false,
              modelSwitchPendingText: undefined,
              activeTurnInput: undefined,
              contextRecoveryAttempts: undefined,
              awaitingVisibleAssistantResponse: undefined,
              emptyTerminalRecoveryAfterCompact: undefined,
            });
            const currentDraft = useChatStore.getState().getTab(tabId)?.inputDraft.trim() || '';
            useChatStore.getState().setInputDraft(
              tabId,
              currentDraft ? `${currentDraft}\n\n${retryText}` : retryText,
            );
            if (useSessionStore.getState().selectedSessionId === tabId) {
              setInputSync(currentDraft ? `${currentDraft}\n\n${retryText}` : retryText);
            }
            setSessionStatus('error');
            setActivityStatus({ phase: 'error' });
            addMessage({
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: t('error.resumeSignatureMismatch').replace('{switch}', switchType),
              commandType: 'error',
              timestamp: Date.now(),
            });
            break;
          }
        }

        // Code mode: Auto-restart when ExitPlanMode caused CLI exit.
        // In stream-json mode, ExitPlanMode is treated as a permission denial,
        // causing the CLI to exit. Silently restart with --resume to continue.
        if (exitPlanModeSeenRef.current && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
            && msg.subtype !== 'success') {
          exitPlanModeSeenRef.current = false;
          console.log('[BLACKBOX] Code mode ExitPlanMode exit detected — auto-restarting with --resume');
          const oldStdinId = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
          void (async () => {
            if (oldStdinId) {
              try {
                await teardownSession(oldStdinId, tabId, 'plan-approve');
                await waitForStdinCleared(tabId, oldStdinId);
              } catch (err) {
                console.warn('[BLACKBOX] ExitPlanMode auto-restart teardown failed:', err);
                return;
              }
            }
            // Silently restart — no user message bubble
            silentRestartRef.current = true;
            setInputSync('Continue.');
            useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
            requestAnimationFrame(() => handleSubmitRef.current());
          })();
          break;
        }
        exitPlanModeSeenRef.current = false;

        // Mark pending processing card (CLI slash command) as completed
        const pendingCmdMsgId = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (pendingCmdMsgId) {
          const resultOutput = typeof msg.result === 'string' ? msg.result : '';
          useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
            commandCompleted: true,
            commandData: {
              ...(useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmdMsgId)?.commandData,
              output: resultOutput,
              completedAt: Date.now(),
            },
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // Extract result text for display (e.g., slash command output)
        let resultDisplayText = '';
        if (typeof msg.result === 'string' && msg.result) {
          resultDisplayText = sanitizeAssistantTextForDisplay(msg.result);
        } else if (typeof msg.content === 'string' && msg.content) {
          resultDisplayText = sanitizeAssistantTextForDisplay(msg.content);
        }

        const recoveryMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
        if (
          msgStdinId
          && shouldRetryContextDrop({
            prompt: recoveryMeta?.activeTurnInput,
            response: resultDisplayText,
            usage: msg.usage,
            subtype: msg.subtype,
            attempts: recoveryMeta?.contextRecoveryAttempts,
          })
        ) {
          const currentMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
          const greeting = [...currentMessages].reverse().find(
            (message) => message.role === 'assistant'
              && message.type === 'text'
              && isGenericContextGreeting(message.content),
          );
          if (greeting) useChatStore.getState().removeMessage(tabId, greeting.id);
          const retryPrompt = recoveryMeta!.activeTurnInput!;
          const retryStartedAt = Date.now();
          setSessionStatus('running');
          setActivityStatus({ phase: 'thinking' });
          setSessionMeta({
            contextRecoveryAttempts: (recoveryMeta?.contextRecoveryAttempts ?? 0) + 1,
            awaitingVisibleAssistantResponse: true,
            emptyTerminalRecoveryAfterCompact: false,
            turnStartTime: retryStartedAt,
            lastProgressAt: retryStartedAt,
            inputTokens: 0,
            outputTokens: 0,
            apiRetry: undefined,
          });
          console.warn('[BLACKBOX] Tiny zero-cache greeting detected; retrying the active turn once');
          bridge.sendStdin(msgStdinId, retryPrompt).catch((error) => {
            console.error('[BLACKBOX] Context-drop recovery retry failed:', error);
            const draft = useChatStore.getState().getTab(tabId)?.inputDraft.trim() || '';
            const restored = draft ? `${draft}\n\n${retryPrompt}` : retryPrompt;
            useChatStore.getState().setInputDraft(tabId, restored);
            if (useSessionStore.getState().selectedSessionId === tabId) {
              setInputSync(restored);
            }
            setSessionMeta({
              activeTurnInput: undefined,
              contextRecoveryAttempts: undefined,
              awaitingVisibleAssistantResponse: undefined,
              emptyTerminalRecoveryAfterCompact: undefined,
            });
            setSessionStatus('error');
            setActivityStatus({ phase: 'error' });
            addMessage({
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: '检测到会话上下文未载入，自动重试失败。原消息已放回输入框。',
              commandType: 'error',
              timestamp: Date.now(),
            });
          });
          break;
        }

        if (handleEmptyTerminalRecoveryResult({
          tabId,
          stdinId: msgStdinId,
          subtype: msg.subtype,
          resultDisplayText,
          usage: msg.usage,
        })) {
          break;
        }

        // If we have cost metadata AND a pending slash command (e.g., /compact, /cost),
        // inject cost summary into the processing card instead of creating a separate message.
        if (msg.total_cost_usd != null && pendingCmdMsgId) {
          const cost = msg.total_cost_usd?.toFixed(4) ?? '—';
          const duration = msg.duration_ms
            ? `${(msg.duration_ms / 1000).toFixed(1)}s`
            : '—';
          const turns = msg.num_turns ?? '—';
          const input = msg.usage?.input_tokens
            ? msg.usage.input_tokens.toLocaleString()
            : '';
          const output = msg.usage?.output_tokens
            ? msg.usage.output_tokens.toLocaleString()
            : '';
          const cmdMsg = (useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmdMsgId);
          if (cmdMsg) {
            useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
              commandData: {
                ...cmdMsg.commandData,
                costSummary: { cost, duration, turns, input, output },
              },
            });
          }
          // If there's also explicit result text, still add it as a message
          if (!resultDisplayText) resultDisplayText = '';
        }

        // Only add result text if it wasn't already delivered via an
        // 'assistant' event (which is the normal case for stream-json output)
        // AND there's no pending command card (which already displays the output).
        // S18: CLI-internal placeholders (e.g. "No response requested.") must
        // not surface to the user.
        if (resultDisplayText && !pendingCmdMsgId && !isCliPlaceholder(resultDisplayText)) {
          const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
          const isDuplicate = currentMessages.some(
            (m) => m.role === 'assistant' && m.type === 'text'
              && m.content === resultDisplayText,
          );
          if (!isDuplicate) {
            addMessage({
              id: msg.uuid || generateMessageId(),
              role: 'assistant',
              type: 'text',
              content: resultDisplayText,
              isFinalResponse: true,
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          }
        }

        setSessionStatus(
          msg.subtype === 'success' ? 'completed' : 'error'
        );

        // S11 (v3 §4.2): surface a visible error when the turn failed mid-way
        // (e.g. network drop, 500 from provider). Previously this was gated
        // behind `!hasAssistantReply`, so errors that arrived after partial
        // output were silently swallowed. Now we always annotate on failure,
        // with a de-dup guard so the retry/Stop paths don't double-post.
        if (msg.subtype !== 'success') {
          const errorText = fgErrorText;
          const isUserStop = /user[_ ]abort|interrupt|abort/i.test(errorText)
            || msg.subtype === 'user_abort'
            || fgWasStopping;
          const msgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
          const lastMsg = msgs[msgs.length - 1];
          const duplicate = lastMsg?.role === 'system'
            && (lastMsg.content === errorText || lastMsg.commandType === 'error');
          if (!duplicate) {
            addMessage({
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: isUserStop
                ? (t('error.userStopped') ?? '已手动停止')
                : formatErrorForUser(errorText || (t('error.turnFailed') ?? 'AI 响应异常中断')),
              commandType: 'error',
              timestamp: Date.now(),
            });
          }
        }

        {
          // Correct cumulative totals for any drift between streaming
          // accumulation and the authoritative result values.
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const resultInput = msg.usage?.input_tokens || 0;
          const resultOutput = msg.usage?.output_tokens || 0;
          const streamedInput = meta.inputTokens || 0;
          const streamedOutput = meta.outputTokens || 0;
          setSessionMeta({
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            turns: msg.num_turns,
            inputTokens: resultInput,
            outputTokens: resultOutput,
            totalInputTokens: (meta.totalInputTokens || 0) + (resultInput - streamedInput),
            totalOutputTokens: (meta.totalOutputTokens || 0) + (resultOutput - streamedOutput),
            turnStartTime: undefined,
            lastProgressAt: undefined,
            apiRetry: undefined,
            activeTurnInput: undefined,
            contextRecoveryAttempts: undefined,
            awaitingVisibleAssistantResponse: undefined,
            emptyTerminalRecoveryAfterCompact: undefined,
          });
        }
        agentActions.completeAll(
          msg.subtype === 'success' ? 'completed' : 'error',
          msg.subtype === 'success' && useSettingsStore.getState().agentTeamsEnabled,
          msg.subtype === 'success',
        );
        useSessionStore.getState().fetchSessions();
        setTimeout(() => useSessionStore.getState().fetchSessions(), 1000);

        // --- AI Title Generation (TK-001): on 3rd successful turn, generate a title ---
        if (msg.subtype === 'success') {
          const fallbackSessionId = useChatStore.getState().getTab(tabId)?.sessionMeta.sessionId;
          const sessionId = useSessionStore.getState().sessions.find((s) => s.id === tabId)?.cliResumeId
            ?? (fallbackSessionId && !fallbackSessionId.startsWith('desk_') ? fallbackSessionId : undefined);
          if (sessionId) {
            const customPreviews = useSessionStore.getState().customPreviews;
            if (!customPreviews[sessionId]) {
              const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
              const userTextMsgs = currentMessages.filter(
                (m) => m.role === 'user' && m.type === 'text' && m.content,
              );
              if (userTextMsgs.length >= 3) {
                const assistantTextMsgs = currentMessages.filter(
                  (m) => m.role === 'assistant' && m.type === 'text' && m.content,
                );
                if (assistantTextMsgs.length >= 3) {
                  const userMsg = userTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
                  const assistantMsg = assistantTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
                  generateSessionTitleWithPersistedProvider(userMsg, assistantMsg)
                    .then((title) => {
                      if (title) {
                        useSessionStore.getState().setCustomPreview(sessionId, title);
                      }
                    })
                    .catch((e) => {
                      if (!String(e).includes('SKIP:')) console.warn('Title gen failed:', e);
                    });
                }
              }
            }
          }
        }

        // --- Auto-compact: when input tokens exceed 80% of context window,
        // automatically send /compact to prevent context overflow on the next turn.
        // Fires at most once per session to avoid infinite loops.
        // Threshold is model-aware: 160K for 200K models, 800K for 1M models.
        const resultInputTokens = effectiveContextInputTokens(msg.usage);
        const compactStdinId = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
        const fgCompactThreshold = getAutoCompactThreshold(useChatStore.getState().getTab(tabId)?.sessionMeta.spawnedModel);
        if (resultInputTokens > fgCompactThreshold && !hasAutoCompactFired(tabId) && compactStdinId && msg.subtype === 'success') {
          markAutoCompactFired(tabId);
          console.log('[BLACKBOX] Auto-compact triggered: inputTokens =', resultInputTokens);
          const compactTab = useChatStore.getState().getTab(tabId);
          const queuedCompact = compactTab?.pendingUserMessages.find(
            (item) => item.kind === 'command' && item.text.trim().toLowerCase() === '/compact',
          );
          const compactMsgId = queuedCompact?.commandMessageId || generateMessageId();
          if (queuedCompact?.commandMessageId) {
            useChatStore.getState().removePendingCommand(tabId, queuedCompact.commandMessageId);
            const existing = useChatStore.getState().getTab(tabId)?.messages.find(
              (message) => message.id === compactMsgId,
            );
            useChatStore.getState().updateMessage(tabId, compactMsgId, {
              content: t('chat.autoCompacting'),
              commandStartTime: Date.now(),
              commandCompleted: false,
              commandData: { ...existing?.commandData, queued: false, automatic: true },
            });
          } else {
            addMessage({
              id: compactMsgId,
              role: 'system',
              type: 'text',
              content: t('chat.autoCompacting'),
              commandType: 'processing',
              commandData: { command: '/compact', automatic: true },
              commandStartTime: Date.now(),
              commandCompleted: false,
              timestamp: Date.now(),
            });
          }
          // FI-4: Register pendingCommandMsgId so result handler can mark it completed
          setSessionMeta({ pendingCommandMsgId: compactMsgId });
          setSessionStatus('running');
          setActivityStatus({ phase: 'thinking' });
          bridge.sendStdin(compactStdinId, '/compact').catch((err) => {
            console.error('[BLACKBOX] Auto-compact failed:', err);
            completePendingCommand(tabId, { output: 'Compact failed to start' });
            if (useChatStore.getState().getTab(tabId)?.sessionStatus === 'running') {
              useChatStore.getState().setSessionStatus(tabId, 'error');
            }
          });
          // A large compact may legitimately take longer than 15 seconds. Keep
          // the session busy and its stdin owned until a real assistant/result
          // or process_exit settles it; otherwise a concurrent send/reload can
          // race the CLI while it is rewriting context.
          setTimeout(() => {
            const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
            if (meta.pendingCommandMsgId === compactMsgId) {
              markPendingCommandSlow(tabId, compactMsgId, t('chat.compactStillRunning'));
            }
          }, 15_000);
          break; // Skip pending message flush — compact takes priority
        }

        {
          const drainTab = useChatStore.getState().getTab(tabId);
          const draftBeforeRestore = drainTab?.inputDraft ?? '';
          const attachmentsBeforeRestore = drainTab?.pendingAttachments ?? [];
          const prefixBeforeRestore = useCommandStore.getState().activePrefix;
          drainPendingQueueAfterSettlement({
            tabId,
            stdinId: drainTab?.sessionMeta.stdinId,
            wasStopping: fgWasStopping,
            onDraftRestored: useSessionStore.getState().selectedSessionId === tabId
              ? setInputSync
              : undefined,
            retryRestoredDraft: (
              useSessionStore.getState().selectedSessionId === tabId
              && draftBeforeRestore.trim().length === 0
              && attachmentsBeforeRestore.length === 0
              && !prefixBeforeRestore
            )
              ? () => requestAnimationFrame(() => handleSubmitRef.current())
              : undefined,
            onUserBatchSent: (text) => agentActions.resetForTurn(
              text.slice(0, 100),
              useSettingsStore.getState().agentTeamsEnabled,
            ),
          });
        }

        break;
      }

      case 'rate_limit_event': {
        const rli = msg.rate_limit_info;
        if (rli && rli.rateLimitType) {
          const prev = useChatStore.getState().getTab(tabId)?.sessionMeta.rateLimits || {};
          setSessionMeta({
            rateLimits: {
              ...prev,
              [rli.rateLimitType]: {
                rateLimitType: rli.rateLimitType,
                resetsAt: rli.resetsAt,
                isUsingOverage: rli.isUsingOverage,
                overageStatus: rli.overageStatus,
                overageDisabledReason: rli.overageDisabledReason,
              },
            },
          });
        }
        break;
      }

      case 'process_exit': {
        const exitingStdinId = msg.__stdinId;
        console.log('[BLACKBOX:session] process_exit received', { stdinId: exitingStdinId });

        // Ownership guard: verify this exit belongs to the current tab
        if (exitingStdinId) {
          const ownership = checkOwnership(exitingStdinId);
          if (!ownership.valid) {
            // Stale exit from old process — drop any leftover route and listeners
            cleanupStdinRoute(exitingStdinId);
            break;
          }
        }

        // If the session was running and no assistant messages were received,
        // the process failed at startup. Show the last stderr error.
        const exitTabData = useChatStore.getState().getTab(tabId);
        const exitStatus = exitTabData?.sessionStatus;
        if (exitStatus === 'running') {
          const exitMsgs = exitTabData?.messages ?? [];
          const hasAssistantReply = exitMsgs.some(
            (m: ChatMessage) => m.role === 'assistant' && (m.type === 'text' || m.type === 'tool_use'),
          );
          if (!hasAssistantReply) {
            if (lastStderrRef.current) {
              const stderr = lastStderrRef.current;
              const isTccError = /unexpected|operation not permitted|permission denied/i.test(stderr);
              const cwd = useSettingsStore.getState().workingDirectory || '';
              const isProtectedDir = /\/(Desktop|Downloads|Documents)\//i.test(cwd);
              const hint = isTccError && isProtectedDir
                ? '\n\n此目录可能受 macOS 隐私保护限制。请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中授权，或选择其他目录。'
                : '';
              addMessage({
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: formatErrorForUser(`CLI error: ${stderr}${hint}`),
                timestamp: Date.now(),
              });
            } else {
              addMessage({
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: t('error.cliExitedSilently'),
                timestamp: Date.now(),
              });
            }
          }
        }

        // Delegate full finalization to the lifecycle module (idempotent)
        if (exitingStdinId) {
          setSessionMeta({
            stdinReady: false,
            pendingReadyMessage: undefined,
          });
          handleProcessExitFinalize(exitingStdinId);
        } else {
          // Fallback: no stdinId on message, clear manually
          clearPartial();
          setSessionStatus('idle');
          setSessionMeta({
            stdinId: undefined,
            stdinReady: false,
            pendingReadyMessage: undefined,
            lastProgressAt: undefined,
            apiRetry: undefined,
            activeTurnInput: undefined,
            contextRecoveryAttempts: undefined,
            awaitingVisibleAssistantResponse: undefined,
            emptyTerminalRecoveryAfterCompact: undefined,
          });
        }

        // Desktop notification
        if (!document.hasFocus() && 'Notification' in window) {
          if (Notification.permission === 'granted') {
            new Notification(APP_NAME, { body: t('notification.chatComplete') });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission().then((perm) => {
              if (perm === 'granted') {
                new Notification(APP_NAME, { body: t('notification.chatComplete') });
              }
            }).catch(() => {});
          }
        }

        agentActions.completeAll();
        break;
      }

      default:
        // Fallback: handle content_block_delta at top level (without stream_event wrapper)
        if (msg.type === 'content_block_delta') {
          if (msg.delta?.type === 'text_delta') {
            const text = msg.delta?.text || '';
            if (text && msgStdinId) {
              if (isForwardedSubagentEvent(msg)) {
                agentActions.appendActivity(agentId, {
                  kind: 'text',
                  content: text,
                  append: true,
                });
                agentActions.updatePhase(agentId, 'writing');
              } else {
                streamController.appendText(msgStdinId, text);
              }
            }
          } else if (msg.delta?.type === 'thinking_delta') {
            const thinking = msg.delta?.thinking || '';
            if (thinking && msgStdinId && isForwardedSubagentEvent(msg)) {
              agentActions.updatePhase(agentId, 'thinking');
            } else if (thinking && msgStdinId && shouldRenderThinkingForTab(tabId)) {
              streamController.appendThinking(msgStdinId, thinking);
            } else if (thinking && msgStdinId) {
              streamController.clearThinking(msgStdinId);
            }
          }
        }
        break;
    }

    } catch (err) {
      // P1-4: catch-all for unexpected errors in stream message processing
      console.error('[BLACKBOX] handleStreamMessage error:', err, 'msg:', msg?.type, msg?.subtype);
      const errTabId = useSessionStore.getState().selectedSessionId;
      if (errTabId) {
        useChatStore.getState().addMessage(errTabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: formatErrorForUser(`Internal error processing stream message: ${err}`),
          timestamp: Date.now(),
        });
      }
    }
  }, [handleBackgroundStreamMessage, exitPlanModeSeenRef, silentRestartRef, handleSubmitRef, handleStderrLineRef, setInputSync]);

  return { handleStreamMessage, handleBackgroundStreamMessage };
}
