import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, inArray, sql } from 'drizzle-orm';
import type { PlanCommand, SyncMutation, SyncMutationScope } from '@ikuck/shared/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createDatabase } from '../db/client.js';
import { houseMigrationPending, houses, users } from '../db/schema.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };

const planDate = '2026-11-27';

integration('retryable membership migration and quarantine in PostgreSQL', () => {
  const database = createDatabase(databaseUrl!);
  const userIds: string[] = [];
  const houseIds: string[] = [];

  const createActorsAndHouse = async () => {
    const adminId = randomUuid();
    const memberId = randomUuid();
    const houseId = randomUuid();
    userIds.push(adminId, memberId);
    houseIds.push(houseId);
    await database.db.insert(users).values([
      { id: adminId, email: `pending-admin-${adminId}@example.com`, emailVerifiedAt: new Date() },
      { id: memberId, email: `pending-member-${memberId}@example.com`, emailVerifiedAt: new Date() },
    ]);
    await database.db.insert(houses).values({ id: houseId, name: 'Pending house', createdByUserId: adminId });
    await database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at)
      VALUES (${randomUuid()}, ${houseId}, ${adminId}, 'admin', now(), now())`);
    return { adminId, memberId, houseId };
  };

  const randomUuid = (): string => crypto.randomUUID();

  const authFor = (userId: string): AuthService => ({
    authenticate: async () => ({
      id: `session-${userId}`,
      userId,
      email: `${userId}@example.com`,
      emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
      csrfTokenHash: hashOpaqueToken('csrf-token'),
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }),
  }) as unknown as AuthService;

  const appFor = (userId: string, syncRepository: ReturnType<typeof createDrizzleSyncRepository>) =>
    createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: authFor(userId), appOrigin: origin, secureCookies: false },
      sync: { repository: syncRepository, authService: authFor(userId), appOrigin: origin },
      house: {
        service: createHouseService({
          repository: createDrizzleHouseRepository(database.db),
          syncRepository,
        }),
        authService: authFor(userId),
        appOrigin: origin,
        rateLimiter: { enforce: async () => undefined },
      },
    });

  const manualCommand = (scope: SyncMutationScope, operationId: string, recipeId: string): PlanCommand => ({
    version: 2,
    scope,
    date: planDate,
    operationId,
    deviceId: `${operationId}-device`,
    action: 'manual_set',
    recipeId,
    clientUpdatedAt: '2026-01-05T12:00:00.000Z',
  });

  const pendingRowFor = async (userId: string) =>
    database.db.select().from(houseMigrationPending).where(eq(houseMigrationPending.userId, userId));

  const deleteTrackedData = async () => {
    for (const houseId of houseIds) {
      await database.db.execute(sql`DELETE FROM house_memberships WHERE house_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM house_migration_pending WHERE house_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_migration_quarantines WHERE house_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_states WHERE scope_type = 'house' AND scope_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM meal_plan_receipts WHERE scope_type = 'house' AND scope_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM sync_items WHERE scope_type = 'house' AND scope_id = ${houseId}`);
      await database.db.delete(houses).where(eq(houses.id, houseId));
    }
    for (const userId of userIds) {
      await database.db.execute(sql`DELETE FROM house_migration_pending WHERE user_id = ${userId}`);
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

  it('commits direct membership, marks durable pending and answers 503 retryable when migration fails', async () => {
    const { adminId, memberId, houseId } = await createActorsAndHouse();
    const memberRepository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    await memberRepository.applyMealPlanCommand(memberId, manualCommand(`account:${memberId}`, 'pre-house-plan', 'member-recipe'));
    let failNext = true;
    const repository = {
      ...memberRepository,
      migrateUserSharedDataToHouse: async (userId: string, houseId: string, mutations?: unknown[]) => {
        if (userId === memberId && failNext) {
          failNext = false;
          throw new Error('injected membership migration failure');
        }
        return memberRepository.migrateUserSharedDataToHouse(userId, houseId, mutations);
      },
    } as unknown as ReturnType<typeof createDrizzleSyncRepository>;
    const adminApp = appFor(adminId, repository);
    try {
      const addMember = await adminApp.inject({
        method: 'POST', url: '/v1/house/members', headers,
        payload: { email: `pending-member-${memberId}@example.com` },
      });
      expect(addMember.statusCode).toBe(503);
      expect(addMember.headers['retry-after']).toBe('1');
      expect(addMember.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });
      // Membership committed despite the migration failure; the pending mark is durable.
      const pending = await pendingRowFor(memberId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.houseId).toBe(houseId);
    } finally {
      await adminApp.close();
    }
  });

  it('blocks plan reads and sync while pending, then retries idempotently through GET /v1/house', async () => {
    const { adminId, memberId, houseId } = await createActorsAndHouse();
    const memberRepository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    await memberRepository.applyMealPlanCommand(memberId, manualCommand(`account:${memberId}`, 'pre-house-plan-2', 'member-recipe-2'));
    let failNext = true;
    const repository = {
      ...memberRepository,
      migrateUserSharedDataToHouse: async (userId: string, houseId: string, mutations?: readonly SyncMutation[]) => {
        if (userId === memberId && failNext) {
          failNext = false;
          throw new Error('injected membership migration failure');
        }
        return memberRepository.migrateUserSharedDataToHouse(userId, houseId, mutations);
      },
    } as unknown as ReturnType<typeof createDrizzleSyncRepository>;
    const adminApp = appFor(adminId, repository);
    const memberApp = appFor(memberId, repository);
    try {
      await adminApp.inject({
        method: 'POST', url: '/v1/house/members', headers,
        payload: { email: `pending-member-${memberId}@example.com` },
      });
      expect(await pendingRowFor(memberId)).toHaveLength(1);

      // While pending: plan read and house-scope sync are fail-closed with 503...
      const blockedRead = await memberApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${houseId}`, dates: [planDate] },
      });
      expect(blockedRead.statusCode).toBe(503);
      expect(blockedRead.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });
      const blockedSync = await memberApp.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: { deviceId: 'blocked', cursor: 0, syncScope: `house:${houseId}`, mutations: [], supportedEntityTypes: ['meal_plan_entry'], mealPlanReadVersion: 2 },
      });
      expect(blockedSync.statusCode).toBe(503);
      expect(blockedSync.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });
      // ...while the explicit account feed keeps serving personal types only and rejects shared types.
      const personalFeed = await memberApp.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: { deviceId: 'personal', cursor: 0, syncScope: `account:${memberId}`, mutations: [], supportedEntityTypes: ['ai_consent'] },
      });
      expect(personalFeed.statusCode).toBe(200);
      const sharedRejected = await memberApp.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: { deviceId: 'shared', cursor: 0, syncScope: `account:${memberId}`, mutations: [], supportedEntityTypes: ['meal_plan_entry'] },
      });
      expect(sharedRejected.statusCode).toBe(503);
      expect(sharedRejected.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });

      // GET /v1/house retries the migration: first attempt completes and clears the pending mark.
      const bootstrap = await memberApp.inject({ method: 'GET', url: '/v1/house', headers });
      expect(bootstrap.statusCode).toBe(200);
      expect(await pendingRowFor(memberId)).toHaveLength(0);

      // The migrated Plan is available and repeated retries stay idempotent.
      const planRead = await memberApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${houseId}`, dates: [planDate] },
      });
      expect(planRead.statusCode).toBe(200);
      expect(planRead.json()).toMatchObject({
        version: 2,
        states: [{ date: planDate, state: { kind: 'manual', recipeId: 'member-recipe-2' } }],
      });
      const repeated = await memberApp.inject({ method: 'GET', url: '/v1/house', headers });
      expect(repeated.statusCode).toBe(200);
      expect(await pendingRowFor(memberId)).toHaveLength(0);
    } finally {
      await adminApp.close();
      await memberApp.close();
    }
  });

  it('retries POST /v1/house/import-personal-data idempotently and clears pending after commit', async () => {
    const { memberId } = await createActorsAndHouse();
    const memberRepository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    await memberRepository.applyMealPlanCommand(memberId, manualCommand(`account:${memberId}`, 'import-plan', 'import-recipe'));
    let failNext = true;
    const repository = {
      ...memberRepository,
      migrateUserSharedDataToHouse: async (userId: string, houseId: string, mutations?: unknown[]) => {
        if (userId === memberId && failNext) {
          failNext = false;
          throw new Error('injected import migration failure');
        }
        return memberRepository.migrateUserSharedDataToHouse(userId, houseId, mutations);
      },
    } as unknown as ReturnType<typeof createDrizzleSyncRepository>;
    const memberApp = appFor(memberId, repository);
    try {
      const first = await memberApp.inject({ method: 'POST', url: '/v1/house/import-personal-data', headers });
      expect(first.statusCode).toBe(503);
      expect(first.headers['retry-after']).toBe('1');
      expect(first.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });
      expect(await pendingRowFor(memberId)).toHaveLength(1);

      const second = await memberApp.inject({ method: 'POST', url: '/v1/house/import-personal-data', headers });
      expect(second.statusCode).toBe(204);
      expect(await pendingRowFor(memberId)).toHaveLength(0);

      const third = await memberApp.inject({ method: 'POST', url: '/v1/house/import-personal-data', headers });
      expect(third.statusCode).toBe(204);
      expect(await pendingRowFor(memberId)).toHaveLength(0);
    } finally {
      await memberApp.close();
    }
  });

  it('fences a quarantined legacy manual source without tuple and exposes it read-only', async () => {
    const { memberId, houseId } = await createActorsAndHouse();
    const repository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    const accountScope: SyncMutationScope = `account:${memberId}`;
    const operationId = `quarantined-legacy-${randomUuid()}`;
    await repository.applyMealPlanCommand(memberId, manualCommand(accountScope, operationId, 'legacy-recipe'));
    // Drop the manual tuple and the import provenance to simulate a malformed legacy source.
    await database.db.execute(sql`UPDATE meal_plan_states SET
      manual_client_at = NULL, manual_server_at = NULL, manual_device_id = NULL, manual_operation_id = NULL
      WHERE scope_type = 'user' AND scope_id = ${memberId} AND plan_date = ${planDate}`);
    await database.db.execute(sql`DELETE FROM meal_plan_receipts
      WHERE scope_type = 'user' AND scope_id = ${memberId} AND operation_id = ${operationId}`);
    await database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at)
      VALUES (${randomUuid()}, ${houseId}, ${memberId}, 'member', now(), now())`);

    await repository.migrateUserSharedDataToHouse(memberId, houseId);

    const quarantines = await database.db.execute(sql`
      SELECT reason_code, fingerprint, raw_source_state, raw_source_projection, raw_target_state, raw_target_projection
      FROM meal_plan_migration_quarantines
      WHERE house_id = ${houseId} AND source_account_id = ${memberId} AND plan_date = ${planDate}`);
    expect(quarantines).toHaveLength(1);
    const quarantine = quarantines[0] as Record<string, unknown>;
    expect(quarantine.reason_code).toBe('manual_tuple_missing');
    expect(String(quarantine.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(quarantine.raw_source_state)).toContain('legacy-recipe');
    expect(quarantine.raw_target_state).toBeNull();

    const memberApp = appFor(memberId, repository);
    try {
      const read = await memberApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${houseId}`, dates: [planDate] },
      });
      expect(read.statusCode).toBe(409);
      expect(read.json()).toMatchObject({ code: 'plan_migration_quarantined' });
      const sync = await memberApp.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: { deviceId: 'quarantined-reader', cursor: 0, syncScope: `house:${houseId}`, mutations: [], supportedEntityTypes: ['meal_plan_entry'], mealPlanReadVersion: 2 },
      });
      expect(sync.statusCode).toBe(409);
      expect(sync.json()).toMatchObject({ code: 'plan_migration_quarantined' });

      const recovery = await memberApp.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
      expect(recovery.statusCode).toBe(200);
      expect(recovery.json()).toMatchObject({
        version: 2,
        quarantined: [{
          planDate,
          reasonCode: 'manual_tuple_missing',
          sourceSnapshot: { state: expect.any(Object), projection: expect.any(Object) },
          targetSnapshot: { state: null, projection: null },
          observed: { manualTuple: null, command: null },
        }],
      });

      // Idempotent re-migration keeps exactly one quarantine row.
      await repository.migrateUserSharedDataToHouse(memberId, houseId);
      expect(await database.db.execute(sql`SELECT id FROM meal_plan_migration_quarantines
        WHERE house_id = ${houseId} AND source_account_id = ${memberId} AND plan_date = ${planDate}`))
        .toHaveLength(1);
    } finally {
      await memberApp.close();
    }
  });

  it('blocks readAll (export) while migration pending and unblocks after commit', async () => {
    const { adminId, memberId } = await createActorsAndHouse();
    const memberRepository = createDrizzleSyncRepository(database.db, { mealPlanV2Enabled: true });
    await memberRepository.applyMealPlanCommand(memberId, manualCommand(`account:${memberId}`, 'export-plan', 'export-recipe'));
    let failNext = true;
    const repository = {
      ...memberRepository,
      migrateUserSharedDataToHouse: async (userId: string, houseId: string, mutations?: readonly SyncMutation[]) => {
        if (userId === memberId && failNext) {
          failNext = false;
          throw new Error('injected membership migration failure');
        }
        return memberRepository.migrateUserSharedDataToHouse(userId, houseId, mutations);
      },
    } as unknown as ReturnType<typeof createDrizzleSyncRepository>;
    const adminApp = appFor(adminId, repository);
    const memberApp = appFor(memberId, repository);
    try {
      await adminApp.inject({
        method: 'POST', url: '/v1/house/members', headers,
        payload: { email: `pending-member-${memberId}@example.com` },
      });
      expect(await pendingRowFor(memberId)).toHaveLength(1);

      // While pending: readAll (export) is fail-closed with 503
      const blockedExport = await memberApp.inject({
        method: 'GET', url: '/v1/sync/export', headers,
      });
      expect(blockedExport.statusCode).toBe(503);
      expect(blockedExport.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });

      // GET /v1/house retries the migration: first attempt completes and clears the pending mark.
      const bootstrap = await memberApp.inject({ method: 'GET', url: '/v1/house', headers });
      expect(bootstrap.statusCode).toBe(200);
      expect(await pendingRowFor(memberId)).toHaveLength(0);

      // readAll now works and includes the migrated house Plan
      const exportRead = await memberApp.inject({ method: 'GET', url: '/v1/sync/export', headers });
      expect(exportRead.statusCode).toBe(200);
      const exportData = exportRead.json();
      const planEntries = exportData.filter((e: { entityType: string }) => e.entityType === 'meal_plan_entry');
      expect(planEntries.length).toBeGreaterThanOrEqual(1);
    } finally {
      await adminApp.close();
      await memberApp.close();
    }
  });
});
