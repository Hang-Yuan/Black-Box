const DAY_MS = 24 * 60 * 60 * 1000;

type SessionTimeTranslationKey =
  | 'conv.justNow'
  | 'conv.mAgo'
  | 'conv.yesterday'
  | 'conv.dAgo';

export type SessionTimeTranslator = (key: SessionTimeTranslationKey) => string;

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function formatClockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Format a session timestamp using local calendar-day semantics.
 *
 * Elapsed time is useful inside the current day, but it cannot decide whether a
 * session belongs to today: yesterday evening is still less than 24 hours ago
 * when the app opens the next morning.
 */
export function formatSessionTime(
  timestampMs: number,
  translate: SessionTimeTranslator,
  nowMs = Date.now(),
): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0 || !Number.isFinite(nowMs)) return '';

  const timestamp = new Date(timestampMs);
  const now = new Date(nowMs);
  const calendarDayDifference = localCalendarDay(now) - localCalendarDay(timestamp);
  const clockTime = formatClockTime(timestamp);

  if (calendarDayDifference === 0) {
    const minutes = Math.floor(Math.max(0, nowMs - timestampMs) / 60000);
    if (minutes < 1) return translate('conv.justNow');
    if (minutes < 60) return `${minutes}${translate('conv.mAgo')}`;
    return clockTime;
  }

  if (calendarDayDifference === 1) {
    return `${translate('conv.yesterday')} ${clockTime}`;
  }

  if (calendarDayDifference > 1 && calendarDayDifference < 7) {
    return `${calendarDayDifference}${translate('conv.dAgo')}`;
  }

  return timestamp.toLocaleDateString();
}
