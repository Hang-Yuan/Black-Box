import { useCallback, useState } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useFileStore } from '../stores/fileStore';
import { useForkStore } from '../stores/forkStore';
import { useGroupStore } from '../stores/groupStore';
import { useSessionStore } from '../stores/sessionStore';
import { mapSessionModeToPermissionMode, useSettingsStore } from '../stores/settingsStore';
import {
  flushAndCaptureSpawnConfiguration,
  getSpawnConfigurationErrorMessage,
} from '../lib/api-provider';
import { materializeHistoricalFork } from '../lib/historical-fork';
import { bridge } from '../lib/tauri-bridge';
import { t } from '../lib/i18n';
import type { Turn } from '../lib/turns';

export function useHistoricalFork() {
  const [isForking, setIsForking] = useState(false);

  const forkFromTurn = useCallback(async (turn: Turn): Promise<string> => {
    if (isForking) throw new Error(t('conv.forkAlreadyRunning'));
    const parentListId = useSessionStore.getState().selectedSessionId;
    if (!parentListId) throw new Error(t('conv.forkMissingSource'));
    if (!turn.checkpointUuid) throw new Error(t('rewind.forkNoCheckpoint'));

    const source = useSessionStore.getState().sessions.find((session) => session.id === parentListId);
    const tab = useChatStore.getState().getTab(parentListId);
    const fallbackSessionId = tab?.sessionMeta.sessionId
      && !tab.sessionMeta.sessionId.startsWith('desk_')
      ? tab.sessionMeta.sessionId
      : undefined;
    const parentSessionId = source?.cliResumeId ?? fallbackSessionId;
    const cwd = tab?.sessionMeta.cwdSnapshot
      || source?.project
      || source?.projectDir
      || useSettingsStore.getState().workingDirectory;
    if (!source?.path || !parentSessionId || !cwd) {
      throw new Error(t('conv.forkMissingSource'));
    }

    const originalTurnText = tab?.messages[turn.startMsgIdx]?.content || turn.userContent;
    const parentTitle = useSessionStore.getState().getDisplayName(source)
      || source.preview
      || parentSessionId.slice(0, 8);
    const config = await flushAndCaptureSpawnConfiguration();
    if (!config.ok) {
      throw new Error(getSpawnConfigurationErrorMessage(config, t));
    }

    setIsForking(true);
    try {
      try {
        const location = await bridge.getTaskLocation(parentSessionId, cwd);
        if (location.currentLocation === 'worktree') {
          throw new Error(t('conv.forkWorktreeBlocked'));
        }
      } catch (error) {
        if (error instanceof Error && error.message === t('conv.forkWorktreeBlocked')) throw error;
        // Non-Git sessions do not have a task-location record and remain safe
        // to fork because this operation only changes the child conversation.
      }

      const result = await materializeHistoricalFork({
        parentSessionId,
        checkpointUuid: turn.checkpointUuid,
        cwd,
        model: config.model,
        auxiliaryModel: config.auxiliaryModel,
        auxiliaryModelTier: config.auxiliaryModelTier,
        providerId: config.providerId || undefined,
        thinkingLevel: config.thinkingLevel,
        permissionMode: mapSessionModeToPermissionMode(useSettingsStore.getState().sessionMode),
        agentTeamsEnabled: config.agentTeamsEnabled,
      });

      useForkStore.getState().registerFork({
        childThreadId: result.childSessionId,
        parentThreadId: parentSessionId,
        parentTitle,
        cwd,
        createdAt: Date.now(),
        forkPoint: 'checkpoint',
        checkpointUuid: turn.checkpointUuid,
        checkpointTurnIndex: turn.index,
        checkpointPreview: originalTurnText,
      });

      const sessionState = useSessionStore.getState();
      await sessionState.fetchSessions();
      sessionState.setCustomPreview(
        result.childSessionId,
        `${parentTitle} · ${t('conv.forkAtTurn').replace('{n}', String(turn.index))}`,
      );
      const parentGroup = useGroupStore.getState().getGroupOfSession(parentListId);
      if (parentGroup) {
        useGroupStore.getState().addToGroup(result.childSessionId, parentGroup.id);
      }

      useSettingsStore.getState().setWorkingDirectory(cwd);
      useSettingsStore.getState().setMainView('chat');
      useFileStore.getState().closePreview();
      useForkStore.getState().closeComparison();
      window.dispatchEvent(new CustomEvent('blackbox:open-session', {
        detail: { sessionId: result.childSessionId, draftText: originalTurnText },
      }));
      return result.childSessionId;
    } finally {
      setIsForking(false);
    }
  }, [isForking]);

  return { forkFromTurn, isForking };
}
