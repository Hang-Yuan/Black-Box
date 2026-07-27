import {
  bridge,
  type SessionInfo,
  type SessionListItem,
  type StartSessionParams,
} from './tauri-bridge';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 125;

type HistoricalForkBridge = Pick<
  typeof bridge,
  | 'startSession'
  | 'sendStdin'
  | 'gracefulStopSession'
  | 'listSessions'
  | 'rewindSessionConversation'
>;

export interface HistoricalForkRequest {
  parentSessionId: string;
  checkpointUuid: string;
  cwd: string;
  model: string;
  auxiliaryModel: string;
  auxiliaryModelTier: string;
  providerId?: string;
  thinkingLevel?: string;
  permissionMode?: string;
  agentTeamsEnabled?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface HistoricalForkResult {
  childSessionId: string;
  childSession: SessionListItem;
  process: SessionInfo;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDurableChild(
  api: HistoricalForkBridge,
  childSessionId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<SessionListItem> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = await api.listSessions();
    const child = sessions.find((session) =>
      session.id === childSessionId || session.cliResumeId === childSessionId,
    );
    if (child?.path) return child;
    await delay(pollIntervalMs);
  }
  throw new Error('Claude did not persist the forked session before the timeout');
}

/**
 * Materialize an arbitrary historical fork without copying the source JSONL.
 * Claude Code first owns the native --fork-session clone. Its local /cost
 * command makes that clone durable without an inference call. Only after the
 * child process is stopped do we atomically rewind the child to the selected
 * user checkpoint. The parent conversation is never passed to a write API.
 */
export async function materializeHistoricalFork(
  request: HistoricalForkRequest,
  api: HistoricalForkBridge = bridge,
): Promise<HistoricalForkResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stdinId = `desk_history_fork_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const params: StartSessionParams = {
    prompt: '',
    cwd: request.cwd,
    model: request.model,
    auxiliary_model: request.auxiliaryModel,
    auxiliary_model_tier: request.auxiliaryModelTier,
    session_id: stdinId,
    resume_session_id: request.parentSessionId,
    fork_session: true,
    thinking_level: request.thinkingLevel,
    provider_id: request.providerId,
    permission_mode: request.permissionMode,
    agent_teams_enabled: request.agentTeamsEnabled,
  };

  const process = await api.startSession(params);
  const childSessionId = process.cli_session_id;
  if (!childSessionId || childSessionId === request.parentSessionId) {
    await api.gracefulStopSession(process.stdin_id).catch(() => {});
    throw new Error('Claude did not allocate an independent child session UUID');
  }

  let childSession: SessionListItem;
  try {
    // /cost is handled locally by Claude Code. It persists the native fork but
    // does not ask the selected model to generate a response.
    await api.sendStdin(process.stdin_id, '/cost');
    childSession = await waitForDurableChild(
      api,
      childSessionId,
      timeoutMs,
      pollIntervalMs,
    );
  } finally {
    await api.gracefulStopSession(process.stdin_id).catch(() => {});
  }

  await api.rewindSessionConversation(childSessionId, request.checkpointUuid);
  return { childSessionId, childSession, process };
}
