import type { WeeklyPushPayload } from '@ikuck/shared/contracts';
export function safePushDestination(value: unknown): string | null {
  if (value === '/profile') return value;
  if (typeof value !== 'string' || !/^\/plan\?week=\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value.slice(-10)}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(-10) && date.getUTCDay() === 1 ? value : null;
}
export function parsePushPayload(value: unknown, now = Date.now()): WeeklyPushPayload | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.accountId !== 'string' || !p.accountId || p.accountId.length > 128) return null;
  if (typeof p.title !== 'string' || !p.title || p.title.length > 150 || typeof p.body !== 'string' || p.body.length > 500
    || typeof p.tag !== 'string' || p.tag.length > 100 || typeof p.expiresAt !== 'string' || !safePushDestination(p.url)
    || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= now) return null;
  return p as unknown as WeeklyPushPayload;
}
