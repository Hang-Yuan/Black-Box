import type { ChatMessage } from '../stores/chatStore';

export const NATIVE_LOOP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const NATIVE_LOOP_PROMPT_MAX_LENGTH = 4_000;

export interface NativeLoopJob {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
}

export type NativeLoopIntervalStatus = 'valid' | 'durable' | 'invalid';

function toolResultText(message: ChatMessage): string {
  return message.toolResultContent || message.toolResult || message.content || '';
}

function createdJobId(message: ChatMessage): string | undefined {
  const match = toolResultText(message).match(/Scheduled(?: recurring)? job\s+([A-Za-z0-9_-]+)/i);
  return match?.[1];
}

/**
 * Reconstruct only jobs that the native Claude CLI explicitly confirmed.
 * This is deliberately a receipt view, not a second scheduler: CronCreate and
 * CronDelete remain owned by the live/resumed Claude session.
 */
export function deriveNativeLoopJobs(
  messages: ChatMessage[],
  now = Date.now(),
): NativeLoopJob[] {
  const jobs = new Map<string, NativeLoopJob>();

  for (const message of messages) {
    if (message.type !== 'tool_use' || !message.toolCompleted) continue;

    if (message.toolName === 'CronCreate' && message.toolInput?.recurring === true) {
      const id = createdJobId(message);
      if (!id) continue;
      jobs.set(id, {
        id,
        cron: typeof message.toolInput?.cron === 'string' ? message.toolInput.cron : '',
        prompt: typeof message.toolInput?.prompt === 'string' ? message.toolInput.prompt : '',
        createdAt: message.timestamp,
      });
      continue;
    }

    if (message.toolName === 'CronDelete') {
      const id = typeof message.toolInput?.id === 'string' ? message.toolInput.id : undefined;
      const result = toolResultText(message);
      if (id && /(cancelled|deleted|not found)/i.test(result)) jobs.delete(id);
    }
  }

  return [...jobs.values()]
    .filter((job) => now - job.createdAt < NATIVE_LOOP_MAX_AGE_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function validateNativeLoopInterval(interval: string): NativeLoopIntervalStatus {
  const value = interval.trim().toLowerCase();
  if (!value) return 'valid'; // Native dynamic/self-paced mode.
  const match = value.match(/^(\d+)([mhd])$/);
  if (!match || Number(match[1]) < 1) return 'invalid';

  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'h' || unit === 'd' || (unit === 'm' && amount >= 60)) return 'durable';
  return 'valid';
}

export function buildNativeLoopCommand(interval: string, prompt: string): string {
  const cadence = interval.trim().toLowerCase();
  const body = prompt.trim();
  return ['/loop', cadence, body].filter(Boolean).join(' ');
}
