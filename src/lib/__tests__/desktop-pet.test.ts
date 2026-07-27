import { describe, expect, it } from 'vitest';
import { deriveDesktopPetState, type DesktopPetSnapshot } from '../desktop-pet';

function snapshot(overrides: Partial<DesktopPetSnapshot> = {}): DesktopPetSnapshot {
  return {
    tabs: [],
    agents: [],
    workflows: [],
    ...overrides,
  };
}

describe('deriveDesktopPetState', () => {
  it('shows the selected task waiting for a user response', () => {
    expect(deriveDesktopPetState(snapshot({
      tabs: [{
        id: 'selected',
        selected: true,
        sessionStatus: 'running',
        activityPhase: 'awaiting',
      }],
      workflows: [{ tabId: 'other', workflowName: 'release', status: 'running' }],
    }))).toEqual({ phase: 'waiting', source: 'session' });
  });

  it('preserves the live tool name', () => {
    expect(deriveDesktopPetState(snapshot({
      tabs: [{
        id: 'selected',
        selected: true,
        sessionStatus: 'running',
        activityPhase: 'tool',
        toolName: 'Read',
      }],
    }))).toEqual({ phase: 'tool', source: 'session', detail: 'Read' });
  });

  it('uses active agent and workflow evidence when the selected task is idle', () => {
    expect(deriveDesktopPetState(snapshot({
      agents: [{ id: 'agent-1', phase: 'thinking' }],
    }))).toEqual({ phase: 'thinking', source: 'agent' });

    expect(deriveDesktopPetState(snapshot({
      workflows: [{ tabId: 'task', workflowName: 'deep-research', status: 'launching' }],
    }))).toEqual({ phase: 'running', source: 'workflow', detail: 'deep-research' });
  });

  it('does not let historical workflow failures or background errors pin the state', () => {
    expect(deriveDesktopPetState(snapshot({
      tabs: [{
        id: 'old',
        selected: false,
        sessionStatus: 'error',
        activityPhase: 'error',
      }],
      workflows: [{ tabId: 'old', workflowName: 'old-run', status: 'failed' }],
    }))).toEqual({ phase: 'idle', source: 'app' });
  });

  it('reports a selected task error', () => {
    expect(deriveDesktopPetState(snapshot({
      tabs: [{
        id: 'selected',
        selected: true,
        sessionStatus: 'error',
        activityPhase: 'error',
      }],
    }))).toEqual({ phase: 'error', source: 'session' });
  });
});
