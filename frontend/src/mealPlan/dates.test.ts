import { describe, expect, it } from 'vitest';
import { addCivilDays, formatCivilDate, getCivilDate, getNextFourCivilDates } from './dates';

describe('meal plan civil dates', () => {
  it('converts an instant using the configured IANA timezone', () => {
    const instant = new Date('2026-03-28T23:30:00.000Z');

    expect(getCivilDate(instant, 'Europe/Rome')).toBe('2026-03-29');
    expect(getCivilDate(instant, 'America/New_York')).toBe('2026-03-28');
  });

  it.each([
    ['2026-03-28T23:30:00.000Z', 'Europe/Rome', ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']],
    ['2026-03-28T23:30:00.000Z', 'America/New_York', ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01']],
    ['2026-03-28T12:00:00.000Z', 'Europe/Rome', ['2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01']],
    ['2026-10-24T12:00:00.000Z', 'Europe/Rome', ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']],
    ['2024-02-28T12:00:00.000Z', 'UTC', ['2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03']],
    ['2026-12-30T12:00:00.000Z', 'UTC', ['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']],
  ] as const)('returns the next four civil days in %s (%s)', (instant, timeZone, expected) => {
    expect(getNextFourCivilDates(new Date(instant), timeZone)).toEqual(expected);
  });

  it('adds calendar days without adding fixed 24-hour durations', () => {
    expect(addCivilDays('2026-03-28', 4)).toBe('2026-04-01');
    expect(addCivilDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('formats a civil date without applying the runtime timezone', () => {
    expect(formatCivilDate('2026-03-30')).toMatch(/30\s+marzo/i);
  });

  it('rejects invalid civil dates and unsupported timezones', () => {
    expect(() => addCivilDays('2026-02-30', 1)).toThrow();
    expect(() => getCivilDate(new Date('2026-01-01T00:00:00Z'), 'Not/A_Zone')).toThrow();
  });
});
