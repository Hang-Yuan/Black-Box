import { create } from 'zustand';
import { useSessionStore } from './sessionStore';
import type { ApiRetryStatus } from '../lib/api-retry';
import type { FileAttachment } from '../hooks/useFileAttachments';
import { sanitizeAssistantTextForDisplay } from '../lib/presentation-sanitizer';
import type { PermissionUpdate } from '../lib/permission-suggestions';

// --- Types ---

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface MessageAttachment {
  name: string;
  path: string;
  isImage: boolean;
  preview?: string;  // base64 data URL (thumbnail)
}

export type InteractionState = 'pending' | 'sending' | 'resolved' | 'failed' | 'expired';

export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  toolUseId?: string;
  permissionSuggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  decisionReasonType?: string;
  classifierApprovable?: boolean;
  title?: string;
  displayName?: string;
  requiresUserInteraction?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  type: 'text' | 'tool_use' | 'thinking' | 'tool_result' | 'permission' | 'plan' | 'plan_review' | 'question' | 'todo';
  content: string;
  toolName?: string;
  toolInput?: any;
  toolResult?: string;
  toolResultContent?: string;      // tool result content merged from tool_result stream events
  toolCompleted?: boolean;         // tool finished even if it produced no visible result text
  isPartial?: boolean;
  timestamp: number;
  // Interactive message fields
  permissionTool?: string;         // tool requesting permission
  permissionDescription?: string;  // what the tool wants to do
  resolved?: boolean;              // whether the user responded
  // SDK control protocol permission data (Phase 2)
  interactionState?: InteractionState;
  interactionError?: string;
  permissionData?: PermissionRequestData;
  planItems?: string[];            // plan steps
  planContent?: string;            // markdown content for plan_review
  // AskUserQuestion fields
  questions?: UserQuestion[];      // question data from AskUserQuestion tool
  // TodoWrite fields
  todoItems?: TodoItem[];          // todo list items
  // File attachments (user-sent images/files)
  attachments?: MessageAttachment[];
  // Command feedback fields (for system messages from slash commands)
  commandType?: 'mode' | 'model-switch' | 'info' | 'help' | 'action' | 'error' | 'processing';
  commandData?: Record<string, any>;
  // Command processing card fields
  commandStartTime?: number;
  commandCompleted?: boolean;
  // Sub-agent nesting depth (0 = main agent, 1+ = inside Task sub-agent)
  subAgentDepth?: number;
  // CLI checkpoint UUID for file restoration (from --replay-user-messages)
  checkpointUuid?: string;
  /** Guidance injected into the currently running Claude turn through
   * streaming input. It does not start a separate Goal turn. */
  isSteer?: boolean;
  steerState?: 'sending' | 'sent';
  /** AskUserQuestion / permission owner — the (tabId, stdinId) that created this card.
   *  Phase 4 §5.3 (S3): QuestionCard answers must flow to the spawning tab/stdin,
   *  NOT getActiveTabState (which is wrong after the user switches tabs). */
  owner?: {
    tabId: string;
    stdinId: string;
  };
}

export interface SessionMeta {
  model?: string;
  cost?: number;
  duration?: number;
  turns?: number;
  /** @deprecated Use stdinId (for process routing) and cliResumeId in sessionStore (for resume).
   *  This field may temporarily hold desk_* or CLI UUID; prefer the dedicated fields. */
  sessionId?: string;
  /** The desk-generated ID used as key in Rust StdinManager for sending follow-up messages */
  stdinId?: string;
  /** True only after system:init confirms the stdin process finished startup and
   *  can safely accept follow-up sendStdin writes (including pre-warm reuse). */
  stdinReady?: boolean;
  /** Disk transcript hydration is an exclusive phase: no send/resume may
   * start until the matching generation has finished applying messages. */
  hydratingFromDisk?: boolean;
  hydrationGeneration?: string;
  /** User text captured while a pre-warmed stdin exists but has not emitted
   *  system:init yet. Flushed exactly once when that same stdin becomes ready. */
  pendingReadyMessage?: {
    stdinId: string;
    text: string;
  };
  /** Snapshot of the working directory at session spawn time — used by Rewind and
   *  other features that need the original cwd rather than the current global value */
  cwdSnapshot?: string;
  /** Snapshot of config at session spawn time — used for config-mismatch detection */
  configSnapshot?: {
    model: string;
    auxiliaryModel: string;
    providerId: string;
    thinkingLevel: string;
    permissionMode: string;
    agentTeamsEnabled: boolean;
  };
  /** Message ID of a pending processing card (for CLI slash commands) */
  pendingCommandMsgId?: string;
  /** Accumulated input tokens from stream events (message_start) — per turn, reset each turn */
  inputTokens?: number;
  /** Accumulated output tokens from stream events (message_delta) — per turn, reset each turn */
  outputTokens?: number;
  /** Cumulative input tokens across ALL turns in this session/task */
  totalInputTokens?: number;
  /** Cumulative output tokens across ALL turns in this session/task */
  totalOutputTokens?: number;
  /** Timestamp (Date.now()) when the current turn started — used for elapsed timer */
  turnStartTime?: number;
  /** Timestamp of last stream activity — used for stall detection instead of total elapsed */
  lastProgressAt?: number;
  /** Latest API retry event for this turn, such as provider 429/backoff state. */
  apiRetry?: ApiRetryStatus;
  /** JSON fingerprint of the active provider config used when spawning the CLI process.
   *  Compared before sending via stdin to detect stale pre-warm sessions. */
  envFingerprint?: string;
  /** Stable hash of spawn-time CLI dimensions (provider + model +
   *  thinkingLevel + Agent Teams opt-in + provider.updatedAt). Compared in
   *  handleSubmit to detect config drift that requires kill + respawn. */
  spawnConfigHash?: string;
  /** True after the CLI has emitted assistant-side stream evidence for the
   *  current turn. This may be true even when thinking is hidden by settings. */
  turnAcceptedForResume?: boolean;
  /** Source Claude thread for a pending fork draft. Cleared as soon as the
   *  CLI emits the independently allocated child UUID. */
  forkSourceId?: string;
  /** Snapshot of sessionMode at session spawn — per-session isolation (Phase 4) */
  snapshotMode?: import('./settingsStore').SessionMode;
  /** Snapshot of selectedModel at session spawn — per-session isolation (Phase 4) */
  snapshotModel?: string;
  /** Snapshot of thinkingLevel at session spawn — per-session isolation (Phase 4) */
  snapshotThinking?: import('./settingsStore').ThinkingLevel;
  /** Snapshot of active provider ID at session spawn — per-tab provider isolation */
  snapshotProviderId?: string | null;
  /** The resolved model name used when spawning the CLI process.
   *  Compared before sending via stdin to detect mid-session model switches. */
  spawnedModel?: string;
  /** Set when API provider config changed mid-session (TK-303).
   *  A signature mismatch must fail closed without clearing the resume UUID. */
  providerSwitched?: boolean;
  /** The user message text to re-send if provider-switch auto-retry triggers. */
  providerSwitchPendingText?: string;
  /** Set when model changed mid-session.
   *  A signature mismatch returns the pending text to the composer. */
  modelSwitched?: boolean;
  /** The user message text to re-send if model-switch auto-retry triggers. */
  modelSwitchPendingText?: string;
  /** Explicit teardown intent for the current shutdown path.
   *  Used to distinguish user Stop from switch/delete/rewind finalization. */
  teardownReason?: 'stop' | 'rewind' | 'plan-approve' | 'delete' | 'switch';
  /** The latest user turn has been rendered locally but the model has not yet
   *  emitted any stream event acknowledging it. Used so Stop can retract and
   *  merge that turn back into the next draft instead of leaving a ghost bubble. */
  pendingTurnMessageId?: string;
  pendingTurnInput?: string;
  pendingTurnAttachments?: FileAttachment[];
  /** Partial assistant正文 that was visible when the user clicked Stop.
   *  Claude CLI resume does not always include interrupted assistant output,
   *  so the next user turn may need this text injected once for continuity. */
  interruptedAssistantText?: string;
  /** Rate limit info from CLI rate_limit_event (latest per rateLimitType) */
  rateLimits?: Record<string, {
    rateLimitType: string;
    resetsAt: number;
    isUsingOverage?: boolean;
    overageStatus?: string;
    overageDisabledReason?: string;
  }>;
}

/**
 * Session lifecycle state.
 *
 * 'reconnecting' is an intermediate state entered when attempting to
 * recover a stalled stream. During reconnecting we keep the UI's
 * partialText visible (unlike terminal states) and attempt a --resume
 * to recover without user intervention.
 *
 * 'stopping' is entered when the user clicks Stop or when the lifecycle
 * module initiates a teardown (kill + wait for process_exit). During
 * stopping we keep partialText visible and show a loading indicator.
 * The process_exit handler transitions to a terminal state.
 *
 * 'stopped' is the terminal state after an explicit user stop (vs
 * 'completed' for natural turn completion or 'error' for failures).
 */
export type SessionStatus = 'idle' | 'running' | 'reconnecting' | 'stopping' | 'stopped' | 'completed' | 'error';

export function isSessionBusy(status: SessionStatus | undefined): boolean {
  return status === 'running' || status === 'reconnecting' || status === 'stopping';
}

export type ActivityPhase = 'idle' | 'thinking' | 'writing' | 'tool' | 'awaiting' | 'completed' | 'error' | 'reconnecting';

/**
 * Metadata-only reason a live tab is blocked on user input.
 *
 * Keep this deliberately narrower than ChatMessage: the global activity
 * projection may read this field without hydrating or inspecting conversation
 * bodies. Question text, permission input, and plan content stay exclusively
 * on their interactive message cards.
 */
export type WaitingForInteraction = 'question' | 'permission' | 'plan_review';

export interface ActivityStatus {
  phase: ActivityPhase;
  toolName?: string;  // only when phase === 'tool'
}

// --- Per-session snapshot (backward compat type — kept for external consumers) ---

/**
 * A single item in the per-tab pending queue. Phase 2 §6 adds `enqueueConfigHash`
 * + `enqueueStdinId` so the drain path can detect config drift (provider / model /
 * thinking change) that happened after the message was queued and backfill to
 * inputDraft instead of sending on a stale process.
 */
export interface PendingUserMessage {
  text: string;
  /** Commands are serialized through the same FIFO but are never merged into
   * a user turn. Each receives its own processing-card lifecycle. */
  kind?: 'user' | 'command' | 'steer';
  commandMessageId?: string;
  /** spawnConfigHash() snapshot captured when the message was enqueued. */
  enqueueConfigHash?: string;
  /** stdinId of the CLI process the user was talking to at enqueue time. */
  enqueueStdinId?: string;
  /** Timestamp of enqueue (Date.now()). */
  enqueueAt?: number;
}

export interface SessionSnapshot {
  messages: ChatMessage[];
  isStreaming: boolean;
  partialText: string;
  partialThinking: string;
  sessionStatus: SessionStatus;
  sessionMeta: SessionMeta;
  activityStatus: ActivityStatus;
  waitingFor?: WaitingForInteraction;
  inputDraft: string;
  pendingAttachments: FileAttachment[];
  /** User messages queued while AI is actively processing (not yet sent to stdin) */
  pendingUserMessages: PendingUserMessage[];
}

// --- Tab session: the ONLY place session data lives ---

export interface TabSession {
  tabId: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  partialText: string;
  partialThinking: string;
  sessionStatus: SessionStatus;
  sessionMeta: SessionMeta;
  activityStatus: ActivityStatus;
  /** Live, metadata-only interaction kind; never restored from transcript text. */
  waitingFor?: WaitingForInteraction;
  inputDraft: string;
  pendingAttachments: FileAttachment[];
  pendingUserMessages: PendingUserMessage[];
  /** Timestamp of last access for true LRU eviction */
  lastAccessedAt: number;
}

// --- Store State & Actions ---

interface ChatState {
  /** All tab data — the ONLY place session data lives */
  tabs: Map<string, TabSession>;

  // --- Tab-level operations (all take tabId) ---
  addMessage: (tabId: string, message: ChatMessage) => void;
  removeMessage: (tabId: string, id: string) => void;
  updateMessage: (tabId: string, id: string, updates: Partial<ChatMessage>) => void;
  updatePartialMessage: (tabId: string, text: string) => void;
  updatePartialThinking: (tabId: string, text: string) => void;
  setSessionStatus: (tabId: string, status: SessionStatus) => void;
  setActivityStatus: (tabId: string, status: ActivityStatus) => void;
  /** Clear messages and UI state but PRESERVE sessionMeta (for session reload) */
  clearMessages: (tabId: string) => void;
  /** Full reset: clear everything including sessionMeta (for new session / /clear) */
  resetTab: (tabId: string) => void;
  setSessionMeta: (tabId: string, meta: Partial<SessionMeta>) => void;
  setInputDraft: (tabId: string, text: string) => void;
  setPendingAttachments: (tabId: string, files: FileAttachment[]) => void;
  /** Enqueue a user message captured while the AI is mid-turn. Accepts the
   *  optional spawnConfigHash + stdinId at enqueue time so the drain path
   *  can detect config drift (Phase 2 §6). */
  addPendingMessage: (
    tabId: string,
    text: string,
    meta?: {
      enqueueConfigHash?: string;
      enqueueStdinId?: string;
      kind?: 'user' | 'command' | 'steer';
      commandMessageId?: string;
    },
  ) => void;
  /** Take startup-gated steers for this exact live stdin route. */
  takePendingSteers: (tabId: string, stdinId: string) => PendingUserMessage[];
  /** Dequeue the first pending message (FIFO). Returns undefined if empty. */
  shiftPendingMessage: (tabId: string) => PendingUserMessage | undefined;
  /** Remove one queued command by its stable processing-card id. */
  removePendingCommand: (tabId: string, commandMessageId: string) => PendingUserMessage | undefined;
  flushPendingMessages: (tabId: string) => PendingUserMessage[];
  clearPendingMessages: (tabId: string) => void;
  restorePendingQueueToDraft: (tabId: string) => void;
  rewindToTurn: (tabId: string, startMsgIdx: number) => void;
  setInteractionState: (tabId: string, msgId: string, state: InteractionState, error?: string) => void;
  getActiveInteraction: (tabId: string) => ChatMessage | undefined;

  // --- Tab lifecycle ---
  ensureTab: (tabId: string) => void;
  removeTab: (tabId: string) => void;
  getTab: (tabId: string) => TabSession | undefined;

  // --- Backward compat: sessionCache alias + *InCache methods ---
  /** @deprecated Alias for tabs. Kept for gradual migration. */
  sessionCache: Map<string, SessionSnapshot>;
  /** @deprecated Data already lives in tabs. Kept for call sites that save before switching. */
  saveToCache: (tabId: string) => void;
  /** @deprecated Just checks tab existence. Kept for backward compat. */
  restoreFromCache: (tabId: string) => boolean;
  removeFromCache: (tabId: string) => void;
  hasCachedSession: (tabId: string) => boolean;
  /** @deprecated Use addMessage(tabId, message) directly. */
  addMessageToCache: (tabId: string, message: ChatMessage) => void;
  /** @deprecated Use updatePartialMessage(tabId, text) directly. */
  updatePartialInCache: (tabId: string, text: string) => void;
  /** @deprecated Use updatePartialThinking(tabId, thinking) directly. */
  updatePartialThinkingInCache: (tabId: string, thinking: string) => void;
  /** @deprecated Use setSessionStatus(tabId, status) directly. */
  setStatusInCache: (tabId: string, status: SessionStatus) => void;
  /** @deprecated Use setSessionMeta(tabId, meta) directly. */
  setMetaInCache: (tabId: string, meta: Partial<SessionMeta>) => void;
  /** @deprecated Use setActivityStatus(tabId, status) directly. */
  setActivityInCache: (tabId: string, status: ActivityStatus) => void;
  /** @deprecated Use updateMessage(tabId, msgId, updates) directly. */
  updateMessageInCache: (tabId: string, msgId: string, updates: Partial<ChatMessage>) => void;
}

// --- Helpers ---

let messageCounter = 0;

export function generateMessageId(): string {
  messageCounter += 1;
  return `msg_${Date.now()}_${messageCounter}`;
}

let interruptedCounter = 0;

/** Unique ID for interrupted-content messages (thinking/text preserved on stop/exit).
 *  Date.now() alone collides under high-concurrency interrupts (#B5). */
export function generateInterruptedId(kind: 'thinking' | 'text'): string {
  interruptedCounter += 1;
  return `interrupted_${kind}_${Date.now()}_${interruptedCounter}`;
}

/** Default empty tab for when no tab is selected */
const EMPTY_TAB: TabSession = {
  tabId: '',
  messages: [],
  isStreaming: false,
  partialText: '',
  partialThinking: '',
  sessionStatus: 'idle',
  sessionMeta: {},
  activityStatus: { phase: 'idle' },
  waitingFor: undefined,
  inputDraft: '',
  pendingAttachments: [],
  pendingUserMessages: [],
  lastAccessedAt: 0,
};

function createTab(tabId: string): TabSession {
  return { ...EMPTY_TAB, tabId, lastAccessedAt: Date.now() };
}

interface ComposerSnapshot {
  inputDraft?: string;
  pendingAttachments?: FileAttachment[];
}

let liveComposerSnapshotProvider: ((tabId: string) => ComposerSnapshot | null) | null = null;

/** InputBar registers a live snapshot getter so saveToCache can flush the
 *  currently mounted editor before ChatPanel remounts on tab switch. */
export function registerLiveComposerSnapshotProvider(
  provider: ((tabId: string) => ComposerSnapshot | null) | null,
): void {
  liveComposerSnapshotProvider = provider;
}

/** Maximum number of tabs kept in memory. LRU eviction applies to idle tabs. */
const MAX_CACHE = 8;

function hasLiveStdinBinding(tabId: string, stdinId?: string): boolean {
  if (!stdinId) return false;
  return useSessionStore.getState().getTabForStdin(stdinId) === tabId;
}

/**
 * Immutable Map update helper: get tab, apply updater, return new Map.
 * Returns undefined if the tab is missing or the updater returns the existing
 * tab object. Callers must return their current Zustand state to make that a
 * true no-op; returning `{}` still creates a new root object and notifies every
 * subscriber.
 */
function updateTab(
  tabs: Map<string, TabSession>,
  tabId: string,
  updater: (tab: TabSession) => TabSession,
): { tabs: Map<string, TabSession>; sessionCache: Map<string, TabSession> } | undefined {
  const tab = tabs.get(tabId);
  if (!tab) return undefined;
  const updated = updater(tab);
  // Zustand notifies every subscriber when the root object changes. Let
  // targeted setters return the current tab for a semantic no-op so editor
  // bridges cannot turn a same-value write into a React update loop.
  if (updated === tab) return undefined;
  const newTabs = new Map(tabs);
  newTabs.set(tabId, updated);
  return { tabs: newTabs, sessionCache: newTabs };
}

function sameAttachments(
  current: readonly FileAttachment[],
  next: readonly FileAttachment[],
): boolean {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  return current.every((file, index) => {
    const candidate = next[index];
    return file.id === candidate.id
      && file.name === candidate.name
      && file.path === candidate.path
      && file.size === candidate.size
      && file.type === candidate.type
      && file.isImage === candidate.isImage
      && file.preview === candidate.preview;
  });
}

function waitingForMessage(message: ChatMessage): WaitingForInteraction | undefined {
  // `sending` means the user has already responded. A failed send remains
  // cleared until the card explicitly returns to `pending` for retry.
  const isPending = !message.resolved
    && (message.interactionState === undefined || message.interactionState === 'pending');
  if (!isPending) return undefined;
  if (message.type === 'question') return 'question';
  if (message.type === 'permission') return 'permission';
  if (message.type === 'plan_review') return 'plan_review';
  return undefined;
}

/** Derive only the interaction kind; never copy content/tool input into tab metadata. */
function deriveWaitingFor(messages: readonly ChatMessage[]): WaitingForInteraction | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const waitingFor = waitingForMessage(messages[index]);
    if (waitingFor) return waitingFor;
  }
  return undefined;
}

function deriveLiveWaitingFor(
  status: SessionStatus,
  messages: readonly ChatMessage[],
): WaitingForInteraction | undefined {
  return status === 'running' || status === 'reconnecting'
    ? deriveWaitingFor(messages)
    : undefined;
}

// --- Selector helpers ---

/**
 * React hook: select a field from the active tab.
 * Usage: `useActiveTab(t => t.messages)`
 */
export function useActiveTab<T>(selector: (tab: TabSession) => T): T {
  return useChatStore((state) => {
    const tabId = useSessionStore.getState().selectedSessionId;
    const tab = tabId ? state.tabs.get(tabId) : undefined;
    return selector(tab ?? EMPTY_TAB);
  });
}

/**
 * Imperative: get active tab data (for non-React contexts).
 */
export function getActiveTabState(): TabSession {
  const tabId = useSessionStore.getState().selectedSessionId;
  const tab = tabId ? useChatStore.getState().tabs.get(tabId) : undefined;
  return tab ?? EMPTY_TAB;
}

// --- Store ---

export const useChatStore = create<ChatState>()((set, get) => ({
  tabs: new Map(),
  sessionCache: new Map(),   // alias — always kept in sync with tabs

  // ------------------------------------------------------------------
  // Tab-level operations
  // ------------------------------------------------------------------

  addMessage: (tabId, message) =>
    set((state) => {
      const displayMessage = message.role === 'assistant' && message.type === 'text'
        ? { ...message, content: sanitizeAssistantTextForDisplay(message.content) }
        : message;
      const result = updateTab(state.tabs, tabId, (tab) => {
        // De-duplicate: if a message with the same ID already exists, update it
        // instead of appending a duplicate. This happens when the CLI re-sends
        // a complete assistant message that was previously delivered partially.
        const existingIdx = tab.messages.findIndex((m) => m.id === displayMessage.id);
        const messages = existingIdx !== -1
          ? tab.messages.map((m, i) => i === existingIdx ? { ...m, ...displayMessage } : m)
          : [...tab.messages, displayMessage];
        return { ...tab, messages, waitingFor: deriveLiveWaitingFor(tab.sessionStatus, messages) };
        // NOTE: partialText/isStreaming are NOT cleared here. Clearing is handled
        // explicitly by clearPartial() in the result/process_exit handlers and
        // in the assistant message handler when a text block supersedes streaming.
      });
      return result ?? state;
    }),

  removeMessage: (tabId, id) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        const messages = tab.messages.filter((m) => m.id !== id);
        return { ...tab, messages, waitingFor: deriveLiveWaitingFor(tab.sessionStatus, messages) };
      });
      return result ?? state;
    }),

  updateMessage: (tabId, id, updates) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        const messages = tab.messages.map((m) =>
          m.id === id ? { ...m, ...updates } : m,
        );
        return { ...tab, messages, waitingFor: deriveLiveWaitingFor(tab.sessionStatus, messages) };
      });
      return result ?? state;
    }),

  updatePartialMessage: (tabId, text) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        partialText: sanitizeAssistantTextForDisplay(tab.partialText + text),
        isStreaming: true,
        activityStatus: { phase: 'writing' as ActivityPhase },
      }));
      return result ?? state;
    }),

  updatePartialThinking: (tabId, text) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        partialThinking: tab.partialThinking + text,
        isStreaming: true,
        activityStatus:
          tab.activityStatus.phase === 'tool'
            || tab.activityStatus.phase === 'awaiting'
            || tab.activityStatus.phase === 'writing'
            ? tab.activityStatus
            : tab.partialText.length > 0
              ? { phase: 'writing' as ActivityPhase }
              : { phase: 'thinking' as ActivityPhase },
      }));
      return result ?? state;
    }),

  setSessionStatus: (tabId, status) => {
    // Sync running state to sessionStore for tab indicators.
    // 'reconnecting' counts as running for sidebar indicator purposes
    // (the tab is still actively doing something — recovering).
    // 'stopping' does NOT count as running — the session is winding down.
    useSessionStore.getState().setSessionRunning(
      tabId,
      status === 'running' || status === 'reconnecting',
    );
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        sessionStatus: status,
        // Reset streaming state when session reaches a terminal state.
        // IMPORTANT: do NOT reset on 'reconnecting' or 'stopping' — we keep
        // partialText visible so the user sees prior content while we
        // re-establish or wait for process_exit.
        ...(status === 'completed' || status === 'error' || status === 'idle' || status === 'stopped'
          ? {
            isStreaming: false,
            partialText: '',
            partialThinking: '',
            sessionMeta: { ...tab.sessionMeta, apiRetry: undefined },
          }
          : {}),
        // Sync activity status with session status
        ...(status === 'completed' ? { activityStatus: { phase: 'completed' as ActivityPhase } }
          : status === 'error' ? { activityStatus: { phase: 'error' as ActivityPhase } }
          : status === 'idle' ? { activityStatus: { phase: 'idle' as ActivityPhase } }
          : status === 'stopped' ? { activityStatus: { phase: 'completed' as ActivityPhase } }
          : status === 'reconnecting' ? { activityStatus: { phase: 'reconnecting' as ActivityPhase } }
          : {}),
        // A terminal state or explicit teardown cannot still be waiting for a
        // card response. `running`/`reconnecting` preserve a real live card.
        waitingFor: deriveLiveWaitingFor(status, tab.messages),
      }));
      return result ?? state;
    });
  },

  setActivityStatus: (tabId, status) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        activityStatus: status,
      }));
      return result ?? state;
    }),

  clearMessages: (tabId) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        messages: [],
        isStreaming: false,
        partialText: '',
        partialThinking: '',
        sessionStatus: 'idle',
        // Preserve sessionMeta (especially sessionId for resume)
        activityStatus: { phase: 'idle' },
        waitingFor: undefined,
        inputDraft: '',
        pendingAttachments: [],
        pendingUserMessages: [],
      }));
      return result ?? state;
    }),

  resetTab: (tabId) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, () => createTab(tabId));
      return result ?? state;
    }),

  setSessionMeta: (tabId, meta) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        sessionMeta: { ...tab.sessionMeta, ...meta },
      }));
      return result ?? state;
    }),

  setInputDraft: (tabId, text) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => (
        tab.inputDraft === text
          ? tab
          : { ...tab, inputDraft: text }
      ));
      return result ?? state;
    }),

  setPendingAttachments: (tabId, files) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => (
        sameAttachments(tab.pendingAttachments, files)
          ? tab
          : { ...tab, pendingAttachments: files }
      ));
      return result ?? state;
    }),

  addPendingMessage: (tabId, text, meta) =>
    set((state) => {
      const item: PendingUserMessage = {
        text,
        kind: meta?.kind ?? 'user',
        commandMessageId: meta?.commandMessageId,
        enqueueConfigHash: meta?.enqueueConfigHash,
        enqueueStdinId: meta?.enqueueStdinId,
        enqueueAt: Date.now(),
      };
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        pendingUserMessages: [...tab.pendingUserMessages, item],
      }));
      return result ?? state;
    }),

  shiftPendingMessage: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab || tab.pendingUserMessages.length === 0) return undefined;
    const first = tab.pendingUserMessages[0];
    set((state) => {
      const r = updateTab(state.tabs, tabId, (t) => ({
        ...t,
        pendingUserMessages: t.pendingUserMessages.slice(1),
      }));
      return r ?? {};
    });
    return first;
  },

  removePendingCommand: (tabId, commandMessageId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return undefined;
    const index = tab.pendingUserMessages.findIndex(
      (item) => item.kind === 'command' && item.commandMessageId === commandMessageId,
    );
    if (index < 0) return undefined;
    const item = tab.pendingUserMessages[index];
    set((state) => {
      const result = updateTab(state.tabs, tabId, (current) => ({
        ...current,
        pendingUserMessages: current.pendingUserMessages.filter((_, itemIndex) => itemIndex !== index),
      }));
      return result ?? state;
    });
    return item;
  },

  takePendingSteers: (tabId, stdinId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return [];
    const steers = tab.pendingUserMessages.filter(
      (item) => item.kind === 'steer' && item.enqueueStdinId === stdinId,
    );
    if (steers.length === 0) return [];
    set((state) => {
      const result = updateTab(state.tabs, tabId, (current) => ({
        ...current,
        pendingUserMessages: current.pendingUserMessages.filter(
          (item) => !(item.kind === 'steer' && item.enqueueStdinId === stdinId),
        ),
      }));
      return result ?? state;
    });
    return steers;
  },

  flushPendingMessages: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return [];
    const msgs = tab.pendingUserMessages;
    set((state) => {
      const r = updateTab(state.tabs, tabId, (t) => ({
        ...t,
        pendingUserMessages: [],
      }));
      return r ?? {};
    });
    return msgs;
  },

  clearPendingMessages: (tabId) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        pendingUserMessages: [],
      }));
      return result ?? state;
    }),

  restorePendingQueueToDraft: (tabId) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab || tab.pendingUserMessages.length === 0) return {};
      const restoredText = tab.pendingUserMessages
        .map((item) => item.text)
        .filter((item) => item.trim().length > 0)
        .join('\n\n');
      const nextDraft = [tab.inputDraft, restoredText]
        .filter((item) => item.trim().length > 0)
        .join('\n\n');
      const result = updateTab(state.tabs, tabId, (currentTab) => ({
        ...currentTab,
        inputDraft: nextDraft,
        pendingUserMessages: [],
      }));
      return result ?? state;
    }),

  rewindToTurn: (tabId, startMsgIdx) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        // Guard against invalid index — if out of bounds, keep messages intact
        if (startMsgIdx < 0 || startMsgIdx > tab.messages.length) {
          console.warn('[chatStore] rewindToTurn: invalid index', startMsgIdx, 'total:', tab.messages.length);
          return {
            ...tab,
            isStreaming: false,
            partialText: '',
            partialThinking: '',
            activityStatus: { phase: 'idle' as ActivityPhase },
            waitingFor: undefined,
          };
        }
        const messages = tab.messages.slice(0, startMsgIdx);
        return {
          ...tab,
          messages,
          isStreaming: false,
          partialText: '',
          partialThinking: '',
          // Keep sessionMeta (sessionId needed for resume), reset transient state
          activityStatus: { phase: 'idle' as ActivityPhase },
          waitingFor: undefined,
        };
      });
      return result ?? state;
    }),

  setInteractionState: (tabId, msgId, interactionState, error) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        const messages = tab.messages.map((m) =>
          m.id === msgId ? {
            ...m,
            interactionState,
            interactionError: error,
            resolved: interactionState === 'resolved',
          } : m,
        );
        return { ...tab, messages, waitingFor: deriveLiveWaitingFor(tab.sessionStatus, messages) };
      });
      return result ?? state;
    }),

  getActiveInteraction: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return undefined;
    // Return the last message with an active (pending) interaction
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if ((m.type === 'permission' || m.type === 'question') && m.interactionState === 'pending') {
        return m;
      }
    }
    return undefined;
  },

  // ------------------------------------------------------------------
  // Tab lifecycle
  // ------------------------------------------------------------------

  ensureTab: (tabId) => {
    if (get().tabs.has(tabId)) {
      // Touch lastAccessedAt on access
      const existingTab = get().tabs.get(tabId);
      if (existingTab) {
        const newTabs = new Map(get().tabs);
        newTabs.set(tabId, { ...existingTab, lastAccessedAt: Date.now() });
        set({ tabs: newTabs, sessionCache: newTabs });
      }
      return;
    }
    const newTabs = new Map(get().tabs);
    newTabs.set(tabId, createTab(tabId));
    // True LRU eviction — keep at most MAX_CACHE tabs.
    // Sort candidates by lastAccessedAt ascending, evict the least recently accessed.
    // Never evict tabs that are actively streaming, still busy, or still own a
    // live stdin route (pre-warm sessions stay idle but the process is alive).
    if (newTabs.size > MAX_CACHE) {
      const candidates = Array.from(newTabs.entries())
        .filter(([id, entry]) => {
          if (id === tabId) return false; // don't evict the tab we're creating
          if (entry.isStreaming) return false; // protect streaming tabs
          if (isSessionBusy(entry.sessionStatus)) return false;
          if (hasLiveStdinBinding(id, entry.sessionMeta.stdinId)) return false;
          if (entry.inputDraft.trim().length > 0) return false;
          if (entry.pendingAttachments.length > 0) return false;
          if (entry.pendingUserMessages.length > 0) return false;
          // Undelivered stream content not yet finalized into messages —
          // evicting here would silently drop it (#86).
          if (entry.partialText || entry.partialThinking) return false;
          return true;
        })
        .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt); // oldest first

      let idx = 0;
      while (newTabs.size > MAX_CACHE && idx < candidates.length) {
        newTabs.delete(candidates[idx][0]);
        idx++;
      }
      // If all candidates are protected, allow cache to exceed MAX_CACHE
    }
    set({ tabs: newTabs, sessionCache: newTabs });
  },

  removeTab: (tabId) => {
    const newTabs = new Map(get().tabs);
    newTabs.delete(tabId);
    set({ tabs: newTabs, sessionCache: newTabs });
  },

  getTab: (tabId) => get().tabs.get(tabId),

  // ------------------------------------------------------------------
  // Backward compat: sessionCache + *InCache methods
  // ------------------------------------------------------------------

  saveToCache: (tabId) => {
    get().ensureTab(tabId);
    const liveSnapshot = liveComposerSnapshotProvider?.(tabId);
    if (!liveSnapshot) return;
    if (liveSnapshot.inputDraft !== undefined) {
      get().setInputDraft(tabId, liveSnapshot.inputDraft);
    }
    if (liveSnapshot.pendingAttachments !== undefined) {
      get().setPendingAttachments(tabId, liveSnapshot.pendingAttachments);
    }
  },

  restoreFromCache: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return false;
    const restoredAt = Date.now();
    // #27/#30 safety net: if tab has zero messages but this is a persisted session
    // (has a disk path), treat as cache miss so the caller falls back to disk load.
    // S9 (v3 §5.9 path 3): keep the tab when an unsent draft exists — discarding
    // it would lose the user's in-progress message when they tab back.
    const hasHistory = tab.messages.length > 0;
    const hasPartials = tab.isStreaming || Boolean(tab.partialText || tab.partialThinking);
    const hasDraft = tab.inputDraft.trim().length > 0;
    const hasPendingAttachments = tab.pendingAttachments.length > 0;
    const hasPendingMessages = tab.pendingUserMessages.length > 0;
    if (
      !hasHistory
      && !hasPartials
      && !hasDraft
      && !hasPendingAttachments
      && !hasPendingMessages
    ) {
      const session = useSessionStore.getState().sessions.find((s) => s.id === tabId);
      if (session?.path) {
        const newTabs = new Map(get().tabs);
        newTabs.delete(tabId);
        set({ tabs: newTabs, sessionCache: newTabs });
        return false;
      }
    }
    // `waitingFor` is live process metadata, not durable transcript state.
    // Preserve it only when this tab still owns the stdin that created the
    // interaction; cache/disk restores must not resurrect stale waiting cards.
    if (tab.waitingFor && !hasLiveStdinBinding(tabId, tab.sessionMeta.stdinId)) {
      set((state) => {
        const result = updateTab(state.tabs, tabId, (current) => ({
          ...current,
          waitingFor: undefined,
        }));
        return result ?? state;
      });
    }
    // TK-329: Validate stdinId ownership — prevent cross-tab contamination
    if (tab.sessionMeta.stdinId) {
      const ownerTab = useSessionStore.getState().getTabForStdin(tab.sessionMeta.stdinId);
      if (ownerTab && ownerTab !== tabId) {
        // Fix: strip stdinId that belongs to another tab
        set((state) => {
          const result = updateTab(state.tabs, tabId, (t) => ({
            ...t,
            sessionMeta: {
              ...t.sessionMeta,
              stdinId: undefined,
              stdinReady: false,
              pendingReadyMessage: undefined,
            },
          }));
          return result ?? state;
        });
      }
    }
    // B11: cached status may say 'running'/'reconnecting'/'stopping' but the process is gone
    // (e.g. app restart, or ProcessExit handler was bypassed for this tab).
    // Live processes here are tracked by stdinId; if the tab has no stdinId bound,
    // treat the cache as stale and demote to 'idle' so the sidebar red dot clears.
    const cachedActive = isSessionBusy(tab.sessionStatus);
    if (cachedActive) {
      const hasStdinId = Boolean(get().tabs.get(tabId)?.sessionMeta.stdinId);
      if (!hasStdinId) {
        set((state) => {
          const result = updateTab(state.tabs, tabId, (t) => ({
            ...t,
            sessionStatus: 'idle',
            isStreaming: false,
            partialText: '',
            partialThinking: '',
            lastAccessedAt: restoredAt,
          }));
          return result ?? state;
        });
        useSessionStore.getState().setSessionRunning(tabId, false);
        return true;
      }
    }
    // Touch LRU timestamp so restored tabs are not immediately evicted (F7 fix)
    set((state) => {
      const result = updateTab(state.tabs, tabId, (t) => ({
        ...t,
        lastAccessedAt: restoredAt,
      }));
      return result ?? state;
    });
    // Sync running state to sessionStore for sidebar indicator (FI-1 fix)
    useSessionStore.getState().setSessionRunning(tabId, tab.sessionStatus === 'running');
    return true;
  },

  removeFromCache: (tabId) => {
    get().removeTab(tabId);
  },

  hasCachedSession: (tabId) => get().tabs.has(tabId),

  // *InCache methods — delegate directly to tab-level methods

  addMessageToCache: (tabId, message) => {
    // #27/#30 fix: skip if no tab entry — creating a tab with only this single
    // message risks losing real history if the entry was LRU-evicted.
    if (!get().tabs.has(tabId)) return;
    get().addMessage(tabId, message);
  },

  updatePartialInCache: (tabId, text) => {
    if (!get().tabs.has(tabId)) return;
    get().updatePartialMessage(tabId, text);
  },

  updatePartialThinkingInCache: (tabId, thinking) => {
    if (!get().tabs.has(tabId)) return;
    get().updatePartialThinking(tabId, thinking);
  },

  setStatusInCache: (tabId, status) => {
    // Always sync running state indicator, even without a tab
    useSessionStore.getState().setSessionRunning(tabId, status === 'running');
    if (!get().tabs.has(tabId)) return;
    get().setSessionStatus(tabId, status);
  },

  setMetaInCache: (tabId, meta) => {
    if (!get().tabs.has(tabId)) return;
    get().setSessionMeta(tabId, meta);
  },

  setActivityInCache: (tabId, status) => {
    if (!get().tabs.has(tabId)) return;
    get().setActivityStatus(tabId, status);
  },

  updateMessageInCache: (tabId, msgId, updates) => {
    if (!get().tabs.has(tabId)) return;
    get().updateMessage(tabId, msgId, updates);
  },
}));
