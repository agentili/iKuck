import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { createDatabase } from '../db/client.js';
import { authSessions, users, pushDeliveries, pushSubscriptions, mealPlanStates, houses, houseMemberships } from '../db/schema.js';
import { createPushRepository, runPushTick } from '../push/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('weekly Web Push persistence and worker', () => {
  const database = createDatabase(url!);
  const repository = createPushRepository(database.db);
  const now = new Date('2030-01-04T18:00:00Z'); // Friday 19:00 Europe/Rome.
  const monday = '2030-01-07';
  let owner: string;
  let other: string;
  let session: string;
  let subId: string;
  const createdUsers: string[] = [];
  const createdHouses: string[] = [];
  const send = vi.fn().mockResolvedValue(undefined);
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations') });
  });
  beforeEach(async () => {
    send.mockReset().mockResolvedValue(undefined);
    owner = randomUUID(); other = randomUUID(); session = randomUUID();
    createdUsers.push(owner, other);
    await database.db.insert(users).values([owner, other].map((id) => ({ id, email: `${id}@push.test`, emailVerifiedAt: new Date() })));
    await database.db.insert(authSessions).values({ id: session, userId: owner, tokenHash: randomUUID(), csrfTokenHash: randomUUID(), expiresAt: new Date('2099-01-01') });
    await repository.savePreferences(owner, { enabled: true, fridayTime: '19:00', timeZone: 'Europe/Rome' });
    subId = (await repository.subscribe(owner, session, { endpoint: `https://fcm.googleapis.com/send/${randomUUID()}`, keys: { p256dh: generateVAPIDKeys().publicKey, auth: Buffer.alloc(16).toString('base64url') } })).id;
  });
  afterAll(async () => {
    for (const id of createdUsers) await database.db.delete(users).where(eq(users.id, id));
    for (const id of createdHouses) await database.db.delete(houses).where(eq(houses.id, id));
    await database.close();
  });
  const plan = async (days: number, houseId?: string) => {
    for (let i = 0; i < days; i++) await database.db.insert(mealPlanStates).values({ scopeType: houseId ? 'house' : 'user', scopeId: houseId ?? owner,
      userScopeId: houseId ? null : owner, houseScopeId: houseId ?? null, planDate: `2030-01-${String(7 + i).padStart(2, '0')}`, revision: randomUUID(), kind: i % 2 ? 'manual' : 'automatic', recipeId: 'recipe' });
  };
  const disable = async () => repository.savePreferences(owner, { enabled: false, fridayTime: '19:00', timeZone: 'Europe/Rome' });
  it('sends an empty or partial plan once despite concurrent workers and repeated ticks', async () => {
    await plan(6);
    await Promise.all([runPushTick(database.db, send, now), runPushTick(database.db, send, now)]);
    await runPushTick(database.db, send, now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({ url: `/plan?week=${monday}` });
    await disable();
  });
  it('skips a full seven-day plan, including automatic recipes', async () => {
    await plan(7);
    await runPushTick(database.db, send, now);
    expect(send).not.toHaveBeenCalled();
    await disable();
  });
  it('uses the house plan and shared timezone instead of personal data', async () => {
    const houseId = randomUUID(); createdHouses.push(houseId);
    await database.db.insert(houses).values({ id: houseId, name: 'Push house', timeZone: 'UTC', timeZoneRevision: randomUUID() });
    await database.db.insert(houseMemberships).values({ houseId, userId: owner, role: 'admin' });
    await plan(7); // Personal plan is complete but must not suppress the house reminder.
    await runPushTick(database.db, send, now);
    expect(send).not.toHaveBeenCalled(); // Only 18:00 in the house.
    await runPushTick(database.db, send, new Date('2030-01-04T19:00:00Z'));
    expect(send).toHaveBeenCalledTimes(1);
    await disable();
  });
  it('retries temporary failures, rechecks completeness, and removes expired subscriptions', async () => {
    send.mockRejectedValueOnce({ statusCode: 503 });
    await runPushTick(database.db, send, now);
    expect(send).toHaveBeenCalledTimes(1);
    await plan(7);
    await runPushTick(database.db, send, new Date(now.getTime() + 60_000));
    expect(send).toHaveBeenCalledTimes(1);
    const [delivery] = await database.db.select().from(pushDeliveries).where(eq(pushDeliveries.subscriptionId, subId));
    expect(delivery.status).toBe('skipped');
    // A new device tests a permanent provider expiry independently.
    await database.db.delete(mealPlanStates).where(eq(mealPlanStates.userScopeId, owner));
    const expired = (await repository.subscribe(owner, session, { endpoint: `https://web.push.apple.com/${randomUUID()}`, keys: { p256dh: generateVAPIDKeys().publicKey, auth: Buffer.alloc(16).toString('base64url') } })).id;
    send.mockRejectedValueOnce({ statusCode: 410 });
    await runPushTick(database.db, send, now);
    expect(await database.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, expired))).toHaveLength(0);
    await disable();
  });
  it('does not allow another user/session to inspect, delete or claim a subscription', async () => {
    expect(await repository.testSubscription(other, session, subId)).toBeNull();
    await repository.unsubscribe(other, session, subId);
    expect(await repository.testSubscription(owner, session, subId)).not.toBeNull();
    const subscription = (await repository.testSubscription(owner, session, subId))!;
    await expect(repository.subscribe(other, session, subscription)).rejects.toMatchObject({ status: 409 });
    await disable();
  });
  it('does not transfer endpoint ownership when two accounts register concurrently', async () => {
    const otherSession = randomUUID();
    await database.db.insert(authSessions).values({ id: otherSession, userId: other, tokenHash: randomUUID(), csrfTokenHash: randomUUID(), expiresAt: new Date('2099-01-01') });
    const subscription = { endpoint: `https://fcm.googleapis.com/send/${randomUUID()}`, keys: { p256dh: generateVAPIDKeys().publicKey, auth: Buffer.alloc(16).toString('base64url') } };
    const results = await Promise.allSettled([repository.subscribe(owner, session, subscription), repository.subscribe(other, otherSession, subscription)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [stored] = await database.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, subscription.endpoint));
    expect(stored.sessionId).toBe(stored.userId === owner ? session : otherSession);
    await disable();
  });
  it('revokes subscriptions on logout through the session foreign key', async () => {
    await database.db.delete(authSessions).where(eq(authSessions.id, session));
    await runPushTick(database.db, send, now);
    expect(send).not.toHaveBeenCalled();
    expect(await repository.subscriptions(owner, session)).toEqual([]);
    await disable();
  });
  it('expires pending reminders after two hours and respects disabling preferences', async () => {
    send.mockRejectedValueOnce({ statusCode: 429 });
    await runPushTick(database.db, send, now);
    await disable();
    await runPushTick(database.db, send, new Date(now.getTime() + 120_000));
    expect(send).toHaveBeenCalledTimes(1);
    await database.db.execute(sql`UPDATE push_deliveries SET status = 'pending' WHERE subscription_id = ${subId}`);
    await runPushTick(database.db, send, new Date(now.getTime() + 7200_000));
    expect((await database.db.select().from(pushDeliveries).where(and(eq(pushDeliveries.subscriptionId, subId), eq(pushDeliveries.weekStart, monday))))[0].status).toBe('expired');
  });
});
