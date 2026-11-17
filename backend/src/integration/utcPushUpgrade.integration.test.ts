import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendNotification } from 'web-push';
import * as schema from '../db/schema.js';
import type { ApplicationDatabase } from '../db/client.js';
import { createPushRepository, runPushTick } from '../push/repository.js';
import { createPushTransport } from '../push/transport.js';

vi.mock('web-push', () => ({ sendNotification: vi.fn() }));
const url = process.env.INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;
const sourceMigrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const weekStart = '2030-01-07';
const transport = createPushTransport('mailto:utc@example.test', 'test-public-key', 'test-private-key');

integration('pending push delivery upgrade to UTC', () => {
  const admin = postgres(url!, { max: 1, onnotice: () => undefined });
  let client: ReturnType<typeof postgres>;
  let db: ApplicationDatabase['db'];
  let folder: string;
  let namespace: string;
  let owner: string;
  let session: string;
  let subscriptionId: string;
  let terminalRows: typeof schema.pushDeliveries.$inferSelect[];
  let journal: { entries: Array<{ idx: number }> };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-04T18:00:00Z'));
    vi.mocked(sendNotification).mockReset().mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    namespace = `utc_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    client = postgres(url!, { max: 4, connection: { search_path: namespace }, onnotice: () => undefined });
    db = drizzle(client, { schema });
    folder = await mkdtemp(join(tmpdir(), 'ikuck-utc-upgrade-'));
    await cp(sourceMigrations, folder, { recursive: true });
    // Relocate historical public foreign keys only in the disposable fixture.
    // Migration 0019 itself is copied byte-for-byte and applied through Drizzle.
    for (const file of await readdir(folder)) {
      if (file.endsWith('.sql') && !file.startsWith('0019_')) {
        const path = join(folder, file);
        await writeFile(path, (await readFile(path, 'utf8')).replaceAll('"public".', `"${namespace}".`));
      }
    }
    const journalPath = join(folder, 'meta', '_journal.json');
    journal = JSON.parse(await readFile(journalPath, 'utf8')) as typeof journal;
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter(entry => entry.idx < 19) }));
    await migrate(db, { migrationsFolder: folder, migrationsSchema: namespace });
    owner = randomUUID(); session = randomUUID();
    await db.insert(schema.users).values({ id: owner, email: `${owner}@utc.test`, emailVerifiedAt: new Date() });
    await db.insert(schema.authSessions).values({ id: session, userId: owner, tokenHash: randomUUID(), csrfTokenHash: randomUUID(), expiresAt: new Date('2099-01-01') });
    await db.insert(schema.pushPreferences).values({ userId: owner, enabled: true, fridayTime: '19:00', timeZone: 'Europe/Rome' });
    const repository = createPushRepository(db);
    const subscribe = async () => (await repository.subscribe(owner, session, {
      endpoint: `https://fcm.googleapis.com/send/${randomUUID()}`, keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) },
    })).id;
    subscriptionId = await subscribe();
    await db.insert(schema.pushDeliveries).values({
      subscriptionId, weekStart, scopeKey: `user:${owner}`, status: 'pending', attempts: 2,
      nextAttemptAt: new Date('2030-01-04T18:01:00Z'), expiresAt: new Date('2030-01-04T20:00:00Z'),
    });
    for (const status of ['sent', 'skipped', 'expired']) {
      await db.insert(schema.pushDeliveries).values({
        subscriptionId: await subscribe(), weekStart, scopeKey: `user:${owner}`, status, expiresAt: new Date('2030-01-04T20:00:00Z'),
      });
    }
    terminalRows = await db.select().from(schema.pushDeliveries).where(eq(schema.pushDeliveries.status, 'sent'));
    terminalRows.push(...await db.select().from(schema.pushDeliveries).where(eq(schema.pushDeliveries.status, 'skipped')));
    terminalRows.push(...await db.select().from(schema.pushDeliveries).where(eq(schema.pushDeliveries.status, 'expired')));
  }, 15_000);
  afterEach(async () => {
    vi.useRealTimers();
    if (client) await client.end({ timeout: 5 });
    if (namespace) await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`);
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  afterAll(async () => { await admin.end({ timeout: 5 }); });

  const upgrade = async () => {
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    await migrate(db, { migrationsFolder: folder, migrationsSchema: namespace });
  };
  const tick = async (instant: string) => {
    vi.setSystemTime(new Date(instant));
    await runPushTick(db, transport, new Date(instant));
  };

  it.each(['Europe/Rome', 'UTC'])('requeues pending %s deliveries at UTC and preserves terminal deduplication', async (timeZone) => {
    await db.update(schema.pushPreferences).set({ timeZone }).where(eq(schema.pushPreferences.userId, owner));
    await upgrade();
    const afterUpgrade = await db.select().from(schema.pushDeliveries);
    expect(afterUpgrade).toHaveLength(3);
    expect(afterUpgrade).toEqual(expect.arrayContaining(terminalRows));
    await tick('2030-01-04T18:30:00Z');
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await db.select().from(schema.pushDeliveries).where(eq(schema.pushDeliveries.subscriptionId, subscriptionId))).toEqual([]);
    await tick('2030-01-04T19:00:00Z');
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(sendNotification).mock.calls[0][1] as string)).toMatchObject({ expiresAt: '2030-01-04T21:00:00.000Z' });
    expect(vi.mocked(sendNotification).mock.calls[0][2]).toMatchObject({ TTL: 7200 });
    const [delivery] = await db.select().from(schema.pushDeliveries).where(eq(schema.pushDeliveries.subscriptionId, subscriptionId));
    expect(delivery).toMatchObject({ status: 'sent', expiresAt: new Date('2030-01-04T21:00:00Z') });
    await Promise.all([runPushTick(db, transport, new Date()), runPushTick(db, transport, new Date())]);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.pushDeliveries)).toEqual(expect.arrayContaining(terminalRows));
  });

  it('retries with a residual TTL and expires at the fixed UTC deadline', async () => {
    await upgrade();
    vi.mocked(sendNotification).mockRejectedValue({ statusCode: 503 });
    await tick('2030-01-04T19:00:00Z');
    await tick('2030-01-04T19:01:00Z');
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendNotification).mock.calls.map(call => call[2]?.TTL)).toEqual([7200, 7140]);
    await tick('2030-01-04T21:00:00Z');
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [delivery] = await db.select().from(schema.pushDeliveries).where(eq(schema.pushDeliveries.subscriptionId, subscriptionId));
    expect(delivery).toMatchObject({ status: 'expired', expiresAt: new Date('2030-01-04T21:00:00Z') });
  });

  it.each(['revoked', 'disabled', 'complete'])('does not requeue when the current state is %s', async (condition) => {
    if (condition === 'revoked') await db.delete(schema.authSessions).where(eq(schema.authSessions.id, session));
    if (condition === 'disabled') await db.update(schema.pushPreferences).set({ enabled: false }).where(eq(schema.pushPreferences.userId, owner));
    if (condition === 'complete') {
      await db.insert(schema.mealPlanStates).values(Array.from({ length: 7 }, (_, index) => ({
        scopeType: 'user', scopeId: owner, userScopeId: owner, planDate: `2030-01-${String(7 + index).padStart(2, '0')}`,
        revision: randomUUID(), kind: 'manual', recipeId: 'recipe',
      })));
    }
    const planBefore = await db.select().from(schema.mealPlanStates);
    await upgrade();
    await tick('2030-01-04T19:00:00Z');
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await db.select().from(schema.mealPlanStates)).toEqual(planBefore);
  });
});
