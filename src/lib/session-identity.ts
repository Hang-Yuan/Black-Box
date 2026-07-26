import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAgentStore } from '../stores/agentStore';
import { usePlanStore } from '../stores/planStore';
import { useForkStore } from '../stores/forkStore';
import { useWorkflowStore } from '../stores/workflowStore';
import { useComposerModeStore } from '../stores/composerModeStore';
import { useLoopStore } from '../stores/loopStore';

/**
 * Adopt Claude Code's durable session UUID as the single Black Box thread key.
 *
 * A new conversation starts under draft_* while the CLI boots. The first
 * system:init/assistant event can arrive after the user switches tabs, so this
 * operation must be safe from both foreground and background stream routes and
 * from the spawn completion path. It is intentionally idempotent.
 */
export function adoptCliSessionIdentity(
  currentTabId: string,
  cliSessionId: string,
  stdinId?: string,
): string {
  const durableId = cliSessionId.trim();
  if (!durableId) return currentTabId;

  const sessions = useSessionStore.getState();
  sessions.setCliResumeId(currentTabId, durableId);

  if (!currentTabId.startsWith('draft_')) {
    useChatStore.getState().setSessionMeta(currentTabId, { sessionId: durableId });
    return currentTabId;
  }

  const chat = useChatStore.getState();
  const draftTab = chat.getTab(currentTabId);
  if (draftTab) {
    const nextTabs = new Map(chat.tabs);
    const existing = nextTabs.get(durableId);
    nextTabs.set(durableId, {
      ...existing,
      ...draftTab,
      tabId: durableId,
      sessionMeta: {
        ...existing?.sessionMeta,
        ...draftTab.sessionMeta,
        sessionId: durableId,
        forkSourceId: undefined,
      },
    });
    nextTabs.delete(currentTabId);
    useChatStore.setState({ tabs: nextTabs, sessionCache: nextTabs });
  }

  sessions.promoteDraft(currentTabId, durableId);
  if (stdinId && sessions.getTabForStdin(stdinId) !== durableId) {
    sessions.registerStdinTab(stdinId, durableId);
  }
  useAgentStore.getState().moveCache(currentTabId, durableId);
  usePlanStore.getState().movePlan(currentTabId, durableId);
  useForkStore.getState().moveFork(currentTabId, durableId);
  useWorkflowStore.getState().moveRuns(currentTabId, durableId);
  useLoopStore.getState().moveJobs(currentTabId, durableId);
  useComposerModeStore.getState().moveTab(currentTabId, durableId);
  useChatStore.getState().setSessionMeta(durableId, {
    sessionId: durableId,
    forkSourceId: undefined,
  });
  return durableId;
}
