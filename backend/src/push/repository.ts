import { and, eq, sql } from 'drizzle-orm';
import type { PushPreferences, PushSubscriptionInput } from '@ikuck/shared/contracts';
import type { ApplicationDatabase } from '../db/client.js';
import { pushPreferences, pushSubscriptions } from '../db/schema.js';
import { PushError } from '../push/errors.js';
import { reminderPayload, weeklyReminder } from './calendar.js';
import { pushStatusCode, type PushTransport } from './transport.js';

type Database = ApplicationDatabase['db'];
export const createPushRepository = (db: Database) => ({
  async status(userId: string) {
    const [preferences] = await db.select().from(pushPreferences).where(eq(pushPreferences.userId, userId));
    const houses = await db.execute<{ time_zone: string | null }>(sql`
      SELECT h.time_zone FROM houses h JOIN house_memberships m ON m.house_id = h.id WHERE m.user_id = ${userId}`);
    const fallback: PushPreferences = { enabled: false, fridayTime: '19:00', timeZone: 'Europe/Rome' };
    return { preferencesConfigured: preferences !== undefined, preferences: preferences ? { enabled: preferences.enabled, fridayTime: preferences.fridayTime, timeZone: preferences.timeZone } : fallback, effectiveTimeZone: houses[0]?.time_zone ?? preferences?.timeZone ?? fallback.timeZone };
  },
  async savePreferences(userId: string, value: PushPreferences) {
    await db.insert(pushPreferences).values({ userId, ...value }).onConflictDoUpdate({ target: pushPreferences.userId, set: value });
  },
  async subscriptions(userId: string, sessionId: string) {
    return db.select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.sessionId, sessionId)));
  },
  async subscribe(userId: string, sessionId: string, value: PushSubscriptionInput) {
    // Keep a bounded set per account, even if a client repeatedly registers fresh endpoints.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
      const existing = await tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, value.endpoint));
      if (existing[0] && existing[0].userId !== userId) throw new PushError('push_subscription_conflict', 409, 'Subscription belongs to another account');
      const subscriptions = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
      if (!existing.length && subscriptions.length >= 20) throw new PushError('push_device_limit', 409, 'Too many devices');
      const [result] = await tx.insert(pushSubscriptions).values({ userId, sessionId, endpoint: value.endpoint, ...value.keys })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { sessionId, ...value.keys }, setWhere: eq(pushSubscriptions.userId, userId) }).returning({ id: pushSubscriptions.id });
      if (!result) throw new PushError("push_subscription_conflict", 409, "Subscription belongs to another account");
      return result;
    });
  },
  async unsubscribe(userId: string, sessionId: string, id: string) {
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.sessionId, sessionId)));
  },
  async testSubscription(userId: string, sessionId: string, id: string) {
    const [row] = await db.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.sessionId, sessionId)));
    return row ? { endpoint: row.endpoint, keys: { auth: row.auth, p256dh: row.p256dh } } : null;
  },
});
export type PushRepository = ReturnType<typeof createPushRepository>;

// The same scope resolver as meal-plan synchronization: membership takes precedence.
const candidateQuery = sql`
  SELECT p.user_id, p.friday_time, COALESCE(h.time_zone, p.time_zone) AS time_zone,
    CASE WHEN m.house_id IS NULL THEN 'user:' || p.user_id::text ELSE 'house:' || m.house_id::text END AS scope_key
  FROM push_preferences p JOIN users u ON u.id = p.user_id
  LEFT JOIN house_memberships m ON m.user_id = p.user_id LEFT JOIN houses h ON h.id = m.house_id
  WHERE p.enabled AND u.email_verified_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM house_migration_pending pending WHERE pending.user_id = p.user_id)`;

async function isComplete(db: Pick<Database, 'execute'>, scopeKey: string, weekStart: string) {
  const [kind, id] = scopeKey.split(':');
  const result = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM meal_plan_states WHERE scope_type = ${kind} AND scope_id = ${id}
      AND plan_date BETWEEN ${weekStart}::date AND ${weekStart}::date + 6
      AND kind IN ('automatic', 'manual') AND recipe_id IS NOT NULL`);
  return result[0]?.count === 7;
}

export async function runPushTick(db: Database, send: PushTransport, now = new Date(), report: (event: string) => void = () => {}, shouldStop: () => boolean = () => false) {
  const candidates = await db.execute<{ user_id: string; friday_time: string; time_zone: string; scope_key: string }>(candidateQuery);
  for (const candidate of candidates) {
    if (shouldStop()) return;
    const reminder = weeklyReminder(now, candidate.time_zone, candidate.friday_time);
    if (!reminder || await isComplete(db, candidate.scope_key, reminder.weekStart)) continue;
    await db.execute(sql`
      INSERT INTO push_deliveries (subscription_id, week_start, scope_key, expires_at)
      SELECT s.id, ${reminder.weekStart}::date, ${candidate.scope_key}, ${reminder.expiresAt.toISOString()} FROM push_subscriptions s
      JOIN auth_sessions session ON session.id = s.session_id
      WHERE s.user_id = ${candidate.user_id} AND session.expires_at > ${now.toISOString()}
      ON CONFLICT (subscription_id, week_start) DO NOTHING`);
  }
  await db.execute(sql`UPDATE push_deliveries SET status = 'expired' WHERE status = 'pending' AND expires_at <= ${now.toISOString()}`);
  // Bounded batch; SKIP LOCKED permits multiple workers without concurrent sends of the same row.
  for (let i = 0; i < 100 && !shouldStop(); i++) {
    const found = await db.transaction(async (tx) => {
      const rows = await tx.execute<{
        subscription_id: string; user_id: string; week_start: string; scope_key: string; expires_at: Date;
        endpoint: string; auth: string; p256dh: string; attempts: number;
      }>(sql`SELECT d.*, s.user_id, s.endpoint, s.auth, s.p256dh FROM push_deliveries d
        JOIN push_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ${now.toISOString()} AND d.expires_at > ${now.toISOString()}
        ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`);
      const delivery = rows[0];
      if (!delivery) return false;
      const finish = async (status: string) => {
        await tx.execute(sql`UPDATE push_deliveries SET status = ${status} WHERE subscription_id = ${delivery.subscription_id} AND week_start = ${delivery.week_start}::date`);
      };
      const authorized = await tx.execute<{ scope_key: string; time_zone: string; friday_time: string }>(sql`${candidateQuery} AND p.user_id = ${delivery.user_id}`);
      const current = authorized[0];
      const due = current && weeklyReminder(now, current.time_zone, current.friday_time);
      const sessions = await tx.execute(sql`SELECT s.id FROM auth_sessions a JOIN push_subscriptions s ON s.session_id = a.id
        WHERE s.id = ${delivery.subscription_id} AND a.expires_at > ${now.toISOString()}`);
      if (!current || current.scope_key !== delivery.scope_key || !due || due.weekStart !== delivery.week_start || !sessions.length
        || await isComplete(tx, delivery.scope_key, delivery.week_start)) {
        await finish('skipped'); report('skipped'); return true;
      }
      try {
        await send({ endpoint: delivery.endpoint, keys: { auth: delivery.auth, p256dh: delivery.p256dh } }, reminderPayload(delivery.week_start, new Date(delivery.expires_at), delivery.user_id));
        await finish('sent'); report('sent');
      } catch (error) {
        const status = pushStatusCode(error);
        if (status === 404 || status === 410) {
          await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, delivery.subscription_id)); report('subscription_expired');
        } else if (status !== 0 && status !== 429 && status < 500) {
          await finish('skipped'); report('provider_rejected');
        } else {
          const retryAt = new Date(now.getTime() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(Number(delivery.attempts), 5)));
          await tx.execute(sql`UPDATE push_deliveries SET attempts = attempts + 1, next_attempt_at = ${retryAt.toISOString()}
            WHERE subscription_id = ${delivery.subscription_id} AND week_start = ${delivery.week_start}::date`);
          report('retry');
        }
      }
      return true;
    });
    if (!found) break;
  }
  await db.execute(sql`DELETE FROM push_deliveries WHERE expires_at < ${new Date(now.getTime() - 90 * 86400_000).toISOString()}`);
}
