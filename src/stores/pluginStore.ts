import { create } from 'zustand';
import {
  bridge,
  type PluginDiagnosticsReport,
  type PluginMarketplaceRecord,
  type PluginRecord,
  type PluginScope,
} from '../lib/tauri-bridge';

interface PluginState {
  plugins: PluginRecord[];
  marketplaces: PluginMarketplaceRecord[];
  diagnostics: PluginDiagnosticsReport | null;
  diagnosticsLoading: boolean;
  diagnosticsError: string;
  includeAvailable: boolean;
  loaded: boolean;
  loading: boolean;
  busyKey: string | null;
  error: string;
  load: (cwd?: string, includeAvailable?: boolean) => Promise<void>;
  loadMarketplaces: (cwd?: string) => Promise<void>;
  diagnose: (cwd?: string) => Promise<void>;
  details: (id: string, cwd?: string) => Promise<string>;
  install: (id: string, scope: PluginScope, cwd?: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean, scope: PluginScope, cwd?: string) => Promise<void>;
  update: (id: string, scope: PluginScope, cwd?: string) => Promise<void>;
  uninstall: (id: string, scope: PluginScope, keepData: boolean, cwd?: string) => Promise<void>;
  addMarketplace: (source: string, cwd?: string) => Promise<void>;
  updateMarketplace: (name?: string, cwd?: string) => Promise<void>;
  removeMarketplace: (name: string, cwd?: string) => Promise<void>;
  clearError: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withPluginMutation(
  key: string,
  action: () => Promise<PluginRecord[]>,
  set: (patch: Partial<PluginState>) => void,
): Promise<void> {
  set({ busyKey: key, error: '' });
  try {
    set({ plugins: await action(), diagnostics: null, diagnosticsError: '' });
  } catch (error) {
    set({ error: message(error) });
    throw error;
  } finally {
    set({ busyKey: null });
  }
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  marketplaces: [],
  diagnostics: null,
  diagnosticsLoading: false,
  diagnosticsError: '',
  includeAvailable: false,
  loaded: false,
  loading: false,
  busyKey: null,
  error: '',

  load: async (cwd, includeAvailable = get().includeAvailable) => {
    set({ loading: true, error: '', includeAvailable });
    try {
      const plugins = await bridge.listPlugins(cwd, includeAvailable);
      set({ plugins, loaded: true });
    } catch (error) {
      set({ error: message(error), loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  loadMarketplaces: async (cwd) => {
    try {
      set({ marketplaces: await bridge.listPluginMarketplaces(cwd) });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  diagnose: async (cwd) => {
    set({ diagnosticsLoading: true, diagnosticsError: '' });
    try {
      set({ diagnostics: await bridge.diagnosePlugins(cwd) });
    } catch (error) {
      set({ diagnostics: null, diagnosticsError: message(error) });
    } finally {
      set({ diagnosticsLoading: false });
    }
  },

  details: (id, cwd) => bridge.pluginDetails(id, cwd),

  install: (id, scope, cwd) => withPluginMutation(
    `install:${id}`,
    () => bridge.installPlugin(id, scope, cwd),
    set,
  ),

  setEnabled: (id, enabled, scope, cwd) => withPluginMutation(
    `${enabled ? 'enable' : 'disable'}:${id}`,
    () => bridge.setPluginEnabled(id, enabled, scope, cwd),
    set,
  ),

  update: (id, scope, cwd) => withPluginMutation(
    `update:${id}`,
    () => bridge.updatePlugin(id, scope, cwd),
    set,
  ),

  uninstall: (id, scope, keepData, cwd) => withPluginMutation(
    `uninstall:${id}`,
    () => bridge.uninstallPlugin(id, scope, keepData, cwd),
    set,
  ),

  addMarketplace: async (source, cwd) => {
    set({ busyKey: 'marketplace:add', error: '' });
    try {
      set({ marketplaces: await bridge.addPluginMarketplace(source, cwd), diagnostics: null });
      await get().load(cwd, true);
    } catch (error) {
      set({ error: message(error) });
      throw error;
    } finally {
      set({ busyKey: null });
    }
  },

  updateMarketplace: async (name, cwd) => {
    const key = `marketplace:update:${name || 'all'}`;
    set({ busyKey: key, error: '' });
    try {
      set({ marketplaces: await bridge.updatePluginMarketplace(name, cwd), diagnostics: null });
      await get().load(cwd, true);
    } catch (error) {
      set({ error: message(error) });
      throw error;
    } finally {
      set({ busyKey: null });
    }
  },

  removeMarketplace: async (name, cwd) => {
    set({ busyKey: `marketplace:remove:${name}`, error: '' });
    try {
      set({ marketplaces: await bridge.removePluginMarketplace(name, cwd), diagnostics: null });
      await get().load(cwd, true);
    } catch (error) {
      set({ error: message(error) });
      throw error;
    } finally {
      set({ busyKey: null });
    }
  },

  clearError: () => set({ error: '' }),
}));
