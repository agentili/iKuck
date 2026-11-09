import type { WeeklyPushPayload } from '@ikuck/shared/contracts';

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; }
}

export function weeklyReminder(now: Date, zone: string, time: string): { weekStart: string; expiresAt: Date } | null {
  if (!validTimeZone(zone) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const civil = new Date(`${date}T12:00:00Z`);
  const scheduledMinutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  // A two-hour catch-up window may cross midnight into Saturday.
  const weekday = civil.getUTCDay();
  const elapsed = weekday === 5 ? minutes - scheduledMinutes : weekday === 6 ? 1440 + minutes - scheduledMinutes : -1;
  if (elapsed < 0 || elapsed >= 120) return null;
  civil.setUTCDate(civil.getUTCDate() + (weekday === 5 ? 3 : 2));
  return { weekStart: civil.toISOString().slice(0, 10), expiresAt: new Date(now.getTime() + (120 - elapsed) * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds()) };
}

export function reminderPayload(weekStart: string, expiresAt: Date, accountId: string): WeeklyPushPayload {
  return {
    accountId,
    title: 'Prepara il piano della prossima settimana',
    body: 'Crea o completa il piano: una ricetta per ogni giorno, da lunedì a domenica.',
    url: `/plan?week=${weekStart}`, tag: `weekly-plan-${weekStart}`, expiresAt: expiresAt.toISOString(),
  };
}
