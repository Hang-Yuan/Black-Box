import { describe, expect, it, vi } from 'vitest';
import { materializeHistoricalFork } from '../historical-fork';

const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const checkpoint = '33333333-3333-4333-8333-333333333333';

function request() {
  return {
    parentSessionId: parent,
    checkpointUuid: checkpoint,
    cwd: '/tmp/project',
    model: 'claude-haiku-4-5-20251001',
    auxiliaryModel: 'claude-sonnet-5',
    auxiliaryModelTier: 'sonnet',
    providerId: 'provider',
    timeoutMs: 10,
    pollIntervalMs: 1,
  };
}

describe('materializeHistoricalFork', () => {
  it('uses a local command to persist the native clone before rewinding only the child', async () => {
    const calls: string[] = [];
    const api = {
      startSession: vi.fn(async () => {
        calls.push('start');
        return { stdin_id: 'desk-fork', cli_session_id: child, pid: 10, cli_path: '/claude' };
      }),
      sendStdin: vi.fn(async () => { calls.push('cost'); }),
      listSessions: vi.fn(async () => {
        calls.push('list');
        return [{
          id: child,
          path: `/tmp/${child}.jsonl`,
          project: '/tmp/project',
          projectDir: '-tmp-project',
          modifiedAt: 1,
          preview: 'parent turn',
          cliResumeId: child,
        }];
      }),
      gracefulStopSession: vi.fn(async () => { calls.push('stop'); return 'graceful' as const; }),
      rewindSessionConversation: vi.fn(async (sessionId: string) => {
        calls.push(`rewind:${sessionId}`);
        return { retainedLines: 2, removedLines: 4, backupPath: '/tmp/backup.jsonl' };
      }),
    };

    const result = await materializeHistoricalFork(request(), api);
    expect(result.childSessionId).toBe(child);
    expect(calls).toEqual(['start', 'cost', 'list', 'stop', `rewind:${child}`]);
    expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '',
      resume_session_id: parent,
      fork_session: true,
    }));
    expect(api.sendStdin).toHaveBeenCalledWith('desk-fork', '/cost');
    expect(api.rewindSessionConversation).toHaveBeenCalledWith(child, checkpoint);
  });

  it('always stops the transient child process when persistence fails', async () => {
    const api = {
      startSession: vi.fn(async () => ({
        stdin_id: 'desk-fork', cli_session_id: child, pid: 10, cli_path: '/claude',
      })),
      sendStdin: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => []),
      gracefulStopSession: vi.fn(async () => 'graceful' as const),
      rewindSessionConversation: vi.fn(),
    };

    await expect(materializeHistoricalFork({ ...request(), timeoutMs: 2 }, api))
      .rejects.toThrow(/persist the forked session/);
    expect(api.gracefulStopSession).toHaveBeenCalledWith('desk-fork');
    expect(api.rewindSessionConversation).not.toHaveBeenCalled();
  });

  it('rejects a child UUID that is not independent from its parent', async () => {
    const api = {
      startSession: vi.fn(async () => ({
        stdin_id: 'desk-fork', cli_session_id: parent, pid: 10, cli_path: '/claude',
      })),
      sendStdin: vi.fn(),
      listSessions: vi.fn(),
      gracefulStopSession: vi.fn(async () => 'graceful' as const),
      rewindSessionConversation: vi.fn(),
    };

    await expect(materializeHistoricalFork(request(), api))
      .rejects.toThrow(/independent child session UUID/);
    expect(api.gracefulStopSession).toHaveBeenCalledWith('desk-fork');
  });
});
