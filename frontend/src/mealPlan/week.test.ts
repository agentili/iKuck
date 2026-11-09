import { describe, expect, it } from 'vitest';
import { getPlanDates, parsePlanWeek, getNextWeekMonday } from './dates';
describe('calendar-week view', () => {
  it('selects exactly Monday through Sunday across year boundaries', () => {
    expect(getPlanDates(new Date('2026-12-25T18:00:00Z'), 'Europe/Rome', '2026-12-28')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });
  it('preserves the rolling view and determines next Monday in the supplied timezone', () => {
    expect(getPlanDates(new Date('2026-11-06T18:00:00Z'), 'Europe/Rome', null)[0]).toBe('2026-11-07');
    expect(getNextWeekMonday(new Date('2026-11-08T23:30:00Z'), 'Europe/Rome')).toBe('2026-11-16');
    expect(getNextWeekMonday(new Date('2026-11-08T23:30:00Z'), 'America/New_York')).toBe('2026-11-09');
  });
  it('rejects non-Monday or invalid query dates', () => {
    expect(parsePlanWeek('2026-11-09')).toBe('2026-11-09');
    for (const value of [null, '', '2026-11-10', '2026-02-30', 'bad']) expect(parsePlanWeek(value)).toBeNull();
  });
});
