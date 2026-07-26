import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const inputBar = readFileSync(
  resolve(__dirname, '../components/chat/InputBar.tsx'),
  'utf8',
);
const streamProcessor = readFileSync(
  resolve(__dirname, '../hooks/useStreamProcessor.ts'),
  'utf8',
);

describe('live steer regressions', () => {
  it('sends guidance directly to the active stdin without starting a new turn', () => {
    const gate = inputBar.indexOf('const canSteerNow =');
    const liveSend = inputBar.indexOf('await bridge.sendStdin(existingStdinId, text);', gate);
    const normalTurn = inputBar.indexOf('// Normal path: show user message immediately');

    expect(gate).toBeGreaterThan(-1);
    expect(liveSend).toBeGreaterThan(gate);
    expect(liveSend).toBeLessThan(normalTurn);
    expect(inputBar.slice(gate, liveSend)).not.toContain('markTurnStarted');
    expect(inputBar.slice(gate, liveSend)).not.toContain('resetForTurn');
  });

  it('blocks normal steer submission while an interaction card owns input', () => {
    const interactionGate = inputBar.indexOf('if (hasUnresolvedInteraction) {');
    const steerGate = inputBar.indexOf('const canSteerNow =');
    expect(interactionGate).toBeGreaterThan(-1);
    expect(steerGate).toBeGreaterThan(interactionGate);
  });

  it('flushes startup guidance after the initial prompt on the same stdin', () => {
    const initial = streamProcessor.indexOf('await bridge.sendStdin(stdinId, pendingReady.text);');
    const steer = streamProcessor.indexOf('await bridge.sendStdin(stdinId, steer.text);', initial);
    expect(initial).toBeGreaterThan(-1);
    expect(steer).toBeGreaterThan(initial);
    expect(streamProcessor).toContain('store.takePendingSteers(tabId, stdinId)');
  });

  it('surfaces explicit steer copy instead of generic follow-up copy', () => {
    expect(inputBar).toContain("'input.steerPlaceholder'");
    expect(inputBar).toContain("'input.steerSend'");
    expect(inputBar).toContain('data-testid="busy-delivery-selector"');
    expect(inputBar).toContain('data-testid={`busy-delivery-${mode}`}');
    expect(inputBar).toContain("? 'input.queuePlaceholder'");
    expect(inputBar).toContain("? 'input.queueSend'");
    expect(inputBar).toContain('!floatingCard');
  });
});
