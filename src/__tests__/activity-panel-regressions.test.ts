import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const activityPanel = readFileSync(
  resolve(__dirname, '../components/activity/ActivityPanel.tsx'),
  'utf8',
);
const secondaryPanel = readFileSync(
  resolve(__dirname, '../components/layout/SecondaryPanel.tsx'),
  'utf8',
);
const appShell = readFileSync(
  resolve(__dirname, '../components/layout/AppShell.tsx'),
  'utf8',
);
const chatPanel = readFileSync(
  resolve(__dirname, '../components/chat/ChatPanel.tsx'),
  'utf8',
);
const settingsStore = readFileSync(resolve(__dirname, '../stores/settingsStore.ts'), 'utf8');
const conversationList = readFileSync(
  resolve(__dirname, '../components/conversations/ConversationList.tsx'),
  'utf8',
);
const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
const sidebar = readFileSync(resolve(__dirname, '../components/layout/Sidebar.tsx'), 'utf8');

describe('long-task activity panel', () => {
  it('is a real selectable and closable secondary-panel tab', () => {
    expect(settingsStore).toContain("export type SecondaryPanelTab = 'activity' | 'files'");
    expect(secondaryPanel).toContain("id: 'activity'");
    expect(secondaryPanel).toContain("activeTab === 'activity' && <ActivityPanel />");
    expect(chatPanel).toContain('data-testid="activity-panel-toggle"');
    expect(chatPanel).toContain('data-testid="agent-panel-toggle"');
    expect(chatPanel).toContain("openSecondaryTab('activity')");
    expect(chatPanel).toContain("openSecondaryTab('files')");
  });

  it('keeps header labels independent from the secondary-panel open state', () => {
    expect(chatPanel).toContain('<ProviderQuickSelector />');
    expect(chatPanel).toContain('<ModeSelector placement="down" compact />');
    expect(chatPanel).toContain('<WorkflowControl');
    expect(chatPanel).toContain('<LoopControl');
    expect(chatPanel).toContain('<GoalControl');
    expect(chatPanel).toContain("active={taskComposerMode === 'workflow'}");
    expect(chatPanel).toContain("active={taskComposerMode === 'loop'}");
    expect(chatPanel).toContain("active={taskComposerMode === 'goal'}");
    expect(chatPanel).not.toContain('compact={secondaryPanelOpen}');
    expect(chatPanel).not.toContain('iconOnly={secondaryPanelOpen}');
  });

  it('mounts a bounded visible shell instead of exposing a zero-width panel to macOS', () => {
    expect(appShell).toContain('secondary && showSecondary &&');
    expect(appShell).toContain('data-testid="secondary-panel-shell"');
    expect(appShell).toContain('flexBasis: `${visibleSecondaryPanelWidth}px`');
    expect(appShell).not.toContain("style={{ width: showSecondary ? `${secondaryPanelWidth}px` : '0px' }}");
  });

  it('aggregates the durable progress authorities instead of inventing a second runtime', () => {
    expect(activityPanel).toContain('usePlanStore');
    expect(activityPanel).toContain('useWorkflowStore');
    expect(activityPanel).toContain('useAgentStore');
    expect(activityPanel).toContain('useLoopStore');
    expect(activityPanel).toContain('bridge.listAutomationActivitySummaries()');
    expect(activityPanel).toContain('getPlanProgress(plan.items)');
    expect(activityPanel).not.toContain('useGoalStore');
    expect(activityPanel).not.toContain('<Section title="Goal"');
    expect(activityPanel).not.toContain('Goal / Go');
  });

  it('uses a stable empty workflow snapshot so Zustand cannot trigger a render loop', () => {
    expect(activityPanel).toContain('const EMPTY_WORKFLOW_RUNS: LiveWorkflowRun[] = [];');
    expect(activityPanel).toContain('state.liveRuns[tabId] ?? EMPTY_WORKFLOW_RUNS');
    expect(activityPanel).not.toContain('state.liveRuns[tabId] || []');
  });

  it('does not count the main agent as a subagent', () => {
    expect(activityPanel).toContain('.filter((agent) => !agent.isMain)');
    expect(activityPanel).toContain("visibleAgents.filter((agent) => !['idle', 'completed', 'error'].includes(agent.phase))");
  });

  it('clears the live Agent/Task authority when a new conversation starts', () => {
    expect(conversationList).toContain('useAgentStore.getState().restoreFromCache(newDraftId)');
    expect(app).toContain('useAgentStore.getState().restoreFromCache(newId)');
    expect(sidebar).toContain('useAgentStore.getState().clearAgents()');
  });

  it('shows the actual subagent roster and Workflow progress details', () => {
    expect(activityPanel).toContain("title={t('activity.agents')}");
    expect(activityPanel).toContain('visibleAgents.slice(0, 12).map');
    expect(activityPanel).toContain('agent.currentTool');
    expect(activityPanel).toContain('data-activity-agent-phase={agent.phase}');
    expect(activityPanel).toContain('data-activity-task-status={task.status}');
    expect(activityPanel).toContain('run.summary');
    expect(activityPanel).toContain("phase.state === 'completed'");
    expect(activityPanel).toContain("agent.name || t('agents.claudeSubAgent')");
    expect(activityPanel).toContain('agent.model || auxiliaryModel');
    expect(activityPanel).toContain('taskDescription');
  });

  it('keeps native loop wakeups visibly active between foreground turns', () => {
    expect(activityPanel).toContain('tab.sessionMeta.stdinId && tab.sessionMeta.stdinReady');
    expect(activityPanel).toContain("loopJobs.some((job) => job.status === 'running')");
    expect(activityPanel).toContain("['thinking', 'writing', 'tool', 'awaiting']");
    expect(activityPanel).toContain("const busy = sessionStatus === 'running'");
    expect(activityPanel).toContain('|| backgroundActive');
    expect(activityPanel).toContain('|| activeLoop');
    expect(activityPanel).toContain("data-activity-loop-state={activeLoop ? 'active' : 'resume-pending'}");
    expect(activityPanel).not.toContain("StatusDot tone={busy ? 'active' : 'waiting'}");
  });

  it('includes persistent Scheduled work in the aggregate running state', () => {
    expect(activityPanel).toContain("automation.definitionStatus.toUpperCase() === 'ACTIVE' || automation.running");
    expect(activityPanel).toContain('|| automationRunning');
    expect(activityPanel).toContain("automationRunning\n    ? t('activity.scheduled')");
    expect(activityPanel).toContain('active={automationRunning}');
  });

  it('polls the durable Scheduled authority and preserves the last good snapshot', () => {
    expect(activityPanel).toContain('const AUTOMATION_POLL_INTERVAL_MS = 2_500;');
    expect(activityPanel).toContain('const pollAutomations = async () =>');
    expect(activityPanel).toContain('window.setInterval(');
    expect(activityPanel).toContain('AUTOMATION_POLL_INTERVAL_MS');
    expect(activityPanel).toContain('window.clearInterval(interval)');
    expect(activityPanel).toContain('if (!cancelled) {');
    expect(activityPanel).toContain('setAutomations(nextAutomations)');
    expect(activityPanel).toContain('data-activity-automation-id={automation.id}');
    expect(activityPanel).toContain("data-activity-automation-running={automation.running ? 'true' : 'false'}");
  });

  it('keeps raw outputs and sources subordinate to actionable task state', () => {
    expect(activityPanel).toContain('run.phases.map');
    expect(activityPanel).toContain('task.activeForm || task.subject');
    expect(activityPanel).not.toContain('goal.waitReason');
    expect(activityPanel).not.toContain('Sources');
    expect(activityPanel).not.toContain('输出文件');
  });
});
