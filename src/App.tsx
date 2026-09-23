import { restoreUpdateDrafts } from './stores/appUpdateStore';
import { useEffect, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { SecondaryPanel } from './components/layout/SecondaryPanel';
import { CommandPalette } from './components/commands/CommandPalette';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { ExtensionCenter } from './components/extensions/ExtensionCenter';
import { AutomationCenter } from './components/automations/AutomationCenter';
import { AutomationSessionMonitor } from './components/automations/AutomationSessionMonitor';
import { LiveSessionTranscriptMonitor } from './components/chat/LiveSessionTranscriptMonitor';
import { TaskCenterView } from './components/activity/TaskCenterView';
import { ImageLightbox } from './components/shared/ImageLightbox';
import { ChangelogModal } from './components/shared/ChangelogModal';
import { Toast } from './components/shared/Toast';
import { useSettingsStore } from './stores/settingsStore';
import { useProviderStore, type ApiProvider } from './stores/providerStore';
import {
  restoreConversationFileState,
  resetConversationFileState,
  saveConversationFileState,
  useFileStore,
} from './stores/fileStore';
import { useChatStore } from './stores/chatStore';
import { useSessionStore } from './stores/sessionStore';
import { useAgentStore } from './stores/agentStore';
import { usePlanStore } from './stores/planStore';
import { useForkStore } from './stores/forkStore';
import { useReviewStore } from './stores/reviewStore';
import { useWorkflowStore } from './stores/workflowStore';
import { bridge, onFileChange } from './lib/tauri-bridge';
import { buildNativeWorkflowCommand } from './lib/native-workflow';
import { parseSessionMessages } from './lib/session-loader';
import {
  settleOrphanedBackendProcesses,
  startWarmBackendProcessReaper,
  startSessionHealthObserver,
  teardownTabBackendProcesses,
  teardownSession,
  waitForStdinCleared,
} from './lib/sessionLifecycle';
import { useT } from './lib/i18n';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { applyAppearanceClasses } from './lib/appearance';
import {
  forgetConversationRuntimePreference,
  restoreConversationRuntimePreference,
} from './lib/conversation-runtime-preferences';
import './App.css';

function App() {
  useEffect(() => { restoreUpdateDrafts(); return startSessionHealthObserver(); }, []);
  const theme = useSettingsStore((s) => s.theme);
  const colorTheme = useSettingsStore((s) => s.colorTheme);
  const surfaceTheme = useSettingsStore((s) => s.surfaceTheme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const keepSystemAwake = useSettingsStore((s) => s.keepSystemAwake);
  const keepDisplayAwake = useSettingsStore((s) => s.keepDisplayAwake);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const mainView = useSettingsStore((s) => s.mainView);
  const secondaryPanelOpen = useSettingsStore((s) => s.secondaryPanelOpen);
  const secondaryPanelTab = useSettingsStore((s) => s.secondaryPanelTab);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const lastSeenVersion = useSettingsStore((s) => s.lastSeenVersion);
  const setLastSeenVersion = useSettingsStore((s) => s.setLastSeenVersion);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const loadTree = useFileStore((s) => s.loadTree);
  const refreshChangedPaths = useFileStore((s) => s.refreshChangedPaths);
  const markFileChanged = useFileStore((s) => s.markFileChanged);
  const fileTreeActive = mainView === 'chat'
    && secondaryPanelOpen
    && secondaryPanelTab === 'files';

  const t = useT();

  // Rust acquires the default system-wake assertion during native setup so
  // there is no launch gap. Once persisted settings hydrate, this effect
  // reconciles both assertions with the user's actual choices.
  useEffect(() => {
    let cancelled = false;
    const publish = (detail: Record<string, unknown>) => {
      if (!cancelled) {
        window.dispatchEvent(new CustomEvent('blackbox:power-assertion-status', { detail }));
      }
    };
    bridge.setPowerAssertion(keepSystemAwake, keepDisplayAwake)
      .then((status) => publish(status as unknown as Record<string, unknown>))
      .catch(async (error) => {
        console.warn('[BLACKBOX] Failed to update macOS power assertion:', error);
        try {
          const status = await bridge.getPowerAssertionStatus();
          publish({ ...status, error: String(error) });
        } catch (statusError) {
          publish({ error: `${String(error)}; ${String(statusError)}` });
        }
      });
    return () => { cancelled = true; };
  }, [keepDisplayAwake, keepSystemAwake]);

  useEffect(() => {
    void useWorkflowStore.getState().loadRuns();
  }, []);

  // CLI update detection: check on startup + poll every 30 minutes
  useEffect(() => {
    const checkCliUpdate = () => {
      bridge.checkCliUpdate().then((result) => {
        useSettingsStore.setState({
          cliUpdateAvailable: result.update_available,
          cliLatestVersion: result.latest ?? '',
        });
      }).catch(() => {}); // silently ignore
    };
    checkCliUpdate();
    const interval = setInterval(checkCliUpdate, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Test harness helpers (dev builds only). The Rust socket server can receive
  // ping by itself, but page commands need the webview listeners and this
  // app-specific helper surface.
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    // React StrictMode mounts effects twice in development. The MCP listener
    // registration is process-global and has no matching unsubscribe, so a
    // second registration answers one socket request twice and panics Tauri's
    // one-shot response handler.
    if (!(window as any).__blackbox_mcp_listeners_started) {
      (window as any).__blackbox_mcp_listeners_started = true;
      import('tauri-plugin-mcp').then(({ setupPluginListeners }) => {
        setupPluginListeners();
      }).catch((error) => {
        (window as any).__blackbox_mcp_listeners_started = false;
        console.warn('[BLACKBOX] Failed to init MCP plugin listeners:', error);
      });
    }

    (window as any).__blackbox_test = {
      scenarioStores: { chat: useChatStore, sessions: useSessionStore, settings: useSettingsStore, files: useFileStore },
      getMessages(optsOrTabId?: string | { tabId?: string; last?: number; summary?: boolean }) {
        const opts = typeof optsOrTabId === 'string' ? { tabId: optsOrTabId } : (optsOrTabId || {});
        const id = opts.tabId || useSessionStore.getState().selectedSessionId;
        if (!id) return { messages: [], total: 0 };
        const tab = useChatStore.getState().tabs.get(id);
        const all = tab?.messages || [];
        const total = all.length;
        const messages = opts.last != null ? all.slice(-opts.last) : all;
        if (opts.summary) {
          return {
            messages: messages.map((message: any) => ({
              id: message.id,
              role: message.role,
              type: message.type,
              toolName: message.toolName || undefined,
              content: message.type === 'tool_result'
                ? `[tool_result: ${(message.content || '').slice(0, 80)}...]`
                : message.type === 'thinking'
                  ? '[thinking]'
                  : (message.content || '').slice(0, 150),
              subAgentDepth: message.subAgentDepth,
              timestamp: message.timestamp,
            })),
            total,
          };
        }
        return { messages, total };
      },
      getLastMessage(tabId?: string) {
        const { messages } = (window as any).__blackbox_test.getMessages({ tabId, last: 1 });
        return messages[0] || null;
      },
      getActiveSessionId() {
        return useSessionStore.getState().selectedSessionId;
      },
      getAllSessions() {
        return useSessionStore.getState().sessions;
      },
      getCurrentModel() {
        return useSettingsStore.getState().selectedModel;
      },
      getCurrentAuxiliaryModel() {
        return useSettingsStore.getState().auxiliaryModel;
      },
      getCurrentMode() {
        return useSettingsStore.getState().sessionMode;
      },
      getCurrentProvider() {
        return useProviderStore.getState().activeProviderId;
      },
      getProviderState() {
        const state = useProviderStore.getState();
        return {
          loaded: state.loaded,
          defaultApi: state.defaultApi,
          defaultMainModel: state.defaultMainModel,
          defaultAuxiliaryModel: state.defaultAuxiliaryModel,
          activeProviderId: state.activeProviderId,
          providers: state.providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            apiFormat: provider.apiFormat,
            authScheme: provider.authScheme || null,
            preset: provider.preset || null,
            extraEnv: provider.extraEnv || {},
            credentialRef: provider.credentialRef || null,
            credentialHint: provider.credentialHint || null,
            credentialState: provider.credentialState || null,
            revision: provider.revision || 0,
            modelMappings: provider.modelMappings,
            createdAt: provider.createdAt,
            updatedAt: provider.updatedAt,
          })),
        };
      },
      updateProvider(providerId: string, patch: Partial<ApiProvider>) {
        const store = useProviderStore.getState();
        if (!store.providers.some((provider) => provider.id === providerId)) {
          return { error: `Provider ${providerId} not found` };
        }
        store.updateProvider(providerId, patch);
        const provider = useProviderStore.getState().providers.find((entry) => entry.id === providerId);
        return {
          providerId,
          revision: provider?.revision || 0,
          updatedAt: provider?.updatedAt || 0,
          dirtyCredentialSupplied: typeof patch.apiKey === 'string' && patch.apiKey.length > 0,
        };
      },
      /** Dev-only native lifecycle probes. These deliberately bypass chat UI
       *  state so smoke tests can verify Claude's own fork persistence before
       *  Black Box adds lineage or hydration behavior around it. */
      startRawSession(params: Parameters<typeof bridge.startSession>[0]) {
        return bridge.startSession(params);
      },
      sendRawSessionInput(stdinId: string, message: string) {
        return bridge.sendStdin(stdinId, message);
      },
      gracefulStopRawSession(stdinId: string) {
        return bridge.gracefulStopSession(stdinId);
      },
      rewindRawConversation(sessionId: string, checkpointUuid: string) {
        return bridge.rewindSessionConversation(sessionId, checkpointUuid);
      },
      refreshSessionIndex() {
        return useSessionStore.getState().fetchSessions();
      },
      getCurrentPlan() {
        const tabId = useSessionStore.getState().selectedSessionId;
        return tabId ? usePlanStore.getState().plans[tabId] || null : null;
      },
      getCurrentFork() {
        const tabId = useSessionStore.getState().selectedSessionId;
        return tabId ? useForkStore.getState().forks[tabId] || null : null;
      },
      listWorkflows() {
        const cwd = useSettingsStore.getState().workingDirectory;
        return bridge.listWorkflows(cwd || undefined);
      },
      saveWorkflow(request: Parameters<typeof bridge.saveWorkflow>[0]) {
        return useWorkflowStore.getState().saveWorkflow(request);
      },
      getWorkflowRuns(tabId?: string) {
        const id = tabId || useSessionStore.getState().selectedSessionId;
        return id ? useWorkflowStore.getState().liveRuns[id] || [] : [];
      },
      openWorkflows() {
        useSettingsStore.getState().setMainView('extensions');
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('blackbox:extension-section', {
          detail: { section: 'workflows' },
        })));
        return { view: 'extensions', section: 'workflows' };
      },
      async runWorkflow(name: string, args = '') {
        const tabId = useSessionStore.getState().selectedSessionId;
        if (!tabId) throw new Error('No active task for Workflow run');
        const cwd = useSettingsStore.getState().workingDirectory;
        const workflows = await bridge.listWorkflows(cwd || undefined);
        const workflow = workflows.find((item) => item.name === name && item.valid);
        if (!workflow) throw new Error(`Valid Workflow ${name} not found`);
        useWorkflowStore.getState().requestRun(tabId, workflow);
        useWorkflowStore.getState().queueSubmission(
          tabId,
          workflow.name,
          buildNativeWorkflowCommand(workflow.name, args),
        );
        useSettingsStore.getState().setMainView('chat');
        return { tabId, workflow: workflow.name, queued: true };
      },
      listActiveProcesses() {
        return bridge.listActiveProcesses();
      },
      killProcess(stdinId: string) {
        return bridge.killSession(stdinId);
      },
      getTaskLocation() {
        const state = useSessionStore.getState();
        const id = state.selectedSessionId;
        const session = state.sessions.find((item) => item.id === id);
        const cliSessionId = session?.cliResumeId || id;
        const cwd = useSettingsStore.getState().workingDirectory;
        if (!cliSessionId || !cwd) return Promise.reject(new Error('No active task location'));
        return bridge.getTaskLocation(cliSessionId, cwd);
      },
      async handoffTask(destination: 'local' | 'worktree') {
        const state = useSessionStore.getState();
        const id = state.selectedSessionId;
        const session = state.sessions.find((item) => item.id === id);
        const cliSessionId = session?.cliResumeId || id;
        const cwd = useSettingsStore.getState().workingDirectory;
        if (!id || !cliSessionId || !cwd) throw new Error('No active task location');
        const stdinId = useChatStore.getState().tabs.get(id)?.sessionMeta.stdinId;
        if (stdinId) {
          await teardownSession(stdinId, id, 'switch');
          await waitForStdinCleared(id, stdinId);
        }
        const result = await bridge.handoffTask(cliSessionId, cwd, destination);
        useSessionStore.getState().updateSessionProject(id, result.currentCwd);
        useSettingsStore.getState().setWorkingDirectory(result.currentCwd);
        useChatStore.getState().setSessionMeta(id, { cwdSnapshot: result.currentCwd });
        await useSessionStore.getState().fetchSessions();
        return result;
      },
      async runAutomationNow(id: string) {
        await useProviderStore.getState().flushSave();
        return bridge.runAutomationNow(id);
      },
      cancelAutomationRun(runId: string) {
        return bridge.cancelAutomationRun(runId);
      },
      listAutomationRuns(automationId?: string) {
        return bridge.listAutomationRuns(automationId, 50);
      },
      isStreaming(tabId?: string) {
        const id = tabId || useSessionStore.getState().selectedSessionId;
        if (!id) return false;
        const tab = useChatStore.getState().tabs.get(id);
        if (!tab) return false;
        return !!(tab.partialText || tab.activityStatus?.phase === 'thinking');
      },
      isSettingsOpen() {
        return useSettingsStore.getState().settingsOpen;
      },
      status() {
        const sessionId = useSessionStore.getState().selectedSessionId;
        const tab = sessionId ? useChatStore.getState().tabs.get(sessionId) : null;
        const phase = tab?.activityStatus?.phase;
        const activePhases = new Set(['thinking', 'writing', 'tool', 'awaiting']);
        const activeStatuses = new Set(['running', 'stopping', 'reconnecting']);
        const active = !!(
          tab?.partialText
          || (phase && activePhases.has(phase))
          || (tab?.sessionStatus && activeStatuses.has(tab.sessionStatus))
        );
        return {
          session: sessionId,
          sessionCount: useSessionStore.getState().sessions.length,
          model: useSettingsStore.getState().selectedModel,
          provider: useProviderStore.getState().activeProviderId,
          active,
          phase: phase || null,
          sessionStatus: tab?.sessionStatus || null,
          pendingPermission: !!(window as any).__blackbox_respond_permission,
          settingsOpen: useSettingsStore.getState().settingsOpen,
          messageCount: tab?.messages?.length || 0,
        };
      },
      getContinuationState(tabId?: string) {
        const id = tabId || useSessionStore.getState().selectedSessionId;
        const tab = id ? useChatStore.getState().getTab(id) : undefined;
        return {
          tabId: id || null,
          sessionStatus: tab?.sessionStatus || null,
          phase: tab?.activityStatus?.phase || null,
          stdinId: tab?.sessionMeta.stdinId || null,
          hydratingFromDisk: tab?.sessionMeta.hydratingFromDisk === true,
          hydrationGeneration: tab?.sessionMeta.hydrationGeneration || null,
          pendingCommandMsgId: tab?.sessionMeta.pendingCommandMsgId || null,
          pending: (tab?.pendingUserMessages || []).map((item) => ({
            text: item.text,
            kind: item.kind || 'user',
            commandMessageId: item.commandMessageId || null,
          })),
          inputDraft: tab?.inputDraft || '',
          messageCount: tab?.messages.length || 0,
        };
      },
      clearBridgeCallLog() {
        (window as any).__blackbox_bridge_call_log = [];
        return { cleared: true };
      },
      getBridgeCallLog() {
        return Array.isArray((window as any).__blackbox_bridge_call_log)
          ? [...(window as any).__blackbox_bridge_call_log]
          : [];
      },
      setAutoCompactThreshold(value?: number) {
        if (value == null) delete (window as any).__blackbox_test_auto_compact_threshold;
        else (window as any).__blackbox_test_auto_compact_threshold = value;
        return { value: (window as any).__blackbox_test_auto_compact_threshold ?? null };
      },
      toggleWindowMaximize(marker: string) {
        if (!/^[A-Za-z0-9_]+$/.test(marker)) return { started: false, error: 'invalid marker' };
        (window as any)[marker] = { done: false, error: null };
        getCurrentWindow()
          .toggleMaximize()
          .then(() => { (window as any)[marker] = { done: true, error: null }; })
          .catch((error) => {
            (window as any)[marker] = { done: true, error: String(error) };
          });
        return { started: true };
      },
      setSessionLoadDelay(value?: number) {
        if (value == null || value <= 0) delete (window as any).__blackbox_test_load_session_delay_ms;
        else (window as any).__blackbox_test_load_session_delay_ms = value;
        return { value: (window as any).__blackbox_test_load_session_delay_ms ?? 0 };
      },
      dropSessionCache(tabId: string) {
        useChatStore.getState().removeFromCache(tabId);
        return { dropped: tabId, stillCached: useChatStore.getState().hasCachedSession(tabId) };
      },
      setDraft(tabId: string, text: string) {
        useChatStore.getState().ensureTab(tabId);
        useChatStore.getState().setInputDraft(tabId, text);
        return { tabId, text };
      },
      type(text: string) {
        const editor = (window as any).__blackbox_editor;
        if (!editor) return { error: 'Editor not available (no active session)' };
        editor.commands.clearContent();
        editor.commands.insertContent(text);
        return { typed: text };
      },
      send() {
        const fn = (window as any).__blackbox_send;
        if (!fn) return { error: 'Send handler not available' };
        fn();
        return { sent: true };
      },
      async loadSession(sessionId: string) {
        const sessions = useSessionStore.getState().sessions;
        const session = sessions.find((item) => item.id === sessionId);
        if (!session) return { error: `Session ${sessionId} not found` };
        const currentId = useSessionStore.getState().selectedSessionId;
        if (currentId) {
          useChatStore.getState().saveToCache(currentId);
          useAgentStore.getState().saveToCache(currentId);
          saveConversationFileState(currentId);
        }
        useSessionStore.getState().setSelectedSession(sessionId);
        restoreConversationFileState(sessionId);
        await restoreConversationRuntimePreference(sessionId);
        if (useSessionStore.getState().selectedSessionId !== sessionId) {
          return { switchedTo: sessionId, aborted: true, note: 'User switched away during runtime restore' };
        }
        const restored = useChatStore.getState().restoreFromCache(sessionId);
        if (restored) {
          useAgentStore.getState().restoreFromCache(sessionId);
          if (session.project) {
            const dir = session.project.startsWith('/') ? session.project : session.projectDir || session.project;
            useSettingsStore.getState().setWorkingDirectory(dir);
          }
          return {
            switchedTo: sessionId,
            restored: true,
            messageCount: useChatStore.getState().tabs.get(sessionId)?.messages?.length || 0,
          };
        }
        if (!session.path) {
          useChatStore.getState().ensureTab(sessionId);
          useChatStore.getState().resetTab(sessionId);
          useAgentStore.getState().clearAgents();
          return { switchedTo: sessionId, restored: false, messageCount: 0, note: 'draft session (no JSONL)' };
        }
        useChatStore.getState().ensureTab(sessionId);
        const dir = session.project?.startsWith('/') ? session.project : session.projectDir || session.project || '';
        useSettingsStore.getState().setWorkingDirectory(dir);
        const { clearMessages, addMessage, setSessionStatus, setSessionMeta } = useChatStore.getState();
        clearMessages(sessionId);
        useAgentStore.getState().clearAgents();
          setSessionStatus(sessionId, 'running');
          setSessionMeta(sessionId, { sessionId, stdinId: undefined });
          useSessionStore.getState().setCliResumeId(sessionId, sessionId);
        try {
          const rawMessages = await bridge.loadSession(session.path);
          if (useSessionStore.getState().selectedSessionId !== sessionId) {
            return { switchedTo: sessionId, aborted: true, note: 'User switched away during load' };
          }
          const { messages, agents, contextInputTokens, contextOutputTokens, nativeGoal } = parseSessionMessages(rawMessages);
          setSessionMeta(sessionId, { contextInputTokens, contextOutputTokens, nativeGoal });
          for (const agent of agents) useAgentStore.getState().upsertAgent(agent);
          for (const message of messages) {
            if ((message as any).toolResultContent) {
              const { toolResultContent, ...baseMessage } = message as any;
              addMessage(sessionId, baseMessage);
              useChatStore.getState().updateMessage(sessionId, message.id, { toolResultContent });
            } else {
              addMessage(sessionId, message);
            }
          }
          setSessionStatus(sessionId, 'completed');
          return { switchedTo: sessionId, restored: false, messageCount: messages.length };
        } catch (error) {
          if (useSessionStore.getState().selectedSessionId !== sessionId) {
            return { switchedTo: sessionId, aborted: true, note: 'User switched away during load' };
          }
          useChatStore.getState().setSessionStatus(sessionId, 'error');
          return { switchedTo: sessionId, error: `Failed to load: ${(error as Error).message}` };
        }
      },
      async switchSession(sessionId: string) {
        const sessionState = useSessionStore.getState();
        const currentId = sessionState.selectedSessionId;
        if (currentId) {
          useChatStore.getState().saveToCache(currentId);
          useAgentStore.getState().saveToCache(currentId);
          saveConversationFileState(currentId);
        }
        sessionState.setSelectedSession(sessionId);
        restoreConversationFileState(sessionId);
        await restoreConversationRuntimePreference(sessionId);
        if (useSessionStore.getState().selectedSessionId !== sessionId) {
          return { switchedTo: sessionId, aborted: true, restored: false };
        }
        const restored = useChatStore.getState().restoreFromCache(sessionId);
        if (restored) useAgentStore.getState().restoreFromCache(sessionId);
        return { switchedTo: sessionId, restored };
      },
      newSession(cwd?: string) {
        const currentTabId = useSessionStore.getState().selectedSessionId;
        if (currentTabId) {
          useChatStore.getState().saveToCache(currentTabId);
          useAgentStore.getState().saveToCache(currentTabId);
          saveConversationFileState(currentTabId);
          if (currentTabId.startsWith('draft_')) {
            const tabState = useChatStore.getState().tabs.get(currentTabId);
            if (!tabState || tabState.messages.length === 0) {
              useSessionStore.getState().removeDraft(currentTabId);
              useChatStore.getState().removeTab(currentTabId);
            }
          }
        }
        if (!cwd) {
          useSessionStore.getState().setSelectedSession(null);
          resetConversationFileState();
          useSettingsStore.getState().setWorkingDirectory('');
          return { action: 'newSession' };
        }
        const newId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        useSessionStore.getState().setSelectedSession(newId);
        restoreConversationFileState(newId);
        useSettingsStore.getState().setWorkingDirectory(cwd);
        useChatStore.getState().restoreFromCache(newId);
        // A fresh conversation cannot inherit persistent teammates or team
        // tasks from the previously selected tab. restoreFromCache clears the
        // live Agent authority when this new draft has no snapshot.
        useAgentStore.getState().restoreFromCache(newId);
        return { action: 'newSession', session: newId };
      },
      switchModel(modelId: string) {
        useSettingsStore.getState().setSelectedModel(modelId);
        return { model: modelId };
      },
      switchAuxiliaryModel(modelId: string) {
        useSettingsStore.getState().setAuxiliaryModel(modelId);
        return { model: modelId };
      },
      switchMode(mode: 'ask' | 'code' | 'plan' | 'auto' | 'bypass') {
        useSettingsStore.getState().setSessionMode(mode);
        return { mode };
      },
      switchProvider(providerId: string | null) {
        useProviderStore.getState().setActive(providerId);
        return { provider: providerId };
      },
      openSettings() {
        useSettingsStore.setState({ settingsOpen: true });
        return { settingsOpen: true };
      },
      closeSettings() {
        useSettingsStore.setState({ settingsOpen: false });
        return { settingsOpen: false };
      },
      switchSettingsTab(tabId: string) {
        const button = document.querySelector(`[data-testid="settings-tab-${tabId}"]`);
        if (button) {
          (button as HTMLElement).click();
          return { tab: tabId };
        }
        return { error: `Tab ${tabId} not found` };
      },
      allowPermission() {
        const fn = (window as any).__blackbox_respond_permission;
        if (!fn) return { error: 'No pending permission request' };
        fn(true);
        return { allowed: true };
      },
      denyPermission() {
        const fn = (window as any).__blackbox_respond_permission;
        if (!fn) return { error: 'No pending permission request' };
        fn(false);
        return { denied: true };
      },
      stop() {
        const button = document.querySelector('[data-testid="stop-button"]') as HTMLElement;
        if (!button) return { stopped: false, reason: 'no running session' };
        button.click();
        return { stopped: true };
      },
      focusWindow() {
        const window = getCurrentWindow();
        void window.show()
          .then(() => window.unminimize())
          .then(() => window.setFocus());
        return { focusRequested: true };
      },
      closeWindow() {
        // The dev socket may evaluate a mutating expression more than once.
        // Ignore only an overlapping native close request. Once the macOS
        // window is hidden, later hide/show cycles remain valid.
        if ((window as any).__blackbox_close_started) {
          return { closeRequested: true, duplicateIgnored: true };
        }
        (window as any).__blackbox_close_started = true;
        (window as any).__blackbox_close_result = { state: 'pending' };
        void getCurrentWindow().close()
          .then(() => {
            (window as any).__blackbox_close_result = { state: 'resolved' };
            (window as any).__blackbox_close_started = false;
          })
          .catch((error) => {
            (window as any).__blackbox_close_started = false;
            (window as any).__blackbox_close_result = {
              state: 'rejected',
              error: error instanceof Error ? error.message : String(error),
            };
          });
        return { closeRequested: true };
      },
      quitApp() {
        // Exercise Tauri's RunEvent::ExitRequested path (Cmd-Q / menu Quit),
        // which is distinct from the red traffic-light CloseRequested event.
        if ((window as any).__blackbox_quit_started) {
          return { quitRequested: true, duplicateIgnored: true };
        }
        (window as any).__blackbox_quit_started = true;
        void import('@tauri-apps/plugin-process')
          .then(({ exit }) => exit(0))
          .catch((error) => {
            (window as any).__blackbox_quit_started = false;
            (window as any).__blackbox_quit_error = error instanceof Error
              ? error.message
              : String(error);
          });
        return { quitRequested: true };
      },
      async deleteCurrentSession() {
        const sessionId = useSessionStore.getState().selectedSessionId;
        if (!sessionId) return { deleted: false, reason: 'no active session' };
        const session = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
        await teardownTabBackendProcesses(sessionId, 'delete');
        if (session?.path) {
          await bridge.deleteSession(sessionId, session.path);
        } else {
          useSessionStore.getState().removeDraft(sessionId);
        }
        useChatStore.getState().removeFromCache(sessionId);
        await forgetConversationRuntimePreference(sessionId);
        useAgentStore.getState().clearCacheForTab(sessionId);
        useAgentStore.getState().clearAgents();
        useSessionStore.getState().setSelectedSession(null);
        resetConversationFileState();
        useSettingsStore.getState().setWorkingDirectory('');
        await useSessionStore.getState().fetchSessions();
        return {
          deleted: true,
          detachedFromBlackBox: true,
          session: sessionId,
          privateTranscriptPreserved: Boolean(session?.path),
        };
      },
    };

    return () => {
      delete (window as any).__blackbox_test;
    };
  }, []);

  // ── Watchdog removed (Phase 1 decision §5.8) ──────────────────────
  // The automatic 3-minute stall detection and auto-recovery was removed because:
  // 1. It never successfully recovered in practice (empty prompt bug, no listeners)
  // 2. Phase 1 lifecycle fixes reduce the root causes of stalled sessions
  // Manual retry is available via the "session unresponsive" button in ChatPanel.

  // TK-329: On app startup (incl. browser refresh), detect and kill orphaned backend processes.
  // After refresh, frontend state (stdinToTab, listeners) is wiped, but Rust ProcessManager
  // may still hold live child processes. Kill any that have no corresponding frontend mapping.
  useEffect(() => {
    let disposed = false;
    let stopWarmReaper: (() => void) | undefined;
    void settleOrphanedBackendProcesses()
      .then(() => {
        if (!disposed) stopWarmReaper = startWarmBackendProcessReaper();
      })
      .catch((error) => {
        console.error('[BLACKBOX] Startup CLI recovery failed:', error);
      });
    return () => {
      disposed = true;
      stopWarmReaper?.();
    };
  }, []);

  // macOS Full Disk Access check — detect TCC restrictions on startup
  const [showPermDialog, setShowPermDialog] = useState(false);
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac');
    if (!isMac) return;
    // Skip if user previously dismissed the dialog
    if (localStorage.getItem('blackbox-perm-dismissed')) return;
    bridge.checkFileAccess('/Users').then((ok) => {
      if (!ok) setShowPermDialog(true);
    }).catch(() => {});
  }, []);

  // Load custom session names, provider config, and thread-scoped control state on startup.
  useEffect(() => {
    useSessionStore.getState().loadCustomPreviewsFromDisk();
    useProviderStore.getState().load();
    usePlanStore.getState().loadPlans();
    useForkStore.getState().loadForks();
    useReviewStore.getState().loadComments();
    // Notification permission is requested lazily on first need (see useStreamProcessor.ts)
  }, []);

  // Changelog modal state — feature hidden for now, keep state wiring intact for easy restore
  const [showChangelog, setShowChangelog] = useState(false);
  const [currentAppVersion, setCurrentAppVersion] = useState('');

  useEffect(() => {
    import('@tauri-apps/api/app').then(({ getVersion }) =>
      getVersion().then((version) => {
        setCurrentAppVersion(version);
        if (version && version !== lastSeenVersion) {
          setLastSeenVersion(version);
        }
      }).catch(() => {})
    );
  }, []);

  // Disable browser context menu globally (native app feel)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow context menu only in input fields and textareas
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.isContentEditable) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // Apply dark/light mode class to document
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const apply = () => {
        if (mq.matches) root.classList.add('dark');
        else root.classList.remove('dark');
      };
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  // Accent and surface are independent: changing one never rewrites the other.
  useEffect(() => {
    applyAppearanceClasses(document.documentElement.classList, colorTheme, surfaceTheme);
  }, [colorTheme, surfaceTheme]);

  // Apply font size to document root
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  // Cmd+/- global shortcut for font size
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        useSettingsStore.getState().increaseFontSize();
      } else if (e.key === '-') {
        e.preventDefault();
        useSettingsStore.getState().decreaseFontSize();
      } else if (e.key === '0') {
        e.preventDefault();
        useSettingsStore.getState().setFontSize(14);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Ctrl+Tab: quick-switch between the two most recent sessions
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const sessionState = useSessionStore.getState();
        const { previousSessionId, selectedSessionId, sessions } = sessionState;
        if (!previousSessionId || previousSessionId === selectedSessionId) return;
        // Verify previous session still exists
        const prevSession = sessions.find((s) => s.id === previousSessionId);
        if (!prevSession) return;

        // Save current session to cache
        if (selectedSessionId) {
          useChatStore.getState().saveToCache(selectedSessionId);
          useAgentStore.getState().saveToCache(selectedSessionId);
          saveConversationFileState(selectedSessionId);
        }

        // Switch selection (this also updates previousSessionId)
        sessionState.setSelectedSession(previousSessionId);
        restoreConversationFileState(previousSessionId);
        try {
          await restoreConversationRuntimePreference(previousSessionId);
        } catch (error) {
          console.error('[conversation-runtime] Ctrl+Tab restore failed:', error);
        }
        if (useSessionStore.getState().selectedSessionId !== previousSessionId) return;

        // Restore from cache
        const restored = useChatStore.getState().restoreFromCache(previousSessionId);
        if (restored) {
          useAgentStore.getState().restoreFromCache(previousSessionId);
          // Restore working directory — S16 (v3 §4.3): prefer the already-decoded
          // `project` field (set by decode_project_name in Rust). Only fall back
          // to the backend decoder when `project` is missing, and never do the
          // naive `.replace(/-/g, '/')` that silently mangles hyphen names.
          const projectPath = prevSession.project || prevSession.projectDir;
          if (projectPath) {
            const useDirectly = projectPath.startsWith('/')
              || /^[A-Za-z]:[/\\]/.test(projectPath)
              || projectPath.startsWith('~/');
            if (useDirectly) {
              useSettingsStore.getState().setWorkingDirectory(projectPath);
            } else {
              bridge.decodeProjectDir(projectPath)
                .then((decoded) => useSettingsStore.getState().setWorkingDirectory(decoded))
                .catch(() => useSettingsStore.getState().setWorkingDirectory(projectPath));
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // The file tree is demand-driven. A hidden Activity/Files panel must not
  // recursively scan or watch a restored workspace in the background.
  useEffect(() => {
    if (!workingDirectory || !fileTreeActive) return;

    void loadTree(workingDirectory);
    void bridge.watchDirectory(workingDirectory).catch(console.error);

    return () => {
      void bridge.unwatchDirectory(workingDirectory).catch(() => {});
    };
  }, [fileTreeActive, loadTree, workingDirectory]);

  // Listen for file change events from the watcher
  // Debounce tree refresh for created/removed events (structure changes)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const structuralChangePathsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!fileTreeActive) return;
    const unlisten = onFileChange((event) => {
      // Defense-in-depth: skip paths under noisy directories (also filtered in Rust)
      const filtered = event.paths.filter((p) =>
        !/(^|[/\\])(\.(claude|git)|node_modules|__pycache__)[/\\]/.test(p)
      );
      if (filtered.length === 0) return;

      for (const filePath of filtered) {
        markFileChanged(filePath, event.kind);
      }

      // When files are created or removed, the tree structure changes —
      // debounce a full tree reload (300ms to batch rapid changes)
      if (event.kind === 'created' || event.kind === 'removed') {
        for (const filePath of filtered) structuralChangePathsRef.current.add(filePath);
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          const changedPaths = Array.from(structuralChangePathsRef.current);
          structuralChangePathsRef.current.clear();
          void refreshChangedPaths(changedPaths);
          refreshTimerRef.current = null;
        }, 300);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      structuralChangePathsRef.current.clear();
    };
  }, [fileTreeActive, markFileChanged, refreshChangedPaths]);

  return (
    <>
      <AutomationSessionMonitor />
      <LiveSessionTranscriptMonitor />
      <AppShell
        sidebar={<Sidebar />}
        main={mainView === 'extensions'
          ? <ExtensionCenter />
          : mainView === 'automations'
            ? <AutomationCenter />
            : mainView === 'taskCenter'
              ? <TaskCenterView />
              : <ChatPanel key={selectedSessionId || 'new'} />}
        secondary={mainView === 'chat' ? <SecondaryPanel /> : undefined}
      />
      <CommandPalette />
      {settingsOpen && <SettingsPanel />}
      <ImageLightbox />
      {showChangelog && currentAppVersion && (
        <ChangelogModal
          version={currentAppVersion}
          onClose={() => {
            setShowChangelog(false);
            setLastSeenVersion(currentAppVersion);
          }}
        />
      )}
      {showPermDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-bg-primary rounded-2xl border border-border-subtle shadow-2xl
            max-w-md w-full mx-4 overflow-hidden animate-scale-in">
            {/* Header */}
            <div className="px-6 pt-6 pb-3 flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-warning/15 flex items-center justify-center flex-shrink-0">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"
                  stroke="currentColor" strokeWidth="1.5" className="text-warning">
                  <path d="M10 2L1.5 17h17L10 2z" />
                  <path d="M10 8v4M10 14.5v.5" />
                </svg>
              </div>
              <div>
                <h3 className="text-base font-semibold text-text-primary">{t('perm.title')}</h3>
                <p className="text-xs text-text-muted mt-1 leading-relaxed">{t('perm.desc')}</p>
              </div>
            </div>
            {/* Path hint */}
            <div className="mx-6 px-3 py-2 rounded-lg bg-bg-secondary text-[11px] text-text-tertiary font-mono">
              {t('perm.path')}
            </div>
            {/* Actions */}
            <div className="px-6 py-4 flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  localStorage.setItem('blackbox-perm-dismissed', '1');
                  setShowPermDialog(false);
                }}
                className="px-4 py-2 rounded-lg text-xs font-medium
                  text-text-muted hover:text-text-primary hover:bg-bg-tertiary
                  transition-smooth cursor-pointer"
              >
                {t('perm.later')}
              </button>
              <button
                onClick={() => {
                  localStorage.setItem('blackbox-perm-dismissed', '1');
                  openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
                  setShowPermDialog(false);
                }}
                className="px-4 py-2 rounded-lg text-xs font-semibold
                  bg-accent text-text-inverse hover:bg-accent-hover
                  transition-smooth cursor-pointer shadow-sm"
              >
                {t('perm.openSettings')}
              </button>
            </div>
          </div>
        </div>
      )}
      <Toast />
    </>
  );
}

export default App;
