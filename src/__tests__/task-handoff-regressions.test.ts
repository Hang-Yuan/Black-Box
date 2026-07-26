import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const backend = readFileSync(resolve(root, 'src-tauri/src/task_handoff.rs'), 'utf8');
const lib = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
const automations = readFileSync(resolve(root, 'src-tauri/src/automations.rs'), 'utf8');
const control = readFileSync(resolve(root, 'src/components/chat/TaskLocationControl.tsx'), 'utf8');

describe('task handoff safety invariants', () => {
  it('uses durable metadata, one associated worktree, and a guarded synchronization ref', () => {
    expect(backend).toContain('task-locations');
    expect(backend).toContain('task-worktrees');
    expect(backend).toContain('refs/blackbox/task-handoffs/');
    expect(backend).toContain('The inactive checkout changed after the last handoff');
    expect(backend).toContain('update_sync_ref(');
    expect(backend).toContain('rollback_destination(');
  });

  it('does not move a task while its Claude CLI session is still alive', () => {
    expect(lib).toContain('state.has_cli_session_id(&session_id).await');
    expect(lib).toContain('Stop the active response before handing this task');
    expect(control).toContain("await teardownSession(stdinId, selectedSessionId, 'switch')");
    expect(control).toContain('await waitForStdinCleared(selectedSessionId, stdinId)');
  });

  it('continues the same conversation from the returned cwd', () => {
    expect(control).toContain('bridge.handoffTask(cliSessionId, currentCwd, destination)');
    expect(control).toContain('updateSessionProject(selectedSessionId, next.currentCwd)');
    expect(control).toContain('setSessionMeta(selectedSessionId, { cwdSnapshot: next.currentCwd })');
    expect(lib).toContain('task_handoff::current_cwd_override(&id)');
  });

  it('protects an adopted Scheduled worktree from retention and manual cleanup', () => {
    expect(automations).toContain('handoff_protected');
    expect(automations).toContain('crate::task_handoff::is_current_worktree_session');
    expect(automations).toContain('hand it back to Local before cleaning');
  });
});
