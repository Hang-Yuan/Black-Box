import { useEffect, useRef, useMemo } from 'react';
import { useCommandStore } from '../../stores/commandStore';
import { useT, t as tStatic } from '../../lib/i18n';
import type { UnifiedCommand } from '../../lib/tauri-bridge';

interface SlashCommandPopoverProps {
  query: string;
  visible: boolean;
  selectedIndex: number;
  onSelect: (command: UnifiedCommand) => void;
  onClose: () => void;
}

interface CommandSection {
  key: string;
  labelKey: string;
  items: UnifiedCommand[];
}

function filterCommands(commands: UnifiedCommand[], query: string): UnifiedCommand[] {
  // Cold official-reference entries are metadata only. They must never be
  // keyboard-selectable or presented as available before the live CLI says so.
  const visibleCommands = commands.filter((command) => command.availability !== 'reference');
  if (!visibleCommands.length) return [];
  const q = query.toLowerCase().trim();
  if (!q) return visibleCommands;

  const nameWithSlash = '/' + q;

  // First pass: commands whose name starts with the query (strongest match)
  const startsWithMatches = visibleCommands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(nameWithSlash)
    || cmd.aliases?.some((alias) => alias.toLowerCase().startsWith(nameWithSlash))
  );
  const startsWithNames = new Set(startsWithMatches.map((cmd) => cmd.name.toLowerCase()));

  // Second pass: commands whose name or description contains the query
  const containsMatches = visibleCommands.filter((cmd) => {
    // Skip already-matched commands
    if (startsWithNames.has(cmd.name.toLowerCase())) return false;
    // Match on description
    if (cmd.description.toLowerCase().includes(q)) return true;
    if (cmd.argument_hint?.toLowerCase().includes(q)) return true;
    if (cmd.aliases?.some((alias) => alias.toLowerCase().includes(q))) return true;
    // Also search translated descriptions for builtin commands
    if (cmd.category === 'builtin') {
      const localDesc = tStatic(`slash.desc.${cmd.name.slice(1)}`);
      if (localDesc && localDesc.toLowerCase().includes(q)) return true;
    }
    return false;
  });

  return [...startsWithMatches, ...containsMatches];
}

function groupCommands(filtered: UnifiedCommand[]): CommandSection[] {
  const sections: CommandSection[] = [];

  const builtin = filtered.filter(c => c.category === 'builtin');
  const projectCmds = filtered.filter(c => c.category === 'command' && c.source === 'project');
  const globalCmds = filtered.filter(c => c.category === 'command' && c.source === 'global');
  const runtimeCmds = filtered.filter(c => c.category === 'command' && c.source === 'runtime');
  const runtimeWorkflows = filtered.filter(c => c.kind === 'workflow' && c.source === 'runtime');
  const projectSkills = filtered.filter(c => c.category === 'skill' && c.source === 'project');
  const globalSkills = filtered.filter(c => c.category === 'skill' && c.source === 'global');
  const runtimeSkills = filtered.filter(c => c.category === 'skill' && c.source === 'runtime');

  if (builtin.length) sections.push({ key: 'builtin', labelKey: 'slash.builtin', items: builtin });
  if (projectCmds.length) sections.push({ key: 'projectCmds', labelKey: 'slash.projectCommands', items: projectCmds });
  if (globalCmds.length) sections.push({ key: 'globalCmds', labelKey: 'slash.globalCommands', items: globalCmds });
  if (runtimeCmds.length) sections.push({ key: 'runtimeCmds', labelKey: 'slash.runtimeCommands', items: runtimeCmds });
  if (runtimeWorkflows.length) sections.push({ key: 'runtimeWorkflows', labelKey: 'slash.runtimeWorkflows', items: runtimeWorkflows });
  if (projectSkills.length) sections.push({ key: 'projectSkills', labelKey: 'slash.projectSkills', items: projectSkills });
  if (globalSkills.length) sections.push({ key: 'globalSkills', labelKey: 'slash.globalSkills', items: globalSkills });
  if (runtimeSkills.length) sections.push({ key: 'runtimeSkills', labelKey: 'slash.runtimeSkills', items: runtimeSkills });

  return sections;
}

export function SlashCommandPopover({
  query,
  visible,
  selectedIndex,
  onSelect,
  onClose: _onClose,
}: SlashCommandPopoverProps) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useCommandStore((s) => s.commands);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const sections = useMemo(() => groupCommands(filtered), [filtered]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-cmd-item]');
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!visible || filtered.length === 0) return null;

  // Build flat index for rendering
  let flatIndex = 0;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1
        bg-bg-card border border-border-subtle rounded-lg shadow-lg
        py-1 z-50 max-h-[380px] overflow-y-auto
        animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      {sections.map((section, sIdx) => (
        <div key={section.key}>
          {/* Section divider (not for first) */}
          {sIdx > 0 && <div className="mx-3 my-1 border-t border-border-subtle" />}

          {/* Section header */}
          <div className="px-3 py-1 text-[11px] text-text-tertiary font-medium uppercase tracking-wider">
            {t(section.labelKey)}
          </div>

          {section.items.map((cmd) => {
            const idx = flatIndex++;
            const isSkill = cmd.category === 'skill';

            return (
              <button
                key={`${cmd.source}-${cmd.category}-${cmd.name}`}
                data-cmd-item
                onClick={() => onSelect(cmd)}
                className={`w-full text-left px-3 py-2 flex items-center gap-3
                  transition-smooth text-xs
                  ${idx === selectedIndex
                    ? 'bg-accent/10 text-accent border-l-2 border-l-accent'
                    : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary border-l-2 border-l-transparent'
                  }`}
              >
                {/* Icon: / for commands, diamond for skills */}
                <span className={`flex-shrink-0 w-6 h-6 rounded-md
                  bg-bg-tertiary flex items-center justify-center
                  text-[11px] font-bold ${isSkill ? 'text-accent' : 'text-text-tertiary font-mono'}`}>
                  {isSkill ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
                    </svg>
                  ) : '/'}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium font-mono text-[12px]">{cmd.name}</span>
                    {cmd.execution === 'cli' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-500 font-medium">
                        {t('slash.cli')}
                      </span>
                    )}
                    {cmd.execution === 'session' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500 font-medium">
                        {t('slash.session')}
                      </span>
                    )}
                    {cmd.runtime_available && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 font-medium">
                        {t('slash.runtime')}
                      </span>
                    )}
                    {cmd.owner === 'blackbox' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 font-medium">
                        {t('slash.blackbox')}
                      </span>
                    )}
                    {cmd.availability === 'provisional' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-400 font-medium">
                        {t('slash.provisional')}
                      </span>
                    )}
                    {cmd.execution === 'ui' && cmd.immediate && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary font-medium">
                        {t('slash.immediate')}
                      </span>
                    )}
                    {cmd.has_args && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent font-medium">
                        {t('slash.hasArgs')}
                      </span>
                    )}
                  </div>
                  <div className="text-text-tertiary text-[11px] truncate mt-0.5">
                    {(() => {
                      if (cmd.category !== 'builtin') {
                        return cmd.description || t(cmd.category === 'skill'
                          ? 'slash.runtimeSkillDesc'
                          : 'slash.runtimeCommandDesc');
                      }
                      const key = `slash.desc.${cmd.name.slice(1)}`;
                      const localized = t(key);
                      return localized === key ? cmd.description : localized;
                    })()}
                  </div>
                  {cmd.argument_hint && (
                    <div className="mt-0.5 text-[9px] text-text-tertiary font-mono truncate">
                      {cmd.argument_hint}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Return filtered command list for keyboard navigation */
export function getFilteredCommandList(commands: UnifiedCommand[], query: string): UnifiedCommand[] {
  return filterCommands(commands, query);
}
