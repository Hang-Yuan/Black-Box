import { describe, expect, it } from 'vitest';
import { __streamAgentTeamsTesting } from '../useStreamProcessor';

describe('Agent Teams stream contract', () => {
  it('classifies Agent(name) as a persistent teammate', () => {
    expect(__streamAgentTeamsTesting.agentToolIdentity({
      name: 'Agent',
      input: {
        name: ' reader-alpha ',
        description: 'Inspect alpha',
        prompt: 'Read alpha.txt',
      },
    })).toEqual({
      kind: 'teammate',
      name: 'reader-alpha',
      description: 'reader-alpha',
    });
  });

  it('keeps unnamed Agent calls as one-shot subagents', () => {
    expect(__streamAgentTeamsTesting.agentToolIdentity({
      name: 'Agent',
      input: { description: 'Inspect alpha', prompt: 'Read alpha.txt' },
    })).toEqual({
      kind: 'subagent',
      name: undefined,
      description: 'Inspect alpha',
    });
  });

  it('never renders internal agent ids or private task-output paths', () => {
    const internal = 'agentId: a123; output_file: /private/tmp/claude/task.output';
    expect(__streamAgentTeamsTesting.sanitizeToolResultContent('Agent', internal)).toBe('');
    expect(__streamAgentTeamsTesting.sanitizeToolResultContent('SendMessage', internal)).toBe('');
    expect(__streamAgentTeamsTesting.sanitizeToolResultContent('Read', 'public result')).toBe('public result');
  });

  it('recognizes Claude async Agent launch receipts without treating the task as complete', () => {
    const launch = __streamAgentTeamsTesting.parseAsyncAgentLaunch({
      type: 'user',
      toolUseResult: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'a8855b2a710d2f92d',
        description: 'Inspect the code',
        resolvedModel: 'claude-sonnet-5',
        outputFile: '/private/tmp/agent.output',
      },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_launch', content: '' }],
      },
    });

    expect(launch).toEqual({
      toolUseId: 'toolu_launch',
      taskId: 'a8855b2a710d2f92d',
      description: 'Inspect the code',
      model: 'claude-sonnet-5',
    });
    expect(__streamAgentTeamsTesting.backgroundAgentNode(launch!, new Map())).toMatchObject({
      id: 'toolu_launch',
      taskId: 'a8855b2a710d2f92d',
      phase: 'thinking',
      background: true,
    });
  });

  it('parses durable task notifications with both correlation ids', () => {
    expect(__streamAgentTeamsTesting.parseAgentTaskNotification(`
      <task-notification>
        <task-id>a8855b2a710d2f92d</task-id>
        <tool-use-id>toolu_resumed</tool-use-id>
        <status>completed</status>
      </task-notification>
    `)).toEqual({
      taskId: 'a8855b2a710d2f92d',
      toolUseId: 'toolu_resumed',
      status: 'completed',
    });
  });

  it('keeps a durable Agent result available for the optional process panel', () => {
    expect(__streamAgentTeamsTesting.parseAgentTaskNotification(`
      <task-notification>
        <task-id>stable-task-id</task-id>
        <status>completed</status>
        <result>Verified the implementation.</result>
      </task-notification>
    `)).toMatchObject({
      taskId: 'stable-task-id',
      status: 'completed',
      resultText: 'Verified the implementation.',
    });
  });
});
