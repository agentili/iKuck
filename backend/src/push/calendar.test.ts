import { describe, expect, it } from 'vitest';
import { weeklyReminder, reminderPayload } from './calendar.js';

describe('weekly reminders in civil time', () => {
  it.each([
    ['2026-11-06T18:00:00Z', 'Europe/Rome', '2026-11-09'],
    ['2026-07-03T17:00:00Z', 'Europe/Rome', '2026-07-06'],
    ['2026-12-25T18:00:00Z', 'Europe/Rome', '2026-12-28'],
    ['2027-01-01T18:00:00Z', 'Europe/Rome', '2027-01-04'],
    ['2026-11-07T00:00:00Z', 'America/New_York', '2026-11-09'],
  ])('selects next Monday for %s in %s', (instant, zone, monday) => {
    const result = weeklyReminder(new Date(instant), zone, '19:00');
    expect(result?.weekStart).toBe(monday);
    expect(result?.expiresAt.toISOString()).toBe(new Date(Date.parse(instant) + 7200000).toISOString());
  });
  it('catches up inside two hours, without extending expiry on each tick', () => {
    expect(weeklyReminder(new Date('2026-11-06T19:59:59Z'), 'Europe/Rome', '19:00')?.expiresAt.toISOString()).toBe('2026-11-06T20:00:00.000Z');
    expect(weeklyReminder(new Date('2026-11-06T20:00:00Z'), 'Europe/Rome', '19:00')).toBeNull();
    expect(weeklyReminder(new Date('2026-11-06T17:59:59Z'), 'Europe/Rome', '19:00')).toBeNull();
  });
  it('supports a late Friday reminder crossing midnight', () => {
    expect(weeklyReminder(new Date('2026-11-07T00:15:00Z'), 'UTC', '23:30')?.weekStart).toBe('2026-11-09');
    expect(weeklyReminder(new Date('2026-11-07T01:30:00Z'), 'UTC', '23:30')).toBeNull();
  });
  it('rejects invalid zones and time strings, and does not run on other days', () => {
    expect(weeklyReminder(new Date('2026-11-09T19:00:00Z'), 'UTC', '19:00')).toBeNull();
    expect(weeklyReminder(new Date(), 'bad-zone', '19:00')).toBeNull();
    expect(weeklyReminder(new Date(), 'UTC', '25:00')).toBeNull();
  });
  it('creates a stable tag and calendar deep link', () => {
    expect(reminderPayload('2026-11-09', new Date('2026-11-06T20:00:00Z'), 'user')).toMatchObject({ url: '/plan?week=2026-11-09', tag: 'weekly-plan-2026-11-09' });
  });
});
