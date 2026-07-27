import { create } from 'zustand';
import { bridge, type UnifiedCommand } from '../lib/tauri-bridge';

export type CommandOwner = NonNullable<UnifiedCommand['owner']>;
export type CommandKind = NonNullable<UnifiedCommand['kind']>;

export interface RuntimeCommandDescriptor {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  kind?: CommandKind;
  owner?: CommandOwner;
}

export interface RuntimeCommandInventory {
  cwd?: string;
  claudeCodeVersion?: string;
  slashCommands: Array<string | RuntimeCommandDescriptor>;
  skills: string[];
  workflows?: string[];
  capabilities?: string[];
}

function cwdKey(cwd?: string): string {
  const trimmed = cwd?.trim() || '';
  if (!trimmed || trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '');
}

function commandName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function normalizeKind(value: unknown): CommandKind | undefined {
  return value === 'command' || value === 'skill' || value === 'workflow' ? value : undefined;
}

function normalizeOwner(value: unknown): CommandOwner | undefined {
  return value === 'blackbox'
    || value === 'filesystem'
    || value === 'claude'
    || value === 'plugin'
    || value === 'mcp'
    ? value
    : undefined;
}

function inferRuntimeOwner(
  name: string,
  value?: Record<string, unknown>,
): CommandOwner {
  const explicit = normalizeOwner(value?.owner);
  if (explicit) return explicit;
  const source = stringValue(value?.source)?.toLowerCase();
  if (source?.includes('plugin')) return 'plugin';
  if (source?.includes('mcp') || name.toLowerCase().startsWith('/mcp__')) return 'mcp';
  return 'claude';
}

export function normalizeRuntimeCommand(
  raw: string | RuntimeCommandDescriptor | Record<string, unknown>,
  runtimeSkills: Set<string> = new Set(),
): RuntimeCommandDescriptor | null {
  if (typeof raw === 'string') {
    const name = commandName(raw);
    if (!name) return null;
    return {
      name,
      kind: runtimeSkills.has(name.toLowerCase()) ? 'skill' : 'command',
      owner: inferRuntimeOwner(name),
    };
  }

  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = commandName(stringValue(value.name) || '');
  if (!name) return null;
  const argumentHint = stringValue(value.argumentHint) || stringValue(value.argument_hint);
  const aliases = stringArray(value.aliases)
    .map(commandName)
    .filter((alias): alias is string => Boolean(alias));
  const advertisedKind = normalizeKind(value.kind)
    || normalizeKind(value.type)
    || normalizeKind(value.category);

  return {
    name,
    description: stringValue(value.description),
    argumentHint,
    aliases,
    kind: advertisedKind
      || (runtimeSkills.has(name.toLowerCase()) ? 'skill' : 'command'),
    owner: inferRuntimeOwner(name, value),
  };
}

function normalizeInventory(inventory: RuntimeCommandInventory): RuntimeCommandInventory {
  const runtimeSkills = new Set(
    inventory.skills
      .map(commandName)
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  );
  const slashCommands = inventory.slashCommands
    .map((command) => normalizeRuntimeCommand(command, runtimeSkills))
    .filter((command): command is RuntimeCommandDescriptor => Boolean(command));
  const runtimeWorkflows = new Set(
    (inventory.workflows || [])
      .map(commandName)
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  );
  for (const command of slashCommands) {
    if (command.kind === 'skill') runtimeSkills.add(command.name.toLowerCase());
    if (command.kind === 'workflow') runtimeWorkflows.add(command.name.toLowerCase());
    if (runtimeWorkflows.has(command.name.toLowerCase())) command.kind = 'workflow';
  }
  return {
    ...inventory,
    cwd: cwdKey(inventory.cwd),
    slashCommands,
    skills: [...runtimeSkills],
    workflows: [...runtimeWorkflows],
  };
}

/**
 * Parse both the legacy system:init string arrays and the current rich
 * commands_changed payload. commands_changed is a full replacement; when it
 * omits a separate skills array, retain only prior skill names still present.
 */
export function runtimeInventoryFromMessage(
  message: unknown,
  fallbackCwd?: string,
  previous?: RuntimeCommandInventory,
): RuntimeCommandInventory | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  const rawCommands = Array.isArray(value.commands)
    ? value.commands
    : Array.isArray(value.slash_commands)
      ? value.slash_commands
      : Array.isArray(value.slashCommands)
        ? value.slashCommands
        : null;
  if (!rawCommands) return null;

  const commandNames = new Set(
    rawCommands
      .map((command) => typeof command === 'string'
        ? commandName(command)
        : command && typeof command === 'object'
          ? commandName(stringValue((command as Record<string, unknown>).name) || '')
          : null)
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  );
  const explicitSkills = Array.isArray(value.skills)
    ? value.skills
        .map((skill) => typeof skill === 'string'
          ? commandName(skill)
          : skill && typeof skill === 'object'
            ? commandName(stringValue((skill as Record<string, unknown>).name) || '')
            : null)
        .filter((name): name is string => Boolean(name))
    : undefined;
  const skills = explicitSkills
    || (previous?.skills || []).filter((skill) => {
      const name = commandName(skill);
      return name ? commandNames.has(name.toLowerCase()) : false;
    });
  const explicitWorkflows = Array.isArray(value.workflows)
    ? value.workflows
        .map((workflow) => typeof workflow === 'string'
          ? commandName(workflow)
          : workflow && typeof workflow === 'object'
            ? commandName(stringValue((workflow as Record<string, unknown>).name) || '')
            : null)
        .filter((name): name is string => Boolean(name))
    : undefined;
  const workflows = explicitWorkflows
    || (previous?.workflows || []).filter((workflow) => {
      const name = commandName(workflow);
      return name ? commandNames.has(name.toLowerCase()) : false;
    });

  const capabilities = Array.isArray(value.tools)
    ? stringArray(value.tools)
    : Array.isArray(value.capabilities)
    ? stringArray(value.capabilities)
    : value.capabilities && typeof value.capabilities === 'object'
      ? Object.keys(value.capabilities)
      : previous?.capabilities;

  return normalizeInventory({
    cwd: stringValue(value.cwd) || fallbackCwd || previous?.cwd,
    claudeCodeVersion: stringValue(value.claude_code_version)
      || stringValue(value.claudeCodeVersion)
      || previous?.claudeCodeVersion,
    slashCommands: rawCommands as Array<string | RuntimeCommandDescriptor>,
    skills,
    workflows,
    capabilities,
  });
}

function ownerOf(command: UnifiedCommand): CommandOwner {
  if (command.owner) return command.owner;
  if (command.source === 'runtime') return 'claude';
  if (command.source === 'global' || command.source === 'project') return 'filesystem';
  return command.execution === 'ui' ? 'blackbox' : 'claude';
}

function kindOf(command: UnifiedCommand): CommandKind {
  return command.kind
    || command.runtime_kind
    || (command.category === 'skill' || command.category === 'workflow'
      ? command.category
      : 'command');
}

function withBaseMetadata(command: UnifiedCommand): UnifiedCommand {
  const owner = ownerOf(command);
  const kind = kindOf(command);
  const availability = command.availability
    || (owner === 'blackbox'
      ? 'available'
      : owner === 'filesystem'
        ? 'provisional'
        : command.runtime_available
          ? 'available'
          : 'reference');
  return {
    ...command,
    owner,
    kind,
    availability,
    category: command.category === 'builtin' ? 'builtin' : kind,
    aliases: command.aliases || [],
  };
}

function dedupeBaseCommands(commands: UnifiedCommand[]): UnifiedCommand[] {
  const deduped: UnifiedCommand[] = [];
  const positions = new Map<string, number>();

  for (const rawCommand of commands) {
    const command = withBaseMetadata(rawCommand);
    const key = command.name.toLowerCase();
    const existingPosition = positions.get(key);
    if (existingPosition === undefined) {
      positions.set(key, deduped.length);
      deduped.push(command);
      continue;
    }

    const existing = deduped[existingPosition];
    const replace = existing.owner !== 'blackbox'
      && (command.owner === 'blackbox'
        || command.source === existing.source
        || (command.source === 'global' && existing.source === 'project'));
    if (replace) deduped[existingPosition] = command;
  }

  return deduped;
}

/**
 * Merge filesystem/app discovery with the authoritative live runtime inventory.
 * Claude-owned entries exist only when the active runtime advertises them.
 */
export function mergeRuntimeCommands(
  baseCommands: UnifiedCommand[],
  inventory?: RuntimeCommandInventory,
): UnifiedCommand[] {
  const base = dedupeBaseCommands(baseCommands);
  if (!inventory) return base;

  const normalized = normalizeInventory(inventory);
  const runtimeCommands = normalized.slashCommands as RuntimeCommandDescriptor[];
  const runtimeByName = new Map(
    runtimeCommands.map((command) => [command.name.toLowerCase(), command]),
  );

  const merged = base
    .filter((command) => {
      if (command.owner === 'blackbox' || command.owner === 'filesystem') return true;
      return runtimeByName.has(command.name.toLowerCase());
    })
    .map((command) => {
      if (command.owner === 'blackbox') return command;
      const runtime = runtimeByName.get(command.name.toLowerCase());
      if (!runtime) {
        return command.owner === 'filesystem'
          ? { ...command, availability: 'provisional' as const, runtime_available: false }
          : command;
      }
      const kind = runtime.kind || kindOf(command);
      return {
        ...command,
        description: runtime.description || command.description,
        owner: command.owner === 'filesystem' ? 'filesystem' as const : runtime.owner,
        kind,
        category: kind,
        availability: 'available' as const,
        runtime_available: true,
        runtime_kind: kind,
        argument_hint: runtime.argumentHint || command.argument_hint,
        aliases: runtime.aliases?.length ? runtime.aliases : command.aliases,
        has_args: Boolean(runtime.argumentHint) || command.has_args,
        immediate: false,
        execution: 'session' as const,
      };
    });

  const index = new Set(merged.map((command) => command.name.toLowerCase()));
  for (const runtime of runtimeCommands) {
    const key = runtime.name.toLowerCase();
    if (index.has(key)) continue;
    const kind = runtime.kind || 'command';
    merged.push({
      name: runtime.name,
      description: runtime.description || '',
      source: 'runtime',
      category: kind,
      owner: runtime.owner || 'claude',
      kind,
      availability: 'available',
      has_args: Boolean(runtime.argumentHint),
      path: undefined,
      immediate: false,
      argument_hint: runtime.argumentHint,
      aliases: runtime.aliases || [],
      execution: 'session',
      runtime_available: true,
      runtime_kind: kind,
    });
    index.add(key);
  }

  return merged;
}

interface CommandState {
  commands: UnifiedCommand[];
  isLoading: boolean;
  activeCwd: string;
  baseByCwd: Record<string, UnifiedCommand[]>;
  runtimeByCwd: Record<string, RuntimeCommandInventory>;
  activePrefix: UnifiedCommand | null;
  fetchCommands: (cwd?: string) => Promise<void>;
  recordRuntimeInventory: (inventory: RuntimeCommandInventory) => void;
  setActivePrefix: (cmd: UnifiedCommand) => void;
  clearPrefix: () => void;
}

export const useCommandStore = create<CommandState>()((set) => ({
  commands: [],
  isLoading: false,
  activeCwd: '',
  baseByCwd: {},
  runtimeByCwd: {},
  activePrefix: null,

  fetchCommands: async (cwd?: string) => {
    const key = cwdKey(cwd);
    set((state) => ({
      activeCwd: key,
      isLoading: true,
      commands: mergeRuntimeCommands(state.baseByCwd[key] || [], state.runtimeByCwd[key]),
    }));
    try {
      const commands = await bridge.listAllCommands(cwd);
      set((state) => {
        const baseByCwd = { ...state.baseByCwd, [key]: commands };
        if (state.activeCwd !== key) return { baseByCwd };
        return {
          baseByCwd,
          commands: mergeRuntimeCommands(commands, state.runtimeByCwd[key]),
          isLoading: false,
        };
      });
    } catch (err) {
      console.error('[commandStore] fetchCommands failed:', err);
      set((state) => state.activeCwd === key ? { isLoading: false } : {});
    }
  },

  recordRuntimeInventory: (inventory) => {
    const normalized = normalizeInventory(inventory);
    const key = cwdKey(normalized.cwd);
    set((state) => {
      const runtimeByCwd = { ...state.runtimeByCwd, [key]: normalized };
      if (state.activeCwd !== key) return { runtimeByCwd };
      return {
        runtimeByCwd,
        commands: mergeRuntimeCommands(state.baseByCwd[key] || [], normalized),
      };
    });
  },

  setActivePrefix: (cmd) => set({ activePrefix: cmd }),
  clearPrefix: () => set({ activePrefix: null }),
}));
