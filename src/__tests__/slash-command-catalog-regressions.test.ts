import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('slash command catalogue', () => {
  it('keeps the complete runtime inventory available in the scrollable popover', () => {
    const popover = read('components/chat/SlashCommandPopover.tsx');
    const store = read('stores/commandStore.ts');

    expect(popover).toContain('if (!q) return visibleCommands;');
    expect(popover).toContain('return [...startsWithMatches, ...containsMatches];');
    expect(popover).not.toContain('.slice(0, 12)');
    expect(popover).toContain('max-h-[380px] overflow-y-auto');
    expect(store).toContain('for (const runtime of runtimeCommands)');
    expect(store).toContain('runtime_available: true');
    expect(popover).toContain("command.availability !== 'reference'");
    expect(popover).toContain("cmd.availability === 'provisional'");
  });

  it('does not truncate unfiltered or keyboard-navigable results at twelve commands', () => {
    const popover = read('components/chat/SlashCommandPopover.tsx');

    expect(popover).not.toMatch(/\.slice\(\s*0\s*,\s*12\s*\)/);
    expect(popover).toContain('{section.items.map((cmd) => {');
    expect(popover).toContain("listRef.current.querySelectorAll('[data-cmd-item]')");
  });

  it('parses command catalogue changes as full runtime replacements', () => {
    const stream = read('hooks/useStreamProcessor.ts');
    const store = read('stores/commandStore.ts');

    expect(stream.match(/msg\.subtype === 'commands_changed'/g)).toHaveLength(2);
    expect(stream).toContain('recordRuntimeCommandInventory(');
    expect(store).toContain('Array.isArray(value.commands)');
    expect(store).toContain('argumentHint');
    expect(store).toContain('aliases');
  });
});
