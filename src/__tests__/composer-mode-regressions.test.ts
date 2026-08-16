import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

const chat = read('components/chat/ChatPanel.tsx');
const input = read('components/chat/InputBar.tsx');
const goal = read('components/chat/GoalControl.tsx');
const workflow = read('components/chat/WorkflowControl.tsx');
const loop = read('components/chat/LoopControl.tsx');
const modeBar = read('components/chat/TaskComposerModeBar.tsx');

describe('single task composer modes', () => {
  it('uses the header buttons only to select one composer mode', () => {
    expect(chat).toContain("onSelect={() => selectTaskMode('goal')}");
    expect(chat).toContain("onSelect={() => selectTaskMode('workflow')}");
    expect(chat).toContain("onSelect={() => selectTaskMode('loop')}");
    for (const [source, id] of [
      [goal, 'goal'],
      [workflow, 'workflow'],
      [loop, 'loop'],
    ] as const) {
      expect(source).toContain('onClick={selectMode}');
      expect(source).toContain('setOpen(false);');
      expect(source).toContain(`announceHeaderPopover('${id}')`);
      expect(source).toContain('onSelect();');
    }
  });

  it('closes stale management popovers whenever the primary mode changes', () => {
    for (const source of [goal, workflow, loop]) {
      const selectMode = source.split('const selectMode = () => {')[1]?.split('\n  };')[0] || '';
      expect(selectMode).toContain('setOpen(false);');
      expect(selectMode).toContain('announceHeaderPopover(');
      expect(selectMode).toContain('onSelect();');
    }
    expect(workflow).toContain('data-testid="workflow-popover"');
    expect(loop).toContain('data-testid="loop-popover"');
    expect(goal).toContain('data-testid="goal-popover"');
  });

  it('keeps task descriptions exclusively in the main composer', () => {
    expect(goal).not.toContain('<textarea');
    expect(workflow).not.toContain('<textarea');
    expect(loop).not.toContain('<textarea');
    expect(modeBar).not.toContain('<textarea');
    expect(input).toContain('<TaskComposerModeBar');
    expect(input).toContain('<TiptapEditor');
    expect(modeBar).toContain('data-testid="workflow-auto-option"');
    expect(modeBar).toContain("t('workflow.auto')");
  });

  it('hands each mode to the runtime-authoritative Claude pipeline', () => {
    expect(input).toContain('text = planned.value.command;');
    expect(input).not.toContain("new CustomEvent('blackbox:goal-create'");
    expect(input).toContain('useWorkflowStore.getState().requestRun(tabId, selectedWorkflow)');
    expect(input).toContain('useWorkflowStore.getState().queueSubmission(');
    expect(input).toContain("planned.value.kind === 'workflow-auto'");
    expect(input).toContain('let submittedUserText = rawInput.trim();');
    expect(input).toContain('content: submittedUserText,');
    expect(input).toContain("new CustomEvent('blackbox:loop-submit'");
  });

  it('keeps the Goal header visibly live for the foreground Goal turn', () => {
    expect(input).toContain('submittedViaGoal = true;');
    expect(input).toContain('goalRequestActive: submittedViaGoal,');
    expect(chat).toContain('sessionMeta.goalRequestActive === true && isSessionBusy(sessionStatus)');
    expect(chat).toContain('running={goalRequestRunning}');
    expect(goal).toContain('data-goal-live={running');
    expect(goal).toContain("'bg-accent animate-pulse-soft'");
  });

  it('offers the same activate action from every split-button menu', () => {
    expect(workflow).toContain('data-testid="workflow-activate-option"');
    expect(loop).toContain('data-testid="loop-activate-option"');
    expect(goal).toContain('data-testid="goal-create-option"');
    for (const source of [workflow, loop, goal]) {
      expect(source).toContain('data-active={active');
      expect(source).toContain('disabled={active || disabled');
    }
  });

  it('shows an explicit Steer/Queue choice only when no interaction owns input', () => {
    expect(input).toContain('data-testid="busy-delivery-selector"');
    expect(input).toContain('isRunning && !isStopping && !isAwaiting && !floatingCard');
    expect(input).toContain("const busyDeliveryMode = getComposerModeTab(tabId).busyDelivery;");
    expect(input).toContain("const canSteerNow = busyDeliveryMode === 'steer'");
  });
});
