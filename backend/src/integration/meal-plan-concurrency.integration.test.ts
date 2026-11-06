import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanCommand } from '@ikuck/shared/contracts';
import { createDatabase } from '../db/client.js';
import { houseMemberships, houses, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createDrizzleSyncRepository, SyncMembershipRequiredError } from '../sync/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('meal plan concurrent writes in PostgreSQL', () => {
  const database = createDatabase(url!);
  const userId = randomUUID();
  beforeAll(async () => {
    await migrate(database.db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations') });
    await database.db.insert(users).values({ id: userId, email: `plan-${userId}@example.com`, emailVerifiedAt: new Date() });
    // Widen the insert window for this test's devices only; never affect other rows.
    await database.db.execute(sql.raw(`CREATE FUNCTION meal_plan_test_delay_${userId.replaceAll('-', '')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.device_id LIKE 'plan-race-${userId}-%' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END $$`));
    await database.db.execute(sql.raw(`CREATE TRIGGER meal_plan_test_delay_${userId.replaceAll('-', '')} BEFORE INSERT ON sync_items FOR EACH ROW EXECUTE FUNCTION meal_plan_test_delay_${userId.replaceAll('-', '')}()`));
  });
  afterAll(async () => {
    await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS meal_plan_test_delay_${userId.replaceAll('-', '')} ON sync_items`));
    await database.db.execute(sql.raw(`DROP FUNCTION IF EXISTS meal_plan_test_delay_${userId.replaceAll('-', '')}()`));
    await database.close();
  });
  it('preserves the newer revision when concurrent updates race', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const date = '2026-10-30';
    const command = (device: string, time: string): PlanCommand => ({
      version: 2, scope: `account:${userId}`, date, operationId: randomUUID(),
      deviceId: `plan-race-${userId}-${device}`, action: 'manual_set', recipeId: device,
      clientUpdatedAt: time,
    });
    await repository.applyMealPlanCommand(userId, command('initial', '2026-01-01T00:00:00.000Z'));
    const trigger = `meal_plan_update_${userId.replaceAll('-', '')}`;
    await database.db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.device_id = 'plan-race-${userId}-newer-update' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $$`));
    await database.db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON sync_items FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
    try {
      const newer = repository.applyMealPlanCommand(userId, command('newer-update', '2026-01-03T00:00:00.000Z'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const older = repository.applyMealPlanCommand(userId, command('older-update', '2026-01-02T00:00:00.000Z'));
      await Promise.all([older, newer]);
      await expect(repository.readMealPlanStates(userId, `account:${userId}`, [date]))
        .resolves.toMatchObject({ states: [{ date, state: { recipeId: 'newer-update' } }] });
    } finally {
      await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON sync_items`));
      await database.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`));
    }
  });
  it('deduplicates concurrent replay of a mutation across repository instances', async () => {
    const command: PlanCommand = {
      version: 2, scope: `account:${userId}`, date: '2026-11-01', operationId: randomUUID(),
      deviceId: `plan-race-${userId}-replay`, action: 'manual_set', recipeId: 'replay',
      clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    };
    const results = await Promise.all([
      createDrizzleSyncRepository(database.db).applyMealPlanCommand(userId, command),
      createDrizzleSyncRepository(database.db).applyMealPlanCommand(userId, command),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ outcome: 'applied' });
  });
  it('allows only one concurrent automatic proposal based on the same absent state', async () => {
    const repositories = [
      createDrizzleSyncRepository(database.db),
      createDrizzleSyncRepository(database.db),
    ];
    const date = '2026-11-03';
    const makeCommand = (device: string, recipeId: string): PlanCommand => ({
      version: 2, scope: `account:${userId}`, date, operationId: randomUUID(),
      deviceId: `plan-race-${userId}-${device}`, action: 'auto_create', recipeId,
      baseRevision: null, clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    const results = await Promise.all([
      repositories[0]!.applyMealPlanCommand(userId, makeCommand('proposal-a', 'recipe-a')),
      repositories[1]!.applyMealPlanCommand(userId, makeCommand('proposal-b', 'recipe-b')),
    ]);
    const applied = results.filter((result) => result.outcome === 'applied');
    const conflicted = results.filter((result) => result.outcome === 'conflict');
    expect(applied).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0]!.current).toEqual(applied[0]!.current);
    await expect(repositories[1]!.readMealPlanStates(userId, `account:${userId}`, [date]))
      .resolves.toMatchObject({ states: [{ date, state: applied[0]!.current }] });
  });
  it('serializes shared house writes and rejects a write after membership revocation', async () => {
    const memberId = randomUUID();
    const adminId = randomUUID();
    const houseId = randomUUID();
    await database.db.insert(users).values([memberId, adminId].map((id) => ({ id, email: `plan-${id}@example.com`, emailVerifiedAt: new Date() })));
    await database.db.insert(houses).values({ id: houseId, name: 'Plan test', createdByUserId: adminId });
    await database.db.insert(houseMemberships).values([
      { houseId, userId: adminId, role: 'admin' }, { houseId, userId: memberId, role: 'member' },
    ]);
    const repository = createDrizzleSyncRepository(database.db, { scopeResolver: async () => ({ kind: 'house', id: houseId }) });
    const command = (recipeId: string, time: string): PlanCommand => ({
      version: 2, scope: `house:${houseId}`, date: '2026-11-02', operationId: randomUUID(),
      deviceId: `plan-race-${userId}-${recipeId}`, action: 'manual_set', recipeId,
      clientUpdatedAt: time,
    });
    await Promise.all([
      repository.applyMealPlanCommand(adminId, command('older', '2026-01-01T00:00:00.000Z')),
      repository.applyMealPlanCommand(memberId, command('newer', '2026-01-02T00:00:00.000Z')),
    ]);
    await expect(repository.readMealPlanStates(adminId, `house:${houseId}`, ['2026-11-02']))
      .resolves.toMatchObject({ states: [{ state: { recipeId: 'newer' } }] });
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const revoke = database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM ${houses} WHERE id = ${houseId} FOR UPDATE`);
      await tx.delete(houseMemberships).where(eq(houseMemberships.userId, memberId));
      locked();
      await gate;
    });
    await ready;
    const pending = repository.applyMealPlanCommand(memberId, command('revoked', '2026-01-03T00:00:00.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await revoke;
    await expect(pending).rejects.toThrow(SyncMembershipRequiredError);
    await expect(repository.readMealPlanStates(adminId, `house:${houseId}`, ['2026-11-02']))
      .resolves.toMatchObject({ states: [{ state: { recipeId: 'newer' } }] });
  });
  it('converges to the newer selection when two devices create the same date concurrently', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const makeCommand = (device: string, time: string): PlanCommand => ({
      version: 2, scope: `account:${userId}`, date: '2026-10-29', operationId: randomUUID(),
      deviceId: `plan-race-${userId}-${device}`, action: 'manual_set', recipeId: device,
      clientUpdatedAt: time,
    });
    const older = makeCommand('older', '2026-01-01T00:00:00.000Z');
    const newer = makeCommand('newer', '2026-01-02T00:00:00.000Z');
    const results = await Promise.allSettled([
      repository.applyMealPlanCommand(userId, older), repository.applyMealPlanCommand(userId, newer),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(failures.map((failure) => String(failure.reason?.cause ?? failure.reason))).toEqual([]);
    await expect(repository.readMealPlanStates(userId, `account:${userId}`, ['2026-10-29']))
      .resolves.toMatchObject({ states: [{ state: { recipeId: 'newer' } }] });
  });
});
