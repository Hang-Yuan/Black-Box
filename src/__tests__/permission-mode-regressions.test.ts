import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapSessionModeToPermissionMode } from '../stores/settingsStore';

const root = resolve(import.meta.dirname, '..');
const modeSelectorSource = readFileSync(resolve(root, 'components/chat/ModeSelector.tsx'), 'utf8');
const chatPanelSource = readFileSync(resolve(root, 'components/chat/ChatPanel.tsx'), 'utf8');
const inputBarSource = readFileSync(resolve(root, 'components/chat/InputBar.tsx'), 'utf8');
const backendSource = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');

describe('interactive Claude Code permission modes', () => {
  it('maps the five visible modes to current CLI permission values', () => {
    expect(mapSessionModeToPermissionMode('ask')).toBe('manual');
    expect(mapSessionModeToPermissionMode('code')).toBe('acceptEdits');
    expect(mapSessionModeToPermissionMode('plan')).toBe('plan');
    expect(mapSessionModeToPermissionMode('auto')).toBe('auto');
    expect(mapSessionModeToPermissionMode('bypass')).toBe('bypassPermissions');
  });

  it('shows one clickable selector in the chat header with all five modes', () => {
    expect(chatPanelSource).toContain('<ModeSelector placement="down" compact iconOnly={secondaryPanelOpen} />');
    for (const id of ['ask', 'code', 'plan', 'auto', 'bypass']) {
      expect(modeSelectorSource).toContain(`id: '${id}'`);
    }
    const menuOrder = ['ask', 'code', 'plan', 'auto', 'bypass']
      .map((id) => modeSelectorSource.indexOf(`id: '${id}'`));
    expect(menuOrder).toEqual([...menuOrder].sort((a, b) => a - b));
    expect(modeSelectorSource).not.toContain("id: 'dontAsk'");
  });

  it('keeps slash aliases aligned with the selector', () => {
    expect(inputBarSource).toContain("'/manual': 'ask'");
    expect(inputBarSource).toContain("'/auto': 'auto'");
    expect(inputBarSource).toContain('text = restText;');
    expect(inputBarSource).toContain('submittedUserText = restText;');
    expect(inputBarSource).toContain('content: submittedUserText,');
    expect(inputBarSource).toContain('pendingTurnInput: submittedUserText,');
    expect(inputBarSource).not.toContain('text = `${cmdPart} ${restText}`;');
    expect(inputBarSource).toContain('await bridge.setPermissionMode(');
    expect(backendSource).toContain('"/manual", "Switch to manual permission mode"');
    expect(backendSource).toContain('"/auto", "Switch to automatic permission mode"');
  });

  it('permits live Bypass switching through the SDK control protocol', () => {
    const watcher = readFileSync(resolve(root, 'stores/settingsStore.ts'), 'utf8')
      .split('// --- Runtime mode switching via SDK control protocol ---')[1];
    expect(watcher).toContain('bridge.setPermissionMode(stdinId, cliMode)');
    expect(watcher).not.toContain("if (cliMode === 'bypassPermissions') return");
  });
});
