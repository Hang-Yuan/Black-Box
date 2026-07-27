import type { AutomationDefinition } from './tauri-bridge';

/** Build a new scheduled-task draft from the user's current UI context. */
export function createAutomationDraft(
  model: string,
  projectDirectory: string,
  targetThreadId: string | null,
  now = Date.now(),
  providerId: string | null = null,
  providerRevision: number | null = null,
  auxiliaryModel = 'sonnet',
): AutomationDefinition {
  return {
    version: 1,
    id: '',
    kind: 'cron',
    name: '',
    prompt: '',
    status: 'ACTIVE',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
    model,
    auxiliary_model: auxiliaryModel,
    reasoning_effort: 'high',
    agent_teams_enabled: false,
    execution_environment: 'worktree',
    target: { type: 'project', projectId: projectDirectory },
    cwds: projectDirectory ? [projectDirectory] : [],
    target_thread_id: targetThreadId,
    provider_id: providerId,
    provider_revision: providerRevision,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Normalize a UI draft into the backend contract.
 * Heartbeats always run in the original conversation's local project context;
 * worktrees are only meaningful for independent Cron runs.
 */
export function prepareAutomationDefinitionForSave(
  draft: AutomationDefinition,
  rrule: string,
): AutomationDefinition {
  const projectId = draft.target?.projectId.trim() || '';
  return {
    ...draft,
    rrule,
    execution_environment: draft.kind === 'heartbeat'
      ? 'local'
      : draft.execution_environment,
    target: draft.kind === 'cron' && projectId
      ? { type: 'project', projectId }
      : null,
    cwds: draft.kind === 'cron'
      ? (projectId ? [projectId] : [])
      : draft.cwds.map((path) => path.trim()).filter(Boolean),
    target_thread_id: draft.kind === 'heartbeat' ? draft.target_thread_id : null,
  };
}

/** Basic form completeness; filesystem/Git validation remains authoritative in Rust. */
export function isAutomationDraftComplete(draft: AutomationDefinition | null): boolean {
  return Boolean(
    draft
    && draft.name.trim()
    && draft.prompt.trim()
    && (draft.kind === 'cron'
      ? draft.target?.projectId.trim()
      : draft.target_thread_id?.trim()),
  );
}
