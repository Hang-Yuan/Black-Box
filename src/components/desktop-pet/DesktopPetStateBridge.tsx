import { useEffect, useMemo, useRef } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkflowStore } from '../../stores/workflowStore';
import {
  DESKTOP_PET_STATE_EVENT,
  DESKTOP_PET_STATE_REQUEST_EVENT,
  deriveDesktopPetState,
  type DesktopPetState,
} from '../../lib/desktop-pet';

const PET_WINDOW_LABEL = 'desktop-pet';

function sendState(state: DesktopPetState): void {
  void emitTo(PET_WINDOW_LABEL, DESKTOP_PET_STATE_EVENT, state).catch(() => {
    // The companion is optional, so a missing window is an expected state.
  });
}

/**
 * Lives only in the main WebView and forwards existing store evidence to the
 * isolated companion WebView. It never starts work or creates a task.
 */
export function DesktopPetStateBridge() {
  const tabs = useChatStore((state) => state.tabs);
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId);
  const agents = useAgentStore((state) => state.agents);
  const liveRuns = useWorkflowStore((state) => state.liveRuns);

  const state = useMemo<DesktopPetState>(() => ({
    ...deriveDesktopPetState({
      tabs: Array.from(tabs.values()).map((tab) => ({
        id: tab.tabId,
        selected: tab.tabId === selectedSessionId,
        sessionStatus: tab.sessionStatus,
        activityPhase: tab.activityStatus.phase,
        toolName: tab.activityStatus.toolName,
      })),
      agents: Array.from(agents.values()).map((agent) => ({
        id: agent.id,
        phase: agent.phase,
        currentTool: agent.currentTool,
        isMain: agent.isMain,
      })),
      workflows: Object.values(liveRuns).flatMap((runs) => runs.map((run) => ({
        tabId: run.tabId,
        workflowName: run.workflowName,
        status: run.status,
      }))),
    }),
    updatedAt: Date.now(),
  }), [agents, liveRuns, selectedSessionId, tabs]);

  const latestRef = useRef(state);
  latestRef.current = state;

  useEffect(() => {
    sendState(state);
  }, [state]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(DESKTOP_PET_STATE_REQUEST_EVENT, () => {
      sendState(latestRef.current);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
