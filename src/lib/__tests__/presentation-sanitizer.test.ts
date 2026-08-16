import { describe, expect, it } from 'vitest';
import {
  isCliPlaceholder,
  sanitizeAssistantTextForDisplay,
  sanitizeToolResultForDisplay,
} from '../presentation-sanitizer';

describe('agent presentation sanitizer', () => {
  it('removes the complete raw task notification while preserving surrounding lead prose', () => {
    const raw = `Waiting for the teammate.

<task-notification id="a6d0a11503796be67">
ui-reader (a6d0a11503796be67): Completed

The marker is UI_AGENT_TEAM_MARKER_R2O.
</task-notification>`;

    const safe = sanitizeAssistantTextForDisplay(raw);
    expect(safe).toBe('Waiting for the teammate.\n\n');
    expect(safe).not.toContain('ui-reader: Completed');
    expect(safe).not.toContain('UI_AGENT_TEAM_MARKER_R2O');
    expect(safe).not.toContain('a6d0a11503796be67');
    expect(safe).not.toContain('task-notification');
  });

  it('removes raw task metadata and private Claude output paths', () => {
    const raw = `<task-id>internal-task</task-id>
<tool-use-id>tooluse-secret</tool-use-id>
<output-file>/private/tmp/claude-501/private.output</output-file>
agentId: secret-agent-123456
output_file: /private/tmp/claude-501/private.output
Useful result`;

    const safe = sanitizeAssistantTextForDisplay(raw);
    expect(safe).toContain('Useful result');
    expect(safe).not.toContain('internal-task');
    expect(safe).not.toContain('tooluse-secret');
    expect(safe).not.toContain('secret-agent');
    expect(safe).not.toContain('/private/tmp');
  });

  it('suppresses Agent and SendMessage results but preserves ordinary tools', () => {
    const internal = 'agentId: a123456789012; output_file: /private/tmp/claude-501/x.output';
    expect(sanitizeToolResultForDisplay('Agent', internal)).toBe('');
    expect(sanitizeToolResultForDisplay('SendMessage', internal)).toBe('');
    expect(sanitizeToolResultForDisplay('Read', 'visible file content')).toBe('visible file content');
  });

  it('shares one placeholder filter across live and restored projections', () => {
    expect(isCliPlaceholder(' No response requested. ')).toBe(true);
    expect(isCliPlaceholder(' [Request interrupted by user] ')).toBe(true);
    expect(sanitizeAssistantTextForDisplay('No response requested.')).toBe('');
    expect(sanitizeAssistantTextForDisplay('[Request interrupted by user]')).toBe('');
    expect(sanitizeAssistantTextForDisplay('A real response.')).toBe('A real response.');
  });

});
