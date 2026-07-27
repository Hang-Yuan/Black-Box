/** Detect if an error message looks like a permission/access issue */
export function isPermissionError(msg: string): boolean {
  const hints = ['EPERM', 'EACCES', 'permission denied', 'access denied',
    'Access is denied', 'operation not permitted'];
  const lower = msg.toLowerCase();
  return hints.some(h => lower.includes(h.toLowerCase()));
}

/** Detect if an error message looks like a network/firewall issue */
export function isNetworkError(msg: string): boolean {
  // If it's a permission error, don't misclassify as network
  // (e.g. FetchError wrapping EPERM on npm cache)
  if (isPermissionError(msg)) return false;
  const lower = msg.toLowerCase();
  // Local extraction timeout is NOT a network issue
  if (lower.includes('local extraction') || lower.includes('not a network issue')) return false;
  const hints = ['timeout', 'timed out', 'network', 'connect', 'ENOTFOUND',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'fetch', 'Failed to download',
    'All install methods failed', 'dns', 'certificate'];
  return hints.some(h => lower.includes(h.toLowerCase()));
}

export type CliMaintenanceErrorKind =
  | 'network'
  | 'blockedAutomation'
  | 'blockedSessions'
  | 'runtime'
  | 'permission'
  | 'owner'
  | 'unknown';

export interface CliMaintenanceError {
  kind: CliMaintenanceErrorKind;
  detail: string;
}

/**
 * Classify CLI maintenance failures without rewriting their diagnostic text.
 * The caller can present a localized, actionable summary while keeping
 * `detail` available verbatim for support and unknown failures.
 */
export function classifyCliMaintenanceError(message: string): CliMaintenanceError {
  const detail = message.trim();
  const lower = detail.toLowerCase();

  if (
    lower.includes('cli_update_blocked_automation')
    || lower.includes('scheduled task is running')
    || lower.includes('已安排任务正在运行')
  ) {
    return { kind: 'blockedAutomation', detail };
  }

  if (
    lower.includes('cli_update_blocked_sessions')
    || lower.includes('cli_maintenance_busy')
    || lower.includes('could not safely stop every conversation')
    || lower.includes('conversation(s) are generating')
    || lower.includes('claude process could not be safely linked')
    || lower.includes('new conversation started after confirmation')
    || lower.includes('未能安全停止全部对话')
    || lower.includes('对话正在生成')
    || lower.includes('无法安全关联到界面的 claude 进程')
    || lower.includes('新的对话在确认后启动')
  ) {
    return { kind: 'blockedSessions', detail };
  }

  if (isPermissionError(detail)) {
    return { kind: 'permission', detail };
  }

  if (
    lower.includes('must be updated by its owner')
    || lower.includes('must be reinstalled by its owner')
    || lower.includes('run in a terminal:')
  ) {
    return { kind: 'owner', detail };
  }

  if (
    lower.includes('selected sdk runtime')
    || lower.includes('no sdk-compatible claude cli')
    || lower.includes('no healthy sdk runtime')
    || lower.includes('claude cli is not installed')
    || lower.includes('claude cli not found')
    || lower.includes('missing or broken')
    || lower.includes('broken symlink')
    || lower.includes('does not expose the stream-json')
  ) {
    return { kind: 'runtime', detail };
  }

  if (isNetworkError(detail)) {
    return { kind: 'network', detail };
  }

  return { kind: 'unknown', detail };
}
