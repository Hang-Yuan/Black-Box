import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('first-class native Workflow regressions', () => {
  it('registers native catalog/read/save commands without a delete shortcut', () => {
    const backend = read('../src-tauri/src/workflow_manager.rs');
    const lib = read('../src-tauri/src/lib.rs');
    const bridge = read('lib/tauri-bridge.ts');
    for (const command of [
      'list_workflows',
      'read_workflow_source',
      'save_workflow',
      'load_workflow_runs',
      'save_workflow_runs',
    ]) {
      expect(lib).toContain(`workflow_manager::${command}`);
      expect(backend).toContain(`fn ${command}`);
    }
    expect(backend).toContain('Claude workflows must use the .js extension');
    expect(backend).toContain('export const meta');
    expect(backend).toContain('blackbox-workflow-manifest');
    expect(backend).toContain('workflow-runs.json');
    expect(bridge).toContain("invoke<WorkflowRecord[]>('list_workflows'");
    expect(backend).not.toContain('pub fn delete_workflow');
  });

  it('keeps Workflow distinct from permission modes, Loop, Goal, and Scheduled', () => {
    const chat = read('components/chat/ChatPanel.tsx');
    const workflow = read('components/chat/WorkflowControl.tsx');
    const input = read('components/chat/InputBar.tsx');
    expect(chat).toContain('<WorkflowControl');
    expect(chat).toContain('<LoopControl');
    expect(chat).toContain('<GoalControl');
    expect(chat).toContain("onSelect={() => selectTaskMode('workflow')}");
    expect(input).toContain('useWorkflowStore.getState().queueSubmission(');
    expect(input).toContain('pendingWorkflowSubmission');
    expect(input).toContain('consumeSubmission(selectedSessionId)');
    expect(input).toContain('buildTaskComposerSubmission(taskComposer.taskMode, rawInput');
    expect(input).toContain("planned.value.kind === 'workflow-auto'");
    expect(workflow).toContain('data-testid="workflow-explainer"');
    expect(workflow).toContain('data-testid="workflow-activate-option"');
    expect(workflow).toContain('text-xs leading-relaxed');
    expect(workflow).not.toContain('<textarea');
  });

  it('defaults to semantic orchestration and remains selectable while a turn is running', () => {
    const chat = read('components/chat/ChatPanel.tsx');
    const input = read('components/chat/InputBar.tsx');
    const composer = read('components/chat/TaskComposerModeBar.tsx');
    const composerContract = read('lib/composer-mode.ts');
    const nativeWorkflow = read('lib/native-workflow.ts');
    expect(composer).toContain('data-testid="workflow-auto-option"');
    expect(composer).toContain('data-testid="workflow-auto-hint"');
    expect(composerContract).toContain("kind: 'workflow-auto'");
    expect(nativeWorkflow).toContain('export function buildAutoWorkflowCommand');
    expect(nativeWorkflow).toContain('Interpret the user task semantically');
    const workflowControl = chat.slice(chat.indexOf('<WorkflowControl'), chat.indexOf('/>', chat.indexOf('<WorkflowControl')));
    expect(workflowControl).not.toContain('disabled=');
    expect(input).toContain('{selectedSessionId && composerModeTab.taskMode && !floatingCard && (');
    expect(input).not.toContain('taskComposer.taskMode && !isSessionBusy');
  });

  it('shows native workflows in the extension center and binds real stream receipts', () => {
    const center = read('components/extensions/ExtensionCenter.tsx');
    const catalog = read('components/extensions/WorkflowCatalog.tsx');
    const stream = read('hooks/useStreamProcessor.ts');
    const store = read('stores/workflowStore.ts');
    expect(center).toContain('<WorkflowCatalog />');
    expect(center).toContain("id: 'workflows'");
    expect(catalog).toContain('data-testid="workflow-editor"');
    expect(catalog).toContain('blackBoxManaged');
    expect(stream).toContain('useWorkflowStore.getState().applyStreamEvent(tabId, msg)');
    expect(store).toContain("progressType === 'workflow_phase'");
    expect(store).toContain("message.subtype === 'task_notification'");
    expect(store).toContain('persistRunLedger');
    expect(store).toContain("'interrupted' as const");
  });
});
