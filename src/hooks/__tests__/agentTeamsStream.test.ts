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
});
