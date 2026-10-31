import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { inArray } from 'drizzle-orm';
import type { SyncMutationScope } from '@ikuck/shared/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { houses, users } from '../db/schema.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';
import { createDrizzleSyncRepository, SyncMembershipRequiredError } from '../sync/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('meal plan household persistence in PostgreSQL', () => {
  const database = createDatabase(url!);
  const adminId = randomUUID();
  const joiningMemberId = randomUUID();
  const otherHouseMemberId = randomUUID();
  const userIds = [adminId, joiningMemberId, otherHouseMemberId];
  const date = '2026-11-04';
  let restartedDatabase: ReturnType<typeof createDatabase> | null = null;

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'),
    });
    await database.db.insert(users).values(userIds.map((id) => ({
      id,
      email: `meal-plan-house-${id}@example.com`,
      emailVerifiedAt: new Date(),
    })));
  });

  afterAll(async () => {
    const cleanupDatabase = restartedDatabase ?? database;
    await cleanupDatabase.db.delete(houses).where(inArray(houses.createdByUserId, userIds));
    await cleanupDatabase.db.delete(users).where(inArray(users.id, userIds));
    if (restartedDatabase !== null) await restartedDatabase.close();
    await database.close();
  });

  it('imports an existing manual choice into the active house and keeps it after reopening the database', async () => {
    const syncRepository = createDrizzleSyncRepository(database.db);
    const houseService = createHouseService({
      repository: createDrizzleHouseRepository(database.db),
      syncRepository,
    });
    const accountScope: SyncMutationScope = `account:${joiningMemberId}`;
    const originalChoice = await syncRepository.applyMealPlanCommand(joiningMemberId, {
      version: 2,
      scope: accountScope,
      date,
      operationId: randomUUID(),
      deviceId: 'pre-house-device',
      action: 'manual_set',
      recipeId: 'recipe-chosen-before-joining',
      clientUpdatedAt: '2026-10-10T12:00:00.000Z',
    });
    expect(originalChoice).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'recipe-chosen-before-joining' } });

    const created = await houseService.createHouse(adminId, 'Plan persistence');
    const houseId = created.state.house?.id;
    expect(houseId).toBeDefined();
    if (houseId === undefined) throw new Error('House creation did not return the created house');

    const otherHouse = await houseService.createHouse(otherHouseMemberId, 'Other house');
    const otherHouseId = otherHouse.state.house?.id;
    expect(otherHouseId).toBeDefined();
    if (otherHouseId === undefined) throw new Error('Other house creation did not return the created house');

    const houseScope: SyncMutationScope = `house:${houseId}`;
    await expect(syncRepository.readMealPlanStates(otherHouseMemberId, houseScope, [date]))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });

    await houseService.addMember(adminId, `meal-plan-house-${joiningMemberId}@example.com`);
    await expect(syncRepository.readMealPlanStates(joiningMemberId, accountScope, [date]))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });

    await database.close();
    restartedDatabase = createDatabase(url!);
    const reopenedRepository = createDrizzleSyncRepository(restartedDatabase.db);
    const visibleToNewMember = await reopenedRepository.readMealPlanStates(joiningMemberId, houseScope, [date]);
    const migratedState = visibleToNewMember.states[0]?.state;
    expect(migratedState).toMatchObject({ kind: 'manual', recipeId: 'recipe-chosen-before-joining' });
    if (migratedState === null || migratedState === undefined) throw new Error('Migrated meal-plan state is missing');
    expect(migratedState.revision).not.toBe(originalChoice.current?.revision);
    const mealPlanChanges = await reopenedRepository.readChanges(joiningMemberId, 0, 100, houseScope, ['meal_plan_entry']);
    expect(mealPlanChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'meal_plan_entry',
        entityId: date,
        payload: expect.objectContaining({
          revision: migratedState.revision,
          serverSequence: migratedState.serverSequence,
          kind: 'manual',
          recipeId: 'recipe-chosen-before-joining',
        }),
      }),
    ]));
    await reopenedRepository.migrateUserSharedDataToHouse(joiningMemberId, houseId);
    await expect(reopenedRepository.readMealPlanStates(joiningMemberId, houseScope, [date]))
      .resolves.toEqual(visibleToNewMember);
    const olderHouseChoice = await reopenedRepository.applyMealPlanCommand(joiningMemberId, {
      version: 2,
      scope: houseScope,
      date,
      operationId: randomUUID(),
      deviceId: 'pre-house-device',
      action: 'manual_set',
      recipeId: 'older-house-choice',
      clientUpdatedAt: '2026-10-09T12:00:00.000Z',
    });
    expect(olderHouseChoice).toMatchObject({
      outcome: 'conflict',
      current: { kind: 'manual', recipeId: 'recipe-chosen-before-joining' },
    });

    await expect(reopenedRepository.readMealPlanStates(otherHouseMemberId, houseScope, [date]))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });
    await expect(reopenedRepository.readMealPlanStates(randomUUID(), houseScope, [date]))
      .rejects.toBeInstanceOf(SyncMembershipRequiredError);
    await expect(reopenedRepository.migrateUserSharedDataToHouse(randomUUID(), houseId))
      .rejects.toBeInstanceOf(SyncMembershipRequiredError);
  });
});
