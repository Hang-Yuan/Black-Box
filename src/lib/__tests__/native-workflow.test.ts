import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import {
  buildNativeWorkflowCommand,
  deriveNativeWorkflowRuns,
  parseNativeWorkflowReceipt,
} from '../native-workflow';

describe('native Claude workflows', () => {
  it('builds an explicit native Workflow tool request without aliasing another mode', () => {
    const command = buildNativeWorkflowCommand('release-review', 'Review v0.13.1');
    expect(command).toContain('saved native Claude Code workflow');
    expect(command).toContain('Workflow tool exactly once');
    expect(command).toContain('"name":"release-review"');
    expect(command).toContain('"args":"Review v0.13.1"');
    expect(command).toContain('do not substitute Agent, Skill, Loop, or Scheduled');
    expect(() => buildNativeWorkflowCommand('../escape', '')).toThrow();
  });

  it('parses the real async launch receipt fields', () => {
    expect(parseNativeWorkflowReceipt(JSON.stringify({
      status: 'async_launched',
      taskId: 'task_123',
      workflowName: 'release-review',
      runId: 'wf_123',
      transcriptDir: '/tmp/transcripts',
      scriptPath: '/tmp/release-review.js',
    }))).toEqual({
      status: 'running',
      taskId: 'task_123',
      workflowName: 'release-review',
      runId: 'wf_123',
      transcriptDir: '/tmp/transcripts',
      scriptPath: '/tmp/release-review.js',
      summary: undefined,
      error: undefined,
    });

    expect(parseNativeWorkflowReceipt([
      'Workflow launched in background. Task ID: ww2l8i4b5',
      'Summary: Verify a real named workflow',
      'Transcript dir: /tmp/transcripts/wf_123',
      'Script file: /tmp/scripts/workflow.js',
      'Run ID: wf_4fd9a3d7-623',
    ].join('\n'))).toEqual({
      status: 'running',
      taskId: 'ww2l8i4b5',
      runId: 'wf_4fd9a3d7-623',
      transcriptDir: '/tmp/transcripts/wf_123',
      scriptPath: '/tmp/scripts/workflow.js',
      summary: 'Verify a real named workflow',
    });
  });

  it('reconstructs workflow runs from persisted tool cards after reload', () => {
    const messages: ChatMessage[] = [{
      id: 'toolu_workflow_1',
      role: 'assistant',
      type: 'tool_use',
      content: '',
      toolName: 'Workflow',
      toolInput: { name: 'release-review', args: 'v0.13.1' },
      toolCompleted: true,
      toolResultContent: JSON.stringify({
        status: 'async_launched',
        workflowName: 'release-review',
        runId: 'wf_abc',
        taskId: 'task_abc',
      }),
      timestamp: 100,
    }];
    const [run] = deriveNativeWorkflowRuns(messages);
    expect(run.requestedName).toBe('release-review');
    expect(run.runId).toBe('wf_abc');
    expect(run.taskId).toBe('task_abc');
    expect(run.status).toBe('running');
  });
});
