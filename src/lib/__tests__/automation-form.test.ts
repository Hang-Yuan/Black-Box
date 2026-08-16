import { describe, expect, it } from 'vitest';
import {
  createAutomationDraft,
  isAutomationDraftComplete,
  prepareAutomationDefinitionForSave,
} from '../automation-form';

describe('scheduled-task form contract', () => {
  it('prefills project context while inheriting the user system defaults', () => {
    const draft = createAutomationDraft('/tmp/project', 'thread-123', 42);

    expect(draft.model).toBeNull();
    expect(draft.auxiliary_model).toBeNull();
    expect(draft.agent_teams_enabled).toBe(false);
    expect(draft.data_write_subdirectories).toEqual([]);
    expect(draft.execution_environment).toBe('worktree');
    expect(draft.target).toEqual({ type: 'project', projectId: '/tmp/project' });
    expect(draft.cwds).toEqual(['/tmp/project']);
    expect(draft.target_thread_id).toBe('thread-123');
    expect(draft).not.toHaveProperty('provider_id');
    expect(draft).not.toHaveProperty('provider_revision');
    expect(draft.created_at).toBe(42);
    expect(draft.updated_at).toBe(42);
  });

  it('strips legacy provider bindings when an old task is saved', () => {
    const draft = {
      ...createAutomationDraft('/tmp/project', null, 42),
      name: 'Portable task',
      prompt: 'Do the work',
      provider_id: 'deleted-provider',
      provider_revision: 99,
    };

    const definition = prepareAutomationDefinitionForSave(draft, 'FREQ=DAILY;BYHOUR=9');

    expect(definition).not.toHaveProperty('provider_id');
    expect(definition).not.toHaveProperty('provider_revision');
  });

  it('forces Heartbeat onto the selected conversation local cwd', () => {
    const draft = {
      ...createAutomationDraft('/tmp/original', 'thread-456', 42),
      kind: 'heartbeat' as const,
      name: 'Return to thread',
      prompt: 'Continue the review',
      execution_environment: 'worktree' as const,
      target: { type: 'project' as const, projectId: '/tmp/ignored' },
      cwds: ['  /tmp/original  '],
    };

    const definition = prepareAutomationDefinitionForSave(draft, 'FREQ=HOURLY;INTERVAL=1');

    expect(definition.execution_environment).toBe('local');
    expect(definition.target).toBeNull();
    expect(definition.target_thread_id).toBe('thread-456');
    expect(definition.cwds).toEqual(['/tmp/original']);
  });

  it('trims Cron project paths and clears a dormant Heartbeat target', () => {
    const draft = {
      ...createAutomationDraft('  /tmp/project  ', 'thread-unused', 42),
      name: 'Daily review',
      prompt: 'Review the project',
    };

    const definition = prepareAutomationDefinitionForSave(draft, 'FREQ=DAILY;BYHOUR=9');

    expect(definition.target).toEqual({ type: 'project', projectId: '/tmp/project' });
    expect(definition.cwds).toEqual(['/tmp/project']);
    expect(definition.target_thread_id).toBeNull();
  });

  it('requires human fields plus the appropriate target before enabling save', () => {
    const cron = createAutomationDraft('/tmp/project', null, 42);
    expect(isAutomationDraftComplete(cron)).toBe(false);
    expect(isAutomationDraftComplete({ ...cron, name: 'Task', prompt: 'Do it' })).toBe(true);

    const heartbeat = {
      ...cron,
      kind: 'heartbeat' as const,
      name: 'Task',
      prompt: 'Do it',
      target_thread_id: null,
    };
    expect(isAutomationDraftComplete(heartbeat)).toBe(false);
    expect(isAutomationDraftComplete({ ...heartbeat, target_thread_id: 'thread-1' })).toBe(true);
  });
});
