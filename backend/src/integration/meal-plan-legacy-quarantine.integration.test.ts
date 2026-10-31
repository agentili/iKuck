import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, inArray, sql } from 'drizzle-orm';
import type { PlanCommand, SyncMutationScope } from '@ikuck/shared/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createDatabase } from '../db/client.js';
import { houses, users } from '../db/schema.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };

integration('legacy meal-plan migration quarantine in PostgreSQL', () => {
  const database = createDatabase(databaseUrl!);
  const userIds: string[] = [];
  const houseIds: string[] = [];

  const createActorsAndHouse = async (label: string) => {
    const userId = randomUUID();
    const adminId = randomUUID();
    const houseId = randomUUID();
    userIds.push(userId, adminId);
    houseIds.push(houseId);
    await database.db.insert(users).values([
      { id: userId, email: `plan-quarantine-${label}-${userId}@example.com`, emailVerifiedAt: new Date() },
      { id: adminId, email: `plan-quarantine-${label}-${adminId}@example.com`, emailVerifiedAt: new Date() },
    ]);
    await database.db.insert(houses).values({ id: houseId, name: `Plan quarantine ${label}`, createdByUserId: adminId });
    await addMembership(adminId, houseId, 'admin');
    return { userId, adminId, houseId };
  };

  const addMembership = async (userId: string, houseId: string, role: 'admin' | 'member') =>
    database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at)
      VALUES (${randomUUID()}, ${houseId}, ${userId}, ${role}, now(), now())`);

  const commandFor = (
    scope: SyncMutationScope,
    date: string,
    operationId: string,
    action: 'manual_set' | 'manual_delete',
    clientUpdatedAt: string,
  ): PlanCommand => action === 'manual_set'
    ? {
      version: 2, scope, date, operationId, deviceId: `${operationId}-device`,
      action, recipeId: `${operationId}-recipe`, clientUpdatedAt,
    }
    : {
      version: 2, scope, date, operationId, deviceId: `${operationId}-device`,
      action, clientUpdatedAt,
    };

  const appFor = (userId: string) => {
    const authService = {
      authenticate: async () => ({
        id: `session-${userId}`,
        userId,
        email: `${userId}@example.com`,
        emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
        csrfTokenHash: hashOpaqueToken('csrf-token'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      }),
    } as unknown as AuthService;
    return createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      sync: {
        repository: createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true }),
        authService,
        appOrigin: origin,
      },
    });
  };

  const seedLegacyPlan = async (input: {
    userId: string;
    houseId: string;
    date: string;
    kind: 'manual' | 'deleted';
    operationId: string;
    clearManualTuple: boolean;
    deleteReceipt: boolean;
  }) => {
    const repository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    const accountScope: SyncMutationScope = `account:${input.userId}`;
    const command = commandFor(
      accountScope,
      input.date,
      input.operationId,
      input.kind === 'manual' ? 'manual_set' : 'manual_delete',
      '2026-01-10T12:00:00.000Z',
    );
    const receipt = await repository.applyMealPlanCommand(input.userId, command);
    expect(receipt).toMatchObject({ outcome: 'applied' });
    if (input.clearManualTuple) {
      await database.db.execute(sql`UPDATE meal_plan_states SET
        manual_client_at = NULL, manual_server_at = NULL, manual_device_id = NULL, manual_operation_id = NULL
        WHERE scope_type = 'user' AND scope_id = ${input.userId} AND plan_date = ${input.date}`);
    }
    if (input.deleteReceipt) {
      await database.db.execute(sql`DELETE FROM meal_plan_receipts
        WHERE scope_type = 'user' AND scope_id = ${input.userId} AND operation_id = ${input.operationId}`);
    }
    await addMembership(input.userId, input.houseId, 'member');
    await repository.migrateUserSharedDataToHouse(input.userId, input.houseId);
    return { repository, command };
  };

  const quarantineRowsFor = async (userId: string, houseId: string, date: string) => database.db.execute(sql`
    SELECT id, reason_code, fingerprint, raw_source_state, raw_source_projection, raw_target_state, raw_target_projection
    FROM meal_plan_migration_quarantines
    WHERE house_id = ${houseId} AND source_account_id = ${userId} AND plan_date = ${date}
    ORDER BY created_at`);

  const remainingSourceRows = async (userId: string, date: string) => {
    const states = await database.db.execute(sql`SELECT plan_date FROM meal_plan_states
      WHERE scope_type = 'user' AND scope_id = ${userId} AND plan_date = ${date}`);
    const projections = await database.db.execute(sql`SELECT id FROM sync_items
      WHERE scope_type = 'user' AND scope_id = ${userId}
        AND entity_type = 'meal_plan_entry' AND entity_id = ${date}`);
    return { states, projections };
  };

  const deleteTrackedData = async () => {
    for (const houseId of houseIds) {
      await database.db.execute(sql`DELETE FROM house_memberships WHERE house_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_migration_conflicts WHERE house_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_migration_quarantines WHERE house_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_states WHERE scope_type = 'house' AND scope_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_receipts WHERE scope_type = 'house' AND scope_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM sync_items WHERE scope_type = 'house' AND scope_id = ${houseId}`);
      await database.db.delete(houses).where(eq(houses.id, houseId));
    }
    for (const userId of userIds) {
      await database.db.execute(sql`DELETE FROM meal_plan_states WHERE scope_type = 'user' AND scope_id = ${userId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_receipts WHERE scope_type = 'user' AND scope_id = ${userId}`);
      await database.db.execute(sql`DELETE FROM sync_items WHERE scope_type = 'user' AND scope_id = ${userId}`);
    }
    if (userIds.length > 0) await database.db.delete(users).where(inArray(users.id, userIds));
  };

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'),
    });
  });

  afterAll(async () => {
    try {
      await deleteTrackedData();
    } finally {
      await database.close();
    }
  });

  it('quarantines a manual source without a tuple or receipt and exposes the raw evidence read-only', async () => {
    const { userId, adminId, houseId } = await createActorsAndHouse('manual-no-provenance');
    const date = '2026-11-28';
    const { repository, command } = await seedLegacyPlan({
      userId, houseId, date, kind: 'manual', operationId: `manual-missing-${randomUUID()}`,
      clearManualTuple: true, deleteReceipt: true,
    });

    const quarantines = await quarantineRowsFor(userId, houseId, date);
    expect(quarantines).toHaveLength(1);
    const quarantine = quarantines[0] as Record<string, unknown>;
    expect(quarantine).toMatchObject({ reason_code: 'manual_tuple_missing' });
    expect(String(quarantine.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(quarantine.raw_source_state)).toContain(date);
    expect(JSON.stringify(quarantine.raw_source_projection)).toContain(command.operationId);
    expect(JSON.stringify(quarantine.raw_source_projection)).toContain(command.deviceId);
    expect(quarantine.raw_target_state).toBeNull();
    expect(quarantine.raw_target_projection).toBeNull();
    await expect(remainingSourceRows(userId, date)).resolves.toEqual({ states: [], projections: [] });

    const recoveryApp = appFor(userId);
    const outsiderApp = appFor(adminId);
    try {
      const recovery = await recoveryApp.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
      expect(recovery.statusCode).toBe(200);
      expect(recovery.json()).toMatchObject({
        version: 2,
        quarantined: [{
          planDate: date,
          reasonCode: 'manual_tuple_missing',
          sourceSnapshot: { state: expect.any(Object), projection: expect.any(Object) },
          targetSnapshot: { state: null, projection: null },
          observed: { manualTuple: null, command: null },
        }],
      });
      const outsiderRecovery = await outsiderApp.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
      expect(outsiderRecovery.statusCode).toBe(403);
      expect(outsiderRecovery.json()).toMatchObject({ code: 'house_membership_required' });

      const repeat = await repository.migrateUserSharedDataToHouse(userId, houseId);
      expect(repeat).toBeUndefined();
      expect(await quarantineRowsFor(userId, houseId, date)).toHaveLength(1);
    } finally {
      await recoveryApp.close();
      await outsiderApp.close();
    }
  });

  it('quarantines a deleted source whose manual tuple and receipt provenance are missing', async () => {
    const { userId, houseId } = await createActorsAndHouse('deleted-no-provenance');
    const date = '2026-11-29';
    const { command } = await seedLegacyPlan({
      userId, houseId, date, kind: 'deleted', operationId: `deleted-missing-${randomUUID()}`,
      clearManualTuple: true, deleteReceipt: true,
    });

    const quarantines = await quarantineRowsFor(userId, houseId, date);
    expect(quarantines).toHaveLength(1);
    const quarantine = quarantines[0] as Record<string, unknown>;
    expect(quarantine).toMatchObject({ reason_code: 'manual_tuple_missing' });
    expect(JSON.stringify(quarantine.raw_source_state)).toContain('deleted');
    expect(JSON.stringify(quarantine.raw_source_projection)).toContain(command.operationId);
    await expect(remainingSourceRows(userId, date)).resolves.toEqual({ states: [], projections: [] });
  });

  it('quarantines a manual source whose canonical state disagrees with its sync projection', async () => {
    const { userId, houseId } = await createActorsAndHouse('source-pair-mismatch');
    const date = '2026-11-30';
    const repository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    const operationId = `source-mismatch-${randomUUID()}`;
    const command = commandFor(`account:${userId}`, date, operationId, 'manual_set', '2026-01-11T12:00:00.000Z');
    await repository.applyMealPlanCommand(userId, command);
    await database.db.execute(sql`UPDATE meal_plan_states SET recipe_id = 'canonical-only-recipe'
      WHERE scope_type = 'user' AND scope_id = ${userId} AND plan_date = ${date}`);
    await addMembership(userId, houseId, 'member');

    await repository.migrateUserSharedDataToHouse(userId, houseId);

    const quarantines = await quarantineRowsFor(userId, houseId, date);
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]).toMatchObject({ reason_code: 'source_projection_inconsistent' });
    expect(JSON.stringify(quarantines[0]?.raw_source_state)).toContain('canonical-only-recipe');
    expect(JSON.stringify(quarantines[0]?.raw_source_projection)).toContain(command.recipeId);
    await expect(remainingSourceRows(userId, date)).resolves.toEqual({ states: [], projections: [] });
  });

  it('quarantines the account source when the house canonical state disagrees with its projection', async () => {
    const { userId, adminId, houseId } = await createActorsAndHouse('destination-pair-mismatch');
    const date = '2026-12-01';
    const repository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    const sourceOperationId = `destination-source-${randomUUID()}`;
    const targetOperationId = `destination-target-${randomUUID()}`;
    const sourceCommand = commandFor(`account:${userId}`, date, sourceOperationId, 'manual_set', '2026-01-11T12:00:00.000Z');
    const targetCommand = commandFor(`house:${houseId}`, date, targetOperationId, 'manual_set', '2026-01-12T12:00:00.000Z');
    await repository.applyMealPlanCommand(userId, sourceCommand);
    await repository.applyMealPlanCommand(adminId, targetCommand);
    await database.db.execute(sql`UPDATE sync_items SET payload = jsonb_set(payload, '{recipeId}', to_jsonb('projection-only-recipe'::text))
      WHERE scope_type = 'house' AND scope_id = ${houseId}
        AND entity_type = 'meal_plan_entry' AND entity_id = ${date}`);
    await addMembership(userId, houseId, 'member');

    await repository.migrateUserSharedDataToHouse(userId, houseId);

    const quarantines = await quarantineRowsFor(userId, houseId, date);
    expect(quarantines).toHaveLength(1);
    const quarantine = quarantines[0] as Record<string, unknown>;
    expect(quarantine).toMatchObject({ reason_code: 'target_projection_inconsistent' });
    expect(JSON.stringify(quarantine.raw_source_projection)).toContain(sourceCommand.operationId);
    expect(JSON.stringify(quarantine.raw_target_state)).toContain(targetCommand.recipeId);
    expect(JSON.stringify(quarantine.raw_target_projection)).toContain('projection-only-recipe');
    await expect(remainingSourceRows(userId, date)).resolves.toEqual({ states: [], projections: [] });
  });

  it('fails closed on quarantined dates through direct Plan read and v2 Plan sync', async () => {
    const { userId, houseId } = await createActorsAndHouse('quarantine-date-fence');
    const date = '2026-12-02';
    const { repository } = await seedLegacyPlan({
      userId, houseId, date, kind: 'manual', operationId: `date-fence-${randomUUID()}`,
      clearManualTuple: true, deleteReceipt: true,
    });
    const app = appFor(userId);
    try {
      const recovery = await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
      expect(recovery.json()).toMatchObject({ quarantined: [expect.objectContaining({ planDate: date })] });

      const directRead = await app.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${houseId}`, dates: [date] },
      });
      expect(directRead.statusCode).toBe(409);
      expect(directRead.json()).toMatchObject({ code: 'plan_migration_quarantined' });

      const sync = await app.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: {
          deviceId: 'quarantine-reader', cursor: 0, syncScope: `house:${houseId}`, mutations: [],
          supportedEntityTypes: ['meal_plan_entry'], mealPlanReadVersion: 2,
        },
      });
      expect(sync.statusCode).toBe(409);
      expect(sync.json()).toMatchObject({ code: 'plan_migration_quarantined' });
      expect(await repository.readMealPlanRecovery(userId)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
