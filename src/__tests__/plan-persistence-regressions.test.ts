import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const streamSource = readFileSync(resolve(root, 'hooks/useStreamProcessor.ts'), 'utf8');
const appSource = readFileSync(resolve(root, 'App.tsx'), 'utf8');
const chatSource = readFileSync(resolve(root, 'components/chat/ChatPanel.tsx'), 'utf8');
const inputSource = readFileSync(resolve(root, 'components/chat/InputBar.tsx'), 'utf8');
const rustSource = readFileSync(resolve(root, '../src-tauri/src/lib.rs'), 'utf8');
const cliSource = readFileSync(resolve(root, '../scripts/blackbox-cli.mjs'), 'utf8');
const identitySource = readFileSync(resolve(root, 'lib/session-identity.ts'), 'utf8');

describe('persistent Plan integration regressions', () => {
  it('captures root TodoWrite updates but excludes teammate/subagent plans', () => {
    expect(streamSource).toContain("block.name === 'TodoWrite'");
    expect(streamSource).toContain('bgAgentDepth === 0 && !msg.parent_tool_use_id');
    expect(streamSource).toContain('agentDepth === 0 && !msg.parent_tool_use_id');
    expect(streamSource).toContain("setPlan(tabId, block.input.todos, undefined, 'todo')");
  });

  it('derives Plan from root native TaskCreate/TaskUpdate events', () => {
    expect(streamSource).toContain("block.name === 'TaskCreate' || block.name === 'TaskUpdate'");
    expect(streamSource).toContain('syncNativeTaskPlan(tabId');
    expect(streamSource).toContain("'native_tasks'");
    expect(streamSource).not.toContain('isBlackBoxUpdatePlanTool');
    expect(rustSource).not.toContain('blackbox_plan');
  });

  it('moves Plan authority with draft-to-real thread promotion', () => {
    expect(streamSource).toContain('captureCliSessionIdentity');
    expect(identitySource).toContain('usePlanStore.getState().movePlan(currentTabId, durableId)');
  });

  it('loads and renders the durable Plan control plane', () => {
    expect(appSource).toContain('usePlanStore.getState().loadPlans()');
    expect(chatSource).toContain('data-testid="persistent-plan"');
    expect(chatSource).toContain('getPlanProgress(plan.items)');
    expect(inputSource).toContain('data-testid="plan-toggle-button"');
  });

  it('uses bounded atomic application storage separate from Goal state', () => {
    expect(rustSource).toContain('blackbox_data_path("plans.json")');
    expect(rustSource).toContain('Plans payload exceeds the 1 MiB safety limit');
    expect(rustSource).toContain('Failed to atomically replace plans file');
  });

  it('keeps the CLI readout for the receipt-derived Plan', () => {
    expect(cliSource).toContain("async 'get-current-plan'");
  });
});
