import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  listAllCommands: vi.fn(),
}));

vi.mock('../../lib/tauri-bridge', () => ({ bridge: bridgeMock }));

import type { UnifiedCommand } from '../../lib/tauri-bridge';
import {
  mergeRuntimeCommands,
  runtimeInventoryFromMessage,
  useCommandStore,
  type RuntimeCommandInventory,
} from '../commandStore';

const compact: UnifiedCommand = {
  name: '/compact',
  description: 'Compact conversation',
  source: 'builtin',
  category: 'builtin',
  has_args: false,
  immediate: true,
  execution: 'session',
};

const nativeGoal: UnifiedCommand = {
  name: '/goal',
  description: "Use Claude Code's native Goal command",
  source: 'builtin',
  category: 'builtin',
  has_args: false,
  immediate: false,
  execution: 'session',
};

const runtime: RuntimeCommandInventory = {
  cwd: '/workspace/project',
  claudeCodeVersion: '2.1.207',
  slashCommands: ['compact', 'goal', 'loop', 'future-command'],
  skills: ['loop'],
};

function resetStore() {
  useCommandStore.setState({
    commands: [],
    isLoading: false,
    activeCwd: '',
    baseByCwd: {},
    runtimeByCwd: {},
    activePrefix: null,
  });
}

describe('Claude runtime command discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('deduplicates fallback entries and adds capabilities unknown to the app build', () => {
    const merged = mergeRuntimeCommands([compact, nativeGoal], runtime);

    expect(merged.filter((command) => command.name === '/compact')).toHaveLength(1);
    expect(merged.find((command) => command.name === '/compact')).toMatchObject({
      description: 'Compact conversation',
      runtime_available: true,
      runtime_kind: 'command',
    });
    expect(merged.find((command) => command.name === '/goal')).toMatchObject({
      source: 'builtin',
      category: 'command',
      owner: 'claude',
      availability: 'available',
      execution: 'session',
      immediate: false,
      runtime_available: true,
    });
    expect(merged.find((command) => command.name === '/loop')).toMatchObject({
      source: 'runtime',
      category: 'skill',
      runtime_kind: 'skill',
    });
  });

  it('removes stale Claude-owned fallbacks after system:init while retaining Black Box controls', () => {
    const stale: UnifiedCommand = {
      name: '/removed-command',
      description: 'Old CLI command',
      source: 'builtin',
      category: 'builtin',
      has_args: false,
      immediate: true,
      execution: 'session',
    };
    const uiOwned: UnifiedCommand = {
      name: '/todos',
      description: 'Black Box Plan view',
      source: 'builtin',
      category: 'builtin',
      has_args: true,
      immediate: true,
      execution: 'ui',
    };
    const merged = mergeRuntimeCommands([compact, stale, uiOwned], runtime);
    expect(merged.some((command) => command.name === '/removed-command')).toBe(false);
    expect(merged.some((command) => command.name === '/todos')).toBe(true);
  });

  it('keeps a system:init inventory when the slower filesystem fetch finishes later', async () => {
    let resolveFetch!: (commands: UnifiedCommand[]) => void;
    bridgeMock.listAllCommands.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const pending = useCommandStore.getState().fetchCommands('/workspace/project/');
    useCommandStore.getState().recordRuntimeInventory(runtime);
    expect(useCommandStore.getState().commands.some((command) => command.name === '/future-command')).toBe(true);

    resolveFetch([compact]);
    await pending;

    const state = useCommandStore.getState();
    expect(state.activeCwd).toBe('/workspace/project');
    expect(state.commands.some((command) => command.name === '/future-command')).toBe(true);
    expect(state.commands.find((command) => command.name === '/compact')?.description)
      .toBe('Compact conversation');
  });

  it('does not leak a background task inventory into another active workspace', async () => {
    bridgeMock.listAllCommands.mockResolvedValue([compact]);
    await useCommandStore.getState().fetchCommands('/workspace/current');

    useCommandStore.getState().recordRuntimeInventory({
      ...runtime,
      cwd: '/workspace/background',
    });

    expect(useCommandStore.getState().activeCwd).toBe('/workspace/current');
    expect(useCommandStore.getState().commands.some((command) => command.name === '/future-command')).toBe(false);
    expect(useCommandStore.getState().runtimeByCwd['/workspace/background']).toBeDefined();
  });

  it('treats commands_changed as a rich full replacement', () => {
    const initial = runtimeInventoryFromMessage({
      subtype: 'init',
      cwd: '/workspace/project',
      slash_commands: ['compact', 'old-skill'],
      skills: ['old-skill'],
    });
    expect(initial).not.toBeNull();

    const changed = runtimeInventoryFromMessage({
      subtype: 'commands_changed',
      cwd: '/workspace/project',
      commands: [
        {
          name: 'deep-research',
          description: 'Research with sources',
          argumentHint: '[topic]',
          aliases: ['research'],
          kind: 'workflow',
        },
        { name: 'mcp__calendar__today' },
      ],
    }, '/workspace/project', initial!);

    expect(changed?.slashCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '/deep-research',
        description: 'Research with sources',
        argumentHint: '[topic]',
        aliases: ['/research'],
        kind: 'workflow',
      }),
      expect.objectContaining({
        name: '/mcp__calendar__today',
        owner: 'mcp',
      }),
    ]));
    expect(changed?.skills).toEqual([]);

    const merged = mergeRuntimeCommands([compact], changed!);
    expect(merged.some((command) => command.name === '/compact')).toBe(false);
    expect(merged.find((command) => command.name === '/deep-research')).toMatchObject({
      category: 'workflow',
      kind: 'workflow',
      availability: 'available',
      has_args: true,
    });
  });

  it('keeps filesystem discoveries provisional until the runtime confirms them', () => {
    const filesystemSkill: UnifiedCommand = {
      name: '/local-skill',
      description: 'Local skill',
      source: 'project',
      category: 'skill',
      owner: 'filesystem',
      kind: 'skill',
      availability: 'provisional',
      has_args: false,
      immediate: false,
    };

    expect(mergeRuntimeCommands([filesystemSkill])[0].availability).toBe('provisional');
    expect(mergeRuntimeCommands([filesystemSkill], {
      cwd: '/workspace/project',
      slashCommands: ['local-skill'],
      skills: ['local-skill'],
    })[0]).toMatchObject({
      owner: 'filesystem',
      kind: 'skill',
      availability: 'available',
      runtime_available: true,
    });
  });

  it('marks legacy cold Claude entries as references instead of callable commands', () => {
    expect(mergeRuntimeCommands([compact])[0]).toMatchObject({
      owner: 'claude',
      availability: 'reference',
    });
  });

  it('reserves Black Box controls and applies personal-over-project filesystem precedence', () => {
    const blackboxAsk: UnifiedCommand = {
      name: '/ask',
      description: 'Black Box permission control',
      source: 'builtin',
      category: 'builtin',
      owner: 'blackbox',
      kind: 'command',
      availability: 'available',
      has_args: false,
      immediate: true,
      execution: 'ui',
    };
    const globalSkill: UnifiedCommand = {
      name: '/shared',
      description: 'Personal definition',
      source: 'global',
      category: 'skill',
      owner: 'filesystem',
      kind: 'skill',
      availability: 'provisional',
      has_args: false,
      immediate: false,
    };
    const projectSkill = {
      ...globalSkill,
      source: 'project' as const,
      description: 'Project definition',
    };

    const merged = mergeRuntimeCommands(
      [blackboxAsk, globalSkill, projectSkill],
      { slashCommands: ['ask'], skills: [] },
    );
    expect(merged.find((command) => command.name === '/ask')).toMatchObject({
      owner: 'blackbox',
      execution: 'ui',
    });
    expect(merged.find((command) => command.name === '/shared')).toMatchObject({
      source: 'global',
      description: 'Personal definition',
    });
  });
});
