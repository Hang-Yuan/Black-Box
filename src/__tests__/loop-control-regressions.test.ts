import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const loopControl = readFileSync(resolve(root, 'components/chat/LoopControl.tsx'), 'utf8');
const inputBar = readFileSync(resolve(root, 'components/chat/InputBar.tsx'), 'utf8');
const chatPanel = readFileSync(resolve(root, 'components/chat/ChatPanel.tsx'), 'utf8');
const taskComposer = readFileSync(resolve(root, 'components/chat/TaskComposerModeBar.tsx'), 'utf8');
const backend = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
const commandStore = readFileSync(resolve(root, 'stores/commandStore.ts'), 'utf8');

describe('native Loop control', () => {
  it('mounts beside Goal and routes through the normal composer lifecycle', () => {
    expect(chatPanel).toContain('<LoopControl');
    expect(chatPanel.indexOf('<LoopControl'))
      .toBeLessThan(chatPanel.indexOf('<GoalControl'));
    expect(chatPanel).toContain("onSelect={() => selectTaskMode('loop')}");
    expect(loopControl).toContain("new CustomEvent('blackbox:loop-submit'");
    expect(inputBar).toContain("window.addEventListener('blackbox:loop-submit'");
    expect(inputBar).toContain('queueMicrotask(() => handleSubmitRef.current())');
    expect(inputBar).toContain('prompt: text');
    expect(inputBar).toContain('init only after it receives the first message');
    expect(inputBar).not.toContain('sendAfterStdinReady');
  });

  it('waits for native Cron receipts instead of running a second scheduler', () => {
    expect(loopControl).toContain('useLoopStore');
    expect(loopControl).toContain('job.threadId === tabId');
    expect(loopControl).toContain('CronDelete');
    expect(loopControl).toContain('CronList');
    expect(loopControl).toContain('data-testid="loop-verify"');
    expect(loopControl).toContain('data-loop-cancel-id={job.jobId}');
    expect(loopControl).toContain('data-loop-live={jobsRunning');
    expect(loopControl).toContain("t('loop.resumePending')");
    expect(loopControl).not.toContain('setInterval(');
    expect(loopControl).not.toContain('setTimeout(');
    expect(loopControl).not.toContain('tab.messages');
  });

  it('explains when Loop is appropriate in readable toolbar copy', () => {
    expect(loopControl).toContain('data-testid="loop-explainer"');
    expect(loopControl).toContain('text-xs leading-relaxed');
    expect(loopControl).toContain("t('loop.sessionHint')");
  });

  it('uses Claude native minimum cadence instead of advertising seconds', () => {
    expect(taskComposer).toContain('validateNativeLoopInterval(config.loopInterval)');
    expect(taskComposer).not.toContain("placeholder=\"30s\"");
    expect(loopControl).not.toContain('<textarea');
  });

  it('discovers /loop and /proactive from the live runtime instead of inventing immediate controls', () => {
    const blackBoxCatalog = backend.slice(
      backend.indexOf('let blackbox_commands:'),
      backend.indexOf('for (name, description, has_args) in blackbox_commands'),
    );
    expect(blackBoxCatalog).not.toContain('"/loop"');
    expect(blackBoxCatalog).not.toContain('"/proactive"');
    expect(commandStore).toContain('for (const runtime of runtimeCommands)');
    expect(commandStore).toContain("execution: 'session'");
    expect(commandStore).toContain('runtime_available: true');
  });
});
