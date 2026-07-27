/**
 * useRewind — orchestration hook for the Rewind feature.
 * Manages turn parsing, kill-process, message truncation, code restore,
 * and summarization. Uses CLI native checkpoint system for file restoration.
 *
 * 5 actions after selecting a turn:
 *   1. Restore code and conversation — revert both
 *   2. Restore conversation only — keep code, rewind messages
 *   3. Restore code only — keep conversation, revert files
 *   4. Summarize from here — compress messages after selected point
 *   5. Cancel
 */
import { useMemo, useCallback } from 'react';
import { useChatStore, useActiveTab, generateMessageId, isSessionBusy } from '../stores/chatStore';
import type { TabSession } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { bridge } from '../lib/tauri-bridge';
import { parseTurns, type Turn } from '../lib/turns';
import { t } from '../lib/i18n';
import { teardownSession, waitForStdinCleared } from '../lib/sessionLifecycle';

export type RewindAction = 'restore_all' | 'restore_conversation' | 'restore_code' | 'summarize';

const rewindInFlightTabs = new Set<string>();

interface FileRestoreRequest {
  stdinId?: string;
  sessionId: string;
  checkpointUuid: string;
  cwd: string;
}

/** Resolve one immutable file-rewind request before process teardown. */
function resolveFileRestoreRequest(
  turn: Turn,
  tabId: string,
  tabState: TabSession,
): FileRestoreRequest | null {
  if (!turn.checkpointUuid) return null;

  const stdinId = tabState.sessionMeta.stdinId;
  const fallbackSessionId = tabState.sessionMeta.sessionId && !tabState.sessionMeta.sessionId.startsWith('desk_')
    ? tabState.sessionMeta.sessionId
    : undefined;
  // Use cliResumeId from sessionStore as the primary resume credential
  const sessionId = useSessionStore.getState().sessions
    .find((session) => session.id === tabId)?.cliResumeId ?? fallbackSessionId;
  // Use cwdSnapshot when available, fall back to global workingDirectory
  const cwd = tabState.sessionMeta.cwdSnapshot || useSettingsStore.getState().workingDirectory;
  if (!sessionId || !cwd) return null;
  return {
    stdinId,
    sessionId,
    checkpointUuid: turn.checkpointUuid,
    cwd,
  };
}

export function useRewind() {
  const messages = useActiveTab((t) => t.messages);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);

  const turns = useMemo(() => parseTurns(messages), [messages]);

  /** Button visible as long as there are user messages */
  const showRewind = turns.length >= 1;
  /** Button enabled when there is at least 1 turn and the session is not busy */
  const canRewind = turns.length >= 1 && !isSessionBusy(sessionStatus);

  /** Kill the current CLI process and clean up via lifecycle module */
  const killProcess = useCallback(async (tabId: string) => {
    const state = useChatStore.getState().getTab(tabId);
    if (!state) return;
    const stdinId = state.sessionMeta.stdinId;
    if (stdinId) {
      await teardownSession(stdinId, tabId, 'rewind');
      await waitForStdinCleared(tabId, stdinId);
    }
  }, []);

  /** Reset only the dead process route after rewind. The durable Claude UUID
   *  must stay attached: conversation rewind now atomically truncates the
   *  source JSONL, so the next --resume continues from that exact checkpoint. */
  const resetSession = useCallback((tabId: string) => {
    useChatStore.getState().setSessionStatus(tabId, 'idle');
    useChatStore.getState().setSessionMeta(tabId, {
      stdinId: undefined,
      stdinReady: false,
      pendingReadyMessage: undefined,
    });
  }, []);

  /** Save rewound state to tab cache */
  const saveToTab = useCallback((tabId: string) => {
    useChatStore.getState().saveToCache(tabId);
  }, []);

  /**
   * Execute rewind with a specific action.
   * All actions restore the user's original input text to the input box.
   */
  const executeRewind = useCallback(async (turn: Turn, action: RewindAction = 'restore_conversation') => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (!tid) return;
    if (rewindInFlightTabs.has(tid)) return;
    rewindInFlightTabs.add(tid);
    try {
    const state = useChatStore.getState().getTab(tid);
    if (!state) return;
    const sessionItem = useSessionStore.getState().sessions.find((session) => session.id === tid);
    const fallbackSessionId = state.sessionMeta.sessionId && !state.sessionMeta.sessionId.startsWith('desk_')
      ? state.sessionMeta.sessionId
      : undefined;
    const durableSessionId = sessionItem?.cliResumeId ?? fallbackSessionId;

    // Guard: validate turn index
    if (turn.startMsgIdx < 0 || turn.startMsgIdx > state.messages.length) {
      console.error('[useRewind] Invalid turn startMsgIdx:', turn.startMsgIdx);
      return;
    }

    // restore_code may use the live control protocol because it intentionally
    // keeps the conversation graph. restore_all is delegated after teardown to
    // one backend transaction that stages JSONL, rewinds files against the
    // still-complete graph, then atomically publishes the staged conversation.
    const needsFileRestore = action === 'restore_all' || action === 'restore_code';
    const fileRestoreRequest = needsFileRestore
      ? resolveFileRestoreRequest(turn, tid, state)
      : null;
    let fileRestoreOk = false;
    let needsStandaloneFileRestore = action === 'restore_code'
      && Boolean(fileRestoreRequest && !fileRestoreRequest.stdinId);
    if (action === 'restore_code' && fileRestoreRequest?.stdinId) {
      try {
        await bridge.rewindFilesViaControl(
          fileRestoreRequest.stdinId,
          fileRestoreRequest.checkpointUuid,
        );
        fileRestoreOk = true;
      } catch (error) {
        console.warn('[useRewind] live file rewind failed; deferring fallback until exit:', error);
        needsStandaloneFileRestore = true;
      }
    }

    // Kill CLI process after file restore (or immediately for non-file actions)
    try {
      await killProcess(tid);
    } catch (err) {
      console.warn('[useRewind] Failed to kill process:', err);
      return;
    }

    // Grab original text before truncating
    const originalUserText = state.messages[turn.startMsgIdx]?.content || '';

    // Conversation actions must update Claude's durable graph before the UI is
    // truncated. Otherwise the screen appears rewound while the next process
    // either sees the discarded turns or starts with no context at all.
    if (action === 'restore_all') {
      if (!durableSessionId || !fileRestoreRequest) {
        resetSession(tid);
        useChatStore.getState().addMessage(tid, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: t('rewind.conversationRestoreFailed'),
          commandType: 'error',
          timestamp: Date.now(),
        });
        return;
      }
      try {
        await bridge.rewindAllTransaction(
          durableSessionId,
          fileRestoreRequest.checkpointUuid,
          fileRestoreRequest.cwd,
        );
        fileRestoreOk = true;
      } catch (error) {
        console.error('[useRewind] combined file/conversation rewind failed:', error);
        resetSession(tid);
        useChatStore.getState().addMessage(tid, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: `${t('rewind.conversationRestoreFailed')}: ${String(error)}`,
          commandType: 'error',
          timestamp: Date.now(),
        });
        return;
      }
    } else if (action === 'restore_conversation' || action === 'summarize') {
      const conversationCheckpoint = turn.checkpointUuid ?? turn.userMessageId;
      if (!durableSessionId) {
        resetSession(tid);
        useChatStore.getState().addMessage(tid, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: t('rewind.conversationRestoreFailed'),
          commandType: 'error',
          timestamp: Date.now(),
        });
        return;
      }
      try {
        await bridge.rewindSessionConversation(durableSessionId, conversationCheckpoint);
      } catch (error) {
        console.error('[useRewind] durable conversation rewind failed:', error);
        resetSession(tid);
        useChatStore.getState().addMessage(tid, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: `${t('rewind.conversationRestoreFailed')}: ${String(error)}`,
          commandType: 'error',
          timestamp: Date.now(),
        });
        return;
      }
    }

    if (needsStandaloneFileRestore && fileRestoreRequest) {
      try {
        await bridge.rewindFilesStandalone(
          fileRestoreRequest.sessionId,
          fileRestoreRequest.checkpointUuid,
          fileRestoreRequest.cwd,
        );
        fileRestoreOk = true;
      } catch (error) {
        console.error('[useRewind] standalone file rewind failed after confirmed exit:', error);
      }
    }

    try {
      switch (action) {
        case 'restore_all': {
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession(tid);
          useChatStore.getState().setInputDraft(tid, originalUserText);

          const successMsg = fileRestoreOk
            ? t('rewind.successAll').replace('{n}', String(turn.index))
            : t('rewind.successAllNoFiles').replace('{n}', String(turn.index));
          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: successMsg,
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'restore_all' },
            timestamp: Date.now(),
          });
          break;
        }

        case 'restore_conversation': {
          // Only restore conversation (keep code as-is) — instant, no CLI call
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession(tid);
          useChatStore.getState().setInputDraft(tid, originalUserText);

          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: t('rewind.success').replace('{n}', String(turn.index)),
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'restore_conversation' },
            timestamp: Date.now(),
          });
          break;
        }

        case 'restore_code': {
          // Don't truncate messages — keep full conversation
          resetSession(tid);
          useChatStore.getState().setInputDraft(tid, originalUserText);

          const codeMsg = fileRestoreOk
            ? t('rewind.successCode').replace('{n}', String(turn.index))
            : t('rewind.codeRestoreFailed');
          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: codeMsg,
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'restore_code' },
            timestamp: Date.now(),
          });
          break;
        }

        case 'summarize': {
          // Compress messages from this turn onwards into a summary.
          // Messages before the selected turn stay intact (full detail).
          const msgsToSummarize = state.messages.slice(turn.startMsgIdx);
          const summaryParts: string[] = [];

          for (const m of msgsToSummarize) {
            if (m.role === 'user' && m.content) {
              summaryParts.push(`**User:** ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`);
            } else if (m.role === 'assistant' && m.type === 'text' && m.content) {
              summaryParts.push(`**Claude:** ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`);
            } else if (m.type === 'tool_use' && m.toolName) {
              const fp = m.toolInput?.file_path || m.toolInput?.command || '';
              summaryParts.push(`**${m.toolName}:** ${String(fp).slice(0, 100)}`);
            }
          }

          // Truncate to selected point
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession(tid);

          // The durable JSONL has already been rewound above. Put the locally
          // generated summary in the composer so the user can review and send
          // it as the next real turn; never pretend a UI-only card is CLI context.
          const totalTurns = turns.length;
          const summaryHeader = t('rewind.summaryTitle')
            .replace('{from}', String(turn.index))
            .replace('{to}', String(totalTurns));
          const summaryContent = `**${summaryHeader}**\n\n${summaryParts.join('\n\n')}`;
          useChatStore.getState().setInputDraft(tid, summaryContent);

          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: summaryContent,
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'summarize' },
            timestamp: Date.now(),
          });
          break;
        }
      }
    } catch (err) {
      console.error('[useRewind] executeRewind failed:', err);
      // Ensure we're in a recoverable state even if rewind failed
      resetSession(tid);
    }

    // Save to cache
    saveToTab(tid);
    } finally {
      rewindInFlightTabs.delete(tid);
    }
  }, [killProcess, resetSession, saveToTab, turns.length]);

  return { turns, showRewind, canRewind, executeRewind };
}
