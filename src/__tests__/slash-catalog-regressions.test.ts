import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rust = readFileSync(resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');
const store = readFileSync(resolve(__dirname, '../stores/commandStore.ts'), 'utf8');

describe('slash command discovery', () => {
  it('keeps only Black Box-owned UI controls in the cold static catalogue', () => {
    const start = rust.indexOf('let blackbox_commands:');
    const end = rust.indexOf('fn read_small_text_file', start);
    const catalogue = rust.slice(start, end);

    for (const command of [
      '/ask',
      '/auto',
      '/bypass',
      '/code',
      '/manual',
      '/todos',
    ]) expect(catalogue).toContain(`\"${command}\"`);

    for (const nativeCommand of ['/goal', '/loop', '/agents', '/workflows']) {
      expect(catalogue).not.toContain(`\"${nativeCommand}\"`);
    }
    expect(catalogue).not.toContain('codex-goal');
    expect(catalogue).toContain('owner: "blackbox"');
    expect(catalogue).toContain('availability: "available"');
  });

  it('treats the active CLI inventory as the Claude command authority', () => {
    expect(store).toContain("command.owner === 'blackbox' || command.owner === 'filesystem'");
    expect(store).toContain(": 'reference'");
    expect(store).toContain('runtimeByName.has(command.name.toLowerCase())');
    expect(store).toContain('commands_changed');
  });

  it('discovers nested and ancestor-local Claude configuration safely', () => {
    expect(rust).toContain('format!(\"/{}\", parts.join(\":\"))');
    expect(rust).toContain('.ancestors()');
    expect(rust).toContain('MAX_COMMAND_FILE_BYTES');
    expect(rust).toContain('entry.file_type()');
    expect(rust).toContain('availability: "provisional"');
  });
});
