import { create } from 'zustand';
import {
  bridge,
  type McpConnectionStatus,
  type McpSaveRequest,
  type McpScope,
  type McpServerConfig,
  type McpServerRecord,
} from '../lib/tauri-bridge';

export type { McpConnectionStatus, McpScope, McpServerConfig, McpServerRecord };
export type McpServer = McpServerRecord;

export function mcpServerKey(server: Pick<McpServerRecord, 'scope' | 'name'>): string {
  return `${server.scope}:${server.name}`;
}

interface RuntimeMcpServer {
  name?: string;
  status?: string;
}

interface McpState {
  servers: McpServerRecord[];
  /** Exact native + MCP tool inventory from the latest Claude system:init. */
  runtimeTools: string[];
  isLoading: boolean;
  isChecking: boolean;
  editingServer: string | null;
  authenticatingServer: string | null;
  isAdding: boolean;
  error: string;

  fetchServers: (cwd?: string, checkHealth?: boolean) => Promise<void>;
  addServer: (
    name: string,
    scope: McpScope,
    config: McpServerConfig,
    cwd?: string,
  ) => Promise<void>;
  updateServer: (
    original: McpServerRecord,
    name: string,
    scope: McpScope,
    config: McpServerConfig,
    cwd?: string,
  ) => Promise<void>;
  deleteServer: (server: McpServerRecord, cwd?: string) => Promise<void>;
  setProjectApproval: (name: string, approved: boolean, cwd: string) => Promise<void>;
  loginServer: (name: string, cwd?: string) => Promise<void>;
  logoutServer: (name: string, cwd?: string) => Promise<void>;
  recordRuntimeServers: (servers: RuntimeMcpServer[], tools: string[]) => void;
  clearError: () => void;
  setEditing: (key: string | null) => void;
  setAdding: (adding: boolean) => void;
}

function errorMessage(error: unknown): string {
  return String(error).replace(/^Error:\s*/, '');
}

function runtimeStatus(value: string | undefined): McpConnectionStatus {
  const normalized = (value || '').toLowerCase();
  if (normalized.includes('pending')) return 'pendingApproval';
  if (normalized.includes('reject')) return 'rejected';
  if (normalized.includes('auth') || normalized.includes('login')) return 'needsAuth';
  if (normalized.includes('connect') && !normalized.includes('fail')) return 'connected';
  if (normalized.includes('fail') || normalized.includes('error')) return 'failed';
  return 'unknown';
}

function preserveRuntimeState(
  previous: McpServerRecord[],
  next: McpServerRecord[],
): McpServerRecord[] {
  const previousByKey = new Map(previous.map((server) => [mcpServerKey(server), server]));
  return next.map((server) => {
    const prior = previousByKey.get(mcpServerKey(server));
    if (!prior) return server;
    return {
      ...server,
      toolCount: server.toolCount ?? prior.toolCount,
      status: server.status === 'unknown' ? prior.status : server.status,
      statusDetail: server.statusDetail ?? prior.statusDetail,
    };
  });
}

export const useMcpStore = create<McpState>()((set, get) => ({
  servers: [],
  runtimeTools: [],
  isLoading: false,
  isChecking: false,
  editingServer: null,
  authenticatingServer: null,
  isAdding: false,
  error: '',

  fetchServers: async (cwd, checkHealth = false) => {
    set(checkHealth ? { isChecking: true, error: '' } : { isLoading: true, error: '' });
    try {
      const servers = await bridge.listMcpServers(cwd, checkHealth);
      set({
        servers: preserveRuntimeState(get().servers, servers),
        isLoading: false,
        isChecking: false,
      });
    } catch (error) {
      set({ isLoading: false, isChecking: false, error: errorMessage(error) });
    }
  },

  addServer: async (name, scope, config, cwd) => {
    const request: McpSaveRequest = {
      originalName: null,
      originalScope: null,
      name,
      scope,
      config,
      cwd: cwd || null,
    };
    try {
      const servers = await bridge.saveMcpServer(request);
      set({ servers, isAdding: false, error: '' });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  updateServer: async (original, name, scope, config, cwd) => {
    const request: McpSaveRequest = {
      originalName: original.name,
      originalScope: original.scope,
      name,
      scope,
      config,
      cwd: cwd || null,
    };
    try {
      const servers = await bridge.saveMcpServer(request);
      set({ servers, editingServer: null, error: '' });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  deleteServer: async (server, cwd) => {
    try {
      const servers = await bridge.deleteMcpServer(server.name, server.scope, cwd);
      set({ servers, error: '' });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  setProjectApproval: async (name, approved, cwd) => {
    try {
      const servers = await bridge.setProjectMcpApproval(name, approved, cwd);
      set({ servers, error: '' });
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
  },

  loginServer: async (name, cwd) => {
    const key = `auth:${name}`;
    set({ authenticatingServer: key, error: '' });
    try {
      await bridge.loginMcpServer(name, cwd);
      set({ authenticatingServer: null });
      await get().fetchServers(cwd, true);
    } catch (error) {
      set({ authenticatingServer: null, error: errorMessage(error) });
      throw error;
    }
  },

  logoutServer: async (name, cwd) => {
    const key = `auth:${name}`;
    set({ authenticatingServer: key, error: '' });
    try {
      await bridge.logoutMcpServer(name, cwd);
      set({ authenticatingServer: null });
      await get().fetchServers(cwd, true);
    } catch (error) {
      set({ authenticatingServer: null, error: errorMessage(error) });
      throw error;
    }
  },

  recordRuntimeServers: (runtimeServers, tools) => {
    const byName = new Map(
      runtimeServers
        .filter((server): server is RuntimeMcpServer & { name: string } => Boolean(server?.name))
        .map((server) => [server.name, runtimeStatus(server.status)]),
    );
    set((state) => ({
      runtimeTools: [...new Set(tools)],
      servers: state.servers.map((server) => {
        if (!server.effective) return server;
        const prefix = `mcp__${server.name}__`;
        const toolCount = tools.filter((tool) => tool.startsWith(prefix)).length;
        const status = byName.get(server.name);
        const wasReportedByRuntime = byName.has(server.name);
        return {
          ...server,
          status: status && status !== 'unknown' ? status : server.status,
          toolCount: wasReportedByRuntime ? toolCount : server.toolCount,
        };
      }),
    }));
  },

  clearError: () => set({ error: '' }),
  setEditing: (key) => set({ editingServer: key, isAdding: false, error: '' }),
  setAdding: (adding) => set({ isAdding: adding, editingServer: null, error: '' }),
}));
