import { describe, expect, it } from 'vitest';
import { formatSessionTime, type SessionTimeTranslator } from '../session-time';

const zhMessages: Record<Parameters<SessionTimeTranslator>[0], string> = {
  'conv.justNow': '刚刚',
  'conv.mAgo': '分钟前',
  'conv.yesterday': '昨天',
  'conv.dAgo': '天前',
};

const translate: SessionTimeTranslator = (key) => zhMessages[key];
const localTime = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) => new Date(year, month - 1, day, hour, minute).getTime();

describe('formatSessionTime', () => {
  it('labels a previous-calendar-day evening with yesterday and its exact time', () => {
    const now = localTime(2026, 7, 31, 9, 30);
    const yesterdayEvening = localTime(2026, 7, 30, 18, 12);

    expect(formatSessionTime(yesterdayEvening, translate, now)).toBe('昨天 18:12');
  });

  it('uses calendar-day boundaries even when less than 24 hours have elapsed', () => {
    const now = localTime(2026, 7, 31, 0, 10);
    const twentyMinutesAgo = localTime(2026, 7, 30, 23, 50);

    expect(formatSessionTime(twentyMinutesAgo, translate, now)).toBe('昨天 23:50');
  });

  it('keeps precise clock time for an older session from the current day', () => {
    const now = localTime(2026, 7, 31, 9, 30);
    const earlierToday = localTime(2026, 7, 31, 8, 0);

    expect(formatSessionTime(earlierToday, translate, now)).toBe('08:00');
  });

  it('keeps minute-level recency inside the current day', () => {
    const now = localTime(2026, 7, 31, 9, 30);
    const twentyFiveMinutesAgo = localTime(2026, 7, 31, 9, 5);

    expect(formatSessionTime(twentyFiveMinutesAgo, translate, now)).toBe('25分钟前');
  });

  it('uses calendar-day distance for earlier sessions in the same week', () => {
    const now = localTime(2026, 7, 31, 9, 30);
    const twoDaysAgo = localTime(2026, 7, 29, 18, 12);

    expect(formatSessionTime(twoDaysAgo, translate, now)).toBe('2天前');
  });

  it('returns an empty label for invalid timestamps', () => {
    expect(formatSessionTime(Number.NaN, translate)).toBe('');
    expect(formatSessionTime(0, translate)).toBe('');
  });
});
