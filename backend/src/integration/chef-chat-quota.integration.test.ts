import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { createClient } from 'redis';
import { createChefChatRedisMirror } from '../ai/chefChatRedis.js';
import { createChefChatQuota } from '../ai/chefChatQuota.js';
import { createChefChatQuotaStore } from '../ai/chefChatQuotaStore.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

suite('chef chat quota with PostgreSQL', () => {
  const first = createDatabase(url ?? 'postgres://unused');
  const second = createDatabase(url ?? 'postgres://unused');
  const testUsers: string[] = [];
  async function createUser(): Promise<string> {
    const id = randomUUID();
    await first.db.execute(sql`INSERT INTO users (id, email) VALUES (${id}::uuid, ${`${id}@example.test`})`);
    testUsers.push(id);
    return id;
  }
  beforeAll(async () => {
    await migrate(first.db, { migrationsFolder });
    await first.db.execute(sql`DELETE FROM chef_chat_operations`);
    await first.db.execute(sql`DELETE FROM chef_chat_control`);
  });
  beforeEach(async () => {
    await first.db.execute(sql`DELETE FROM chef_chat_operations`);
    await first.db.execute(sql`DELETE FROM chef_chat_control`);
  });
  afterAll(async () => {
    for (const id of testUsers) await first.db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`);
    await first.close();
    await second.close();
  });

  it('fails closed without explicit control initialization', async () => {
    const store = createChefChatQuotaStore(first.db);
    expect(await store.reserve(randomUUID())).toEqual({ kind: 'unavailable' });
  });

  it.skipIf(!process.env.INTEGRATION_REDIS_URL)('fails closed when the real Redis client is closed', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const client = createClient({ url: process.env.INTEGRATION_REDIS_URL!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    const mirror = createChefChatRedisMirror(client);
    const user = await createUser();
    try {
      const quota = createChefChatQuota({ ping: () => client.ping(), ...mirror }, createChefChatQuotaStore(first.db));
      const admission = await quota.reserve(user);
      expect(admission.kind).toBe('allowed');
      client.destroy();
      if (admission.kind !== 'allowed') throw new Error('Expected admission');
      expect(await quota.dispatch(admission.operationId, admission.token)).toBe(false);
      const rows = await first.db.execute<{ state: string }>(sql`SELECT state FROM chef_chat_operations WHERE id = ${admission.operationId}::uuid`);
      expect(rows[0]?.state).toBe('reserved');
    } finally {
      if (client.isOpen) client.destroy();
      const cleanupClient = createClient({ url: process.env.INTEGRATION_REDIS_URL!, disableOfflineQueue: true });
      cleanupClient.on('error', () => undefined);
      await cleanupClient.connect();
      try {
        await cleanupClient.del([`ikuck:chef-chat:{${user}}:day`, `ikuck:chef-chat:{${user}}:minute`]);
      } finally {
        cleanupClient.destroy();
      }
    }
  });

  it.skipIf(!process.env.INTEGRATION_REDIS_URL)('releases both mirrored accounting and the safe pre-dispatch reservation', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const client = createClient({ url: process.env.INTEGRATION_REDIS_URL!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    const user = await createUser();
    const keys = [`ikuck:chef-chat:{${user}}:day`, `ikuck:chef-chat:{${user}}:minute`];
    const store = createChefChatQuotaStore(first.db);
    const quota = createChefChatQuota({ ping: () => client.ping(), ...createChefChatRedisMirror(client) }, store);
    try {
      const reservation = await quota.reserve(user);
      if (reservation.kind !== 'allowed') throw new Error('Expected admission');
      expect(await quota.cancel(user, reservation.operationId, reservation.token)).toBe(true);
      expect(await quota.cancel(user, reservation.operationId, reservation.token)).toBe(true);
      expect(await client.zCard(keys[0]!)).toBe(0);
      expect((await quota.reserve(user)).kind).toBe('allowed');
    } finally {
      await client.del(keys);
      client.destroy();
    }
  });

  it.skipIf(!process.env.INTEGRATION_REDIS_URL)('keeps the PostgreSQL minute limit after loss of Redis mirror keys', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const client = createClient({ url: process.env.INTEGRATION_REDIS_URL!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    const user = await createUser();
    const keys = [`ikuck:chef-chat:{${user}}:day`, `ikuck:chef-chat:{${user}}:minute`];
    const store = createChefChatQuotaStore(first.db);
    const quota = createChefChatQuota({ ping: () => client.ping(), ...createChefChatRedisMirror(client) }, store);
    try {
      for (let index = 0; index < 5; index++) {
        const reservation = await quota.reserve(user);
        if (reservation.kind !== 'allowed') throw new Error(`Expected admission ${index}`);
        expect(await quota.dispatch(reservation.operationId, reservation.token)).toBe(true);
        expect(await store.settle(reservation.operationId, reservation.token)).toBe(true);
      }
      await client.del(keys);
      expect((await quota.reserve(user)).kind).toBe('limited');
    } finally {
      await client.del(keys);
      client.destroy();
    }
  });

  it('serializes competing reservations across pools', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET enabled = true`);
    const user = await createUser();
    const a = createChefChatQuotaStore(first.db);
    const b = createChefChatQuotaStore(second.db);
    const results = await Promise.all([a.reserve(user), b.reserve(user)]);
    expect(results.filter((r) => r.kind === 'allowed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'limited')).toHaveLength(1);
  });

  it('admits at most eight different users across independent database pools', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const a = createChefChatQuotaStore(first.db);
    const b = createChefChatQuotaStore(second.db);
    const users = await Promise.all(Array.from({ length: 16 }, () => createUser()));
    const results = await Promise.all(users.map((user, index) => (index % 2 ? a : b).reserve(user)));
    expect(results.filter((r) => r.kind === 'allowed')).toHaveLength(8);
    expect(results.filter((r) => r.kind === 'limited')).toHaveLength(8);
  });

  it('enforces the rolling minute window and retains a dispatch after settlement', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const store = createChefChatQuotaStore(first.db);
    const user = await createUser();
    for (let index = 0; index < 5; index++) {
      const reservation = await store.reserve(user);
      if (reservation.kind !== 'allowed') throw new Error(`Expected admission ${index}`);
      expect(await store.dispatch(reservation.operationId, reservation.token)).toBe(true);
      expect(await store.settle(reservation.operationId, reservation.token)).toBe(true);
    }
    const denied = await store.reserve(user);
    expect(denied.kind).toBe('limited');
    if (denied.kind === 'limited') expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    await first.db.execute(sql`UPDATE chef_chat_operations SET created_at = clock_timestamp() - interval '61 seconds'`);
    expect((await store.reserve(user)).kind).toBe('allowed');
  });

  it('evaluates the rolling window after waiting for the cross-process lock', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const user = await createUser();
    await first.db.execute(sql`
      INSERT INTO chef_chat_operations (id, user_id, token, state, created_at)
      SELECT gen_random_uuid(), ${user}::uuid, gen_random_uuid(), 'settled', clock_timestamp() - interval '59.5 seconds'
      FROM generate_series(1, 5)`);
    let unlock!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { unlock = resolve; });
    const holding = first.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM chef_chat_control WHERE id = 1 FOR UPDATE`);
      locked();
      await released;
    });
    await acquired;
    const attempt = createChefChatQuotaStore(second.db).reserve(user);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    unlock();
    await holding;
    expect((await attempt).kind).toBe('allowed');
  });

  it('enforces thirty dispatches per UTC day and ignores previous-day accounting', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const user = await createUser();
    await first.db.execute(sql`
      INSERT INTO chef_chat_operations (id, user_id, token, state, created_at)
      SELECT gen_random_uuid(), ${user}::uuid, gen_random_uuid(), 'settled', clock_timestamp()
      FROM generate_series(1, 30)`);
    const store = createChefChatQuotaStore(first.db);
    const denied = await store.reserve(user);
    expect(denied.kind).toBe('limited');
    if (denied.kind === 'limited') expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    await first.db.execute(sql`UPDATE chef_chat_operations SET created_at = (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second'`);
    expect((await store.reserve(user)).kind).toBe('allowed');
  });

  it('retains quarantined gates irrespective of their age', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const store = createChefChatQuotaStore(first.db);
    const user = await createUser();
    const reservation = await store.reserve(user);
    if (reservation.kind !== 'allowed') throw new Error('Expected admission');
    expect(await store.dispatch(reservation.operationId, reservation.token)).toBe(true);
    expect(await store.quarantine(reservation.operationId, reservation.token)).toBe(true);
    await first.db.execute(sql`UPDATE chef_chat_operations SET created_at = clock_timestamp() - interval '2 days'`);
    expect((await store.reserve(user)).kind).toBe('limited');
    expect(await store.settle(reservation.operationId, reservation.token)).toBe(false);
  });

  it('cleans only old safely finished operations and retains all uncertain gates', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const store = createChefChatQuotaStore(first.db);
    const safe = await store.reserve(await createUser());
    const uncertain = await store.reserve(await createUser());
    if (safe.kind !== 'allowed' || uncertain.kind !== 'allowed') throw new Error('Expected admission');
    expect(await store.cancel(safe.operationId, safe.token)).toBe(true);
    await first.db.execute(sql`UPDATE chef_chat_operations SET created_at = clock_timestamp() - interval '2 days'`);
    expect(await store.cleanup()).toBe(1);
    const rows = await first.db.execute<{ state: string }>(sql`SELECT state FROM chef_chat_operations`);
    expect(rows.map((row) => row.state)).toEqual(['reserved']);
  });

  it('allows repeated safe cancellation without refunding dispatched attempts', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const store = createChefChatQuotaStore(first.db);
    const reservation = await store.reserve(await createUser());
    if (reservation.kind !== 'allowed') throw new Error('Expected admission');
    expect(await store.cancel(reservation.operationId, reservation.token)).toBe(true);
    expect(await store.cancel(reservation.operationId, reservation.token)).toBe(true);
  });

  it('keeps dispatched attempts charged and rejects stale ownership or unsafe cancellation', async () => {
    await first.db.execute(sql`INSERT INTO chef_chat_control (id, enabled) VALUES (1, true)`);
    const store = createChefChatQuotaStore(first.db);
    const user = await createUser();
    const reservation = await store.reserve(user);
    if (reservation.kind !== 'allowed') throw new Error('Expected admission');
    expect(await store.dispatch(reservation.operationId, reservation.token)).toBe(true);
    expect(await store.dispatch(reservation.operationId, reservation.token)).toBe(false);
    expect(await store.cancel(reservation.operationId, reservation.token)).toBe(false);
    expect(await store.settle(reservation.operationId, randomUUID())).toBe(false);
    expect((await store.reserve(user)).kind).toBe('limited');
    expect(await store.settle(reservation.operationId, reservation.token)).toBe(true);
    const rows = await first.db.execute<{ state: string }>(sql`SELECT state FROM chef_chat_operations WHERE id = ${reservation.operationId}::uuid`);
    expect(rows[0]?.state).toBe('settled');
  });
});
