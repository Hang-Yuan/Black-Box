import { create } from 'zustand';
import {
  toggleTaskComposerMode,
  type BusyDeliveryMode,
  type TaskComposerMode,
} from '../lib/composer-mode';

export interface ComposerModeTabState {
  taskMode: TaskComposerMode | null;
  busyDelivery: BusyDeliveryMode;
  workflowName: string;
  loopInterval: string;
}

export const DEFAULT_COMPOSER_MODE_TAB: Readonly<ComposerModeTabState> = Object.freeze({
  taskMode: null,
  busyDelivery: 'steer',
  workflowName: '',
  loopInterval: '5m',
});

interface ComposerModeStore {
  tabs: Record<string, ComposerModeTabState>;
  selectTaskMode: (tabId: string, mode: TaskComposerMode) => void;
  clearTaskMode: (tabId: string) => void;
  setBusyDelivery: (tabId: string, mode: BusyDeliveryMode) => void;
  setWorkflowName: (tabId: string, name: string) => void;
  setLoopInterval: (tabId: string, interval: string) => void;
  moveTab: (oldTabId: string, newTabId: string) => void;
}

function currentTab(
  tabs: Record<string, ComposerModeTabState>,
  tabId: string,
): ComposerModeTabState {
  return tabs[tabId] || { ...DEFAULT_COMPOSER_MODE_TAB };
}

function updateTab(
  tabs: Record<string, ComposerModeTabState>,
  tabId: string,
  patch: Partial<ComposerModeTabState>,
): Record<string, ComposerModeTabState> {
  return {
    ...tabs,
    [tabId]: { ...currentTab(tabs, tabId), ...patch },
  };
}

export const useComposerModeStore = create<ComposerModeStore>()((set) => ({
  tabs: {},

  selectTaskMode: (tabId, mode) => set((state) => ({
    tabs: updateTab(state.tabs, tabId, {
      taskMode: toggleTaskComposerMode(currentTab(state.tabs, tabId).taskMode, mode),
    }),
  })),

  clearTaskMode: (tabId) => set((state) => ({
    tabs: updateTab(state.tabs, tabId, { taskMode: null }),
  })),

  setBusyDelivery: (tabId, mode) => set((state) => ({
    tabs: updateTab(state.tabs, tabId, { busyDelivery: mode }),
  })),

  setWorkflowName: (tabId, name) => set((state) => ({
    tabs: updateTab(state.tabs, tabId, { workflowName: name }),
  })),

  setLoopInterval: (tabId, interval) => set((state) => ({
    tabs: updateTab(state.tabs, tabId, { loopInterval: interval }),
  })),

  moveTab: (oldTabId, newTabId) => set((state) => {
    const source = state.tabs[oldTabId];
    if (!source || oldTabId === newTabId) return state;
    const tabs = { ...state.tabs, [newTabId]: source };
    delete tabs[oldTabId];
    return { tabs };
  }),
}));

export function getComposerModeTab(tabId: string | null | undefined): ComposerModeTabState {
  if (!tabId) return { ...DEFAULT_COMPOSER_MODE_TAB };
  return useComposerModeStore.getState().tabs[tabId] || { ...DEFAULT_COMPOSER_MODE_TAB };
}
