import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { CookEvent, PantryLot } from '@ikuck/shared/contracts';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { createDatabase } from '../db/client.js';
import { createDrizzleHouseRepository } from '../house/repository.js';
import { createDrizzleProfileRepository } from '../profile/repository.js';
import { dinnerConsumptionReceipts, houseMemberships, houses, processedSyncMutations, syncItems, users } from '../db/schema.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const runIntegration = databaseUrl === undefined ? describe.skip : describe;
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

runIntegration('PostgreSQL dinner-consumption integration', () => {
  const database = databaseUrl === undefined ? null : createDatabase(databaseUrl, { max: 2 });
  const secondDatabase = databaseUrl === undefined ? null : createDatabase(databaseUrl, { max: 1 });

  beforeAll(async () => {
    if (database === null) throw new Error('Integration database is not configured');
    await migrate(database.db, { migrationsFolder });
    await database.ping();
  });

  afterAll(async () => {
    await secondDatabase?.close();
    await database?.close();
  });

  it('applies the receipt migration twice and keeps the entry key scoped', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    await migrate(database.db, { migrationsFolder });
    await migrate(database.db, { migrationsFolder });

    const table = await database.db.execute(sql<{ table_count: number }>`
      SELECT count(*)::int AS table_count FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'dinner_consumption_receipts'
    `);
    const indexes = await database.db.execute(sql<{ index_name: string }>`
      SELECT indexname AS index_name FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'dinner_consumption_receipts'
    `);

    expect(table[0]?.table_count).toBe(1);
    expect(indexes.map((index) => index.index_name)).toContain('dinner_consumption_receipts_scope_entry_unique');
  });

  it('persists atomic pantry and dinner changes and returns the same receipt across repositories', async () => {
    if (database === null || secondDatabase === null) throw new Error('Integration database is not configured');
    const now = new Date();
    const [user] = await database.db.insert(users).values({
      email: `dinner-consumption-${randomUUID()}@example.test`,
      emailVerifiedAt: now,
    }).returning();
    if (user === undefined) throw new Error('Integration user was not inserted');
    const [house] = await database.db.insert(houses).values({ name: 'Dinner integration', createdByUserId: user.id }).returning();
    if (house === undefined) throw new Error('Integration house was not inserted');
    const [member] = await database.db.insert(users).values({
      email: `dinner-consumption-member-${randomUUID()}@example.test`,
      emailVerifiedAt: now,
    }).returning();
    if (member === undefined) throw new Error('Integration member was not inserted');
    await database.db.insert(houseMemberships).values([
      { houseId: house.id, userId: user.id, role: 'admin' },
      { houseId: house.id, userId: member.id, role: 'admin' },
    ]);

    const scope = `house:${house.id}` as const;
    const entryId = randomUUID();
    const command: DinnerConsumptionCommand = {
      operationId: randomUUID(),
      entryId,
      scope,
      servings: 2,
      ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
    };
    const entry: DinnerEntry = {
      id: entryId,
      date: '2026-10-07',
      text: 'Pasta',
      servings: command.servings,
      note: null,
      recipes: [],
      authorId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const cookEvent: CookEvent = {
      id: entryId,
      recipeId: randomUUID(),
      recipeTitle: 'Pasta',
      servings: command.servings,
      cookedAt: now.toISOString(),
      note: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const lot: PantryLot = {
      id: randomUUID(),
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: 500,
      unit: 'g',
      expiresAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const firstRepository = createDrizzleSyncRepository(database.db);
    await firstRepository.applyMutation(user.id, {
      mutationId: randomUUID(),
      deviceId: 'integration-dinner-consumption',
      entityType: 'pantry_lot',
      entityId: lot.id,
      operation: 'upsert',
      payload: lot,
      clientUpdatedAt: now.toISOString(),
      syncScope: scope,
    });

    const secondRepository = createDrizzleSyncRepository(secondDatabase.db);
    const initialAttempts = await Promise.all([
      firstRepository.consumeDinner(user.id, { command, entry, cookEvent }),
      secondRepository.consumeDinner(member.id, { command, entry, cookEvent }),
    ]);
    const committed = initialAttempts.find((result) => !result.duplicate);
    if (committed === undefined) throw new Error('Neither concurrent request committed the dinner');
    const concurrentRequests = Array.from({ length: 2 }, () => {
      const concurrentEntryId = randomUUID();
      const concurrentCommand: DinnerConsumptionCommand = {
        ...command,
        operationId: randomUUID(),
        entryId: concurrentEntryId,
        servings: 1,
      };
      return {
        command: concurrentCommand,
        entry: { ...entry, id: concurrentEntryId, servings: 1 },
        cookEvent: { ...cookEvent, id: concurrentEntryId, recipeId: randomUUID(), servings: 1 },
      };
    });
    await Promise.all(concurrentRequests.map((request, index) => (
      index === 0
        ? firstRepository.consumeDinner(user.id, request)
        : secondRepository.consumeDinner(member.id, request)
    )));
    const storedLot = await secondRepository.readEntity(member.id, 'pantry_lot', lot.id);
    const changes = await secondRepository.readChanges(member.id, 0, 100, scope);
    const receiptRows = await database.db.select().from(dinnerConsumptionReceipts)
      .where(eq(dinnerConsumptionReceipts.operationId, command.operationId));
    const persistedEntryRows = await database.db.select().from(syncItems).where(sql`
      ${syncItems.scopeType} = 'house' AND ${syncItems.scopeId} = ${house.id}
      AND ${syncItems.entityType} = 'dinner_entry' AND ${syncItems.entityId} = ${entryId}
    `);

    expect(initialAttempts.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(initialAttempts[0]?.receipt).toEqual(initialAttempts[1]?.receipt);
    expect(committed.pantrySnapshot.pantryLots).toEqual([{ ...lot, quantity: 300, updatedAt: committed.receipt.committedAt }]);
    expect((storedLot?.payload as PantryLot).quantity).toBe(100);
    expect(receiptRows).toHaveLength(1);
    expect(persistedEntryRows).toHaveLength(1);
    expect(changes.filter((change) => change.entityType === 'dinner_entry')).toHaveLength(3);
    expect(changes.filter((change) => change.entityType === 'cook_event')).toHaveLength(3);

    await expect(secondRepository.consumeDinner(member.id, {
      command: { ...command, operationId: randomUUID() }, entry, cookEvent,
    })).rejects.toMatchObject({ code: 'dinner_consumption_conflict', status: 409 });

    await createDrizzleProfileRepository(database.db, secondRepository).deleteAccount(user.id);
    const retainedReceipt = await database.db.select().from(dinnerConsumptionReceipts)
      .where(eq(dinnerConsumptionReceipts.operationId, command.operationId));
    const retainedEntry = await secondRepository.readEntity(member.id, 'dinner_entry', entryId);
    expect(retainedReceipt).toMatchObject([{ scopeType: 'house', scopeId: house.id, createdByUserId: null }]);
    expect(retainedEntry?.payload).toMatchObject({ id: entryId, authorId: user.id });
  });

  it('supports account scope and removes presence-only stock once without inventing quantity', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const now = new Date();
    const [user] = await database.db.insert(users).values({
      email: `dinner-consumption-account-${randomUUID()}@example.test`,
      emailVerifiedAt: now,
    }).returning();
    if (user === undefined) throw new Error('Integration account was not inserted');
    const scope = `account:${user.id}` as const;
    const entryId = randomUUID();
    const lot: PantryLot = {
      id: randomUUID(),
      ingredientId: 'basil',
      label: 'Basil',
      known: true,
      quantity: null,
      unit: null,
      expiresAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const command: DinnerConsumptionCommand = {
      operationId: randomUUID(),
      entryId,
      scope,
      servings: 1,
      ingredients: [{ ingredientId: 'basil', name: 'Basil', amount: 'q.b.', optional: false, used: true }],
    };
    const entry: DinnerEntry = {
      id: entryId,
      date: now.toISOString().slice(0, 10),
      text: 'Basil',
      servings: 1,
      note: null,
      recipes: [],
      authorId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const repository = createDrizzleSyncRepository(database.db);
    await repository.applyMutation(user.id, {
      mutationId: randomUUID(),
      deviceId: 'integration-account-consumption',
      entityType: 'pantry_lot',
      entityId: lot.id,
      operation: 'upsert',
      payload: lot,
      clientUpdatedAt: now.toISOString(),
      syncScope: scope,
    });

    const first = await repository.consumeDinner(user.id, { command, entry });
    const retry = await repository.consumeDinner(user.id, { command, entry });
    const savedLot = await repository.readEntity(user.id, 'pantry_lot', lot.id);
    const changes = await repository.readChanges(user.id, 0, 100, scope);

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(first.receipt.scope).toBe(scope);
    expect(first.plan.summary.lines[0]?.status).toBe('presence_consumed');
    expect(first.plan.upsertLots).toEqual([]);
    expect(first.plan.deleteLotIds).toEqual([lot.id]);
    expect(first.pantrySnapshot.pantryLots).toEqual([]);
    expect(savedLot).toMatchObject({ deleted: true, payload: null });
    expect(changes.filter((change) => change.entityType === 'dinner_entry')).toHaveLength(1);
    expect(changes.filter((change) => change.entityType === 'pantry_lot' && change.entityId === lot.id && change.operation === 'delete'))
      .toHaveLength(1);

    await createDrizzleProfileRepository(database.db, repository).deleteAccount(user.id);
    const deletedAccountReceipt = await database.db.select().from(dinnerConsumptionReceipts)
      .where(eq(dinnerConsumptionReceipts.operationId, command.operationId));
    expect(deletedAccountReceipt).toHaveLength(0);
  });

  it('moves an account consumption receipt and processed marker with the dinner into the house', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const now = new Date();
    const [user] = await database.db.insert(users).values({
      email: `dinner-consumption-migration-${randomUUID()}@example.test`,
      emailVerifiedAt: now,
    }).returning();
    if (user === undefined) throw new Error('Integration account was not inserted');
    const scope = `account:${user.id}` as const;
    const entryId = randomUUID();
    const operationId = randomUUID();
    const lot: PantryLot = {
      id: randomUUID(),
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: 500,
      unit: 'g',
      expiresAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const command: DinnerConsumptionCommand = {
      operationId,
      entryId,
      scope,
      servings: 1,
      ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
    };
    const entry: DinnerEntry = {
      id: entryId,
      date: now.toISOString().slice(0, 10),
      text: 'Pasta',
      servings: 1,
      note: null,
      recipes: [],
      authorId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const repository = createDrizzleSyncRepository(database.db);
    await repository.applyMutation(user.id, {
      mutationId: randomUUID(), deviceId: 'integration-account-migration', entityType: 'pantry_lot',
      entityId: lot.id, operation: 'upsert', payload: lot, clientUpdatedAt: now.toISOString(), syncScope: scope,
    });
    await repository.consumeDinner(user.id, { command, entry });
    const [house] = await database.db.insert(houses).values({ name: 'Receipt migration', createdByUserId: user.id }).returning();
    if (house === undefined) throw new Error('Integration house was not inserted');
    await database.db.insert(houseMemberships).values({ houseId: house.id, userId: user.id, role: 'admin' });

    await repository.migrateUserSharedDataToHouse(user.id, house.id);
    const retryAfterScopeTransition = await repository.consumeDinner(user.id, {
      command: { ...command, scope: `house:${house.id}` },
      entry,
    });

    const [receipt] = await database.db.select().from(dinnerConsumptionReceipts)
      .where(eq(dinnerConsumptionReceipts.operationId, operationId));
    const markers = await database.db.select().from(processedSyncMutations)
      .where(eq(processedSyncMutations.mutationId, `dinner-consumption:${operationId}`));
    const houseEntry = await repository.readEntity(user.id, 'dinner_entry', entryId);
    const houseLot = await repository.readEntity(user.id, 'pantry_lot', lot.id);
    const accountLotRows = await database.db.select().from(syncItems).where(sql`
      ${syncItems.scopeType} = 'user' AND ${syncItems.scopeId} = ${user.id}
      AND ${syncItems.entityType} = 'pantry_lot' AND ${syncItems.entityId} = ${lot.id}
    `);

    expect(receipt).toMatchObject({ scopeType: 'house', scopeId: house.id, entryId });
    expect(markers.filter((marker) => marker.scopeType === 'house' && marker.scopeId === house.id)).toHaveLength(1);
    expect(markers.filter((marker) => marker.scopeType === 'user' && marker.scopeId === user.id)).toHaveLength(0);
    expect(houseEntry?.payload).toMatchObject({ id: entryId, authorId: user.id });
    expect((houseLot?.payload as PantryLot).quantity).toBe(400);
    expect(accountLotRows).toHaveLength(0);
    expect(retryAfterScopeTransition).toMatchObject({
      duplicate: true,
      receipt: { operationId, entryId, scope: `house:${house.id}` },
    });

    await createDrizzleProfileRepository(database.db, repository).deleteAccount(user.id);
    const orphanedReceipt = await database.db.select().from(dinnerConsumptionReceipts)
      .where(eq(dinnerConsumptionReceipts.operationId, operationId));
    const orphanedHouse = await database.db.select().from(houses).where(eq(houses.id, house.id));
    expect(orphanedReceipt).toHaveLength(0);
    expect(orphanedHouse).toHaveLength(0);
  });

  it('removes the receipt when the final household member leaves', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const now = new Date();
    const [user] = await database.db.insert(users).values({
      email: `dinner-consumption-leave-${randomUUID()}@example.test`,
      emailVerifiedAt: now,
    }).returning();
    if (user === undefined) throw new Error('Integration user was not inserted');
    const [house] = await database.db.insert(houses).values({ name: 'Receipt leave cleanup', createdByUserId: user.id }).returning();
    if (house === undefined) throw new Error('Integration house was not inserted');
    await database.db.insert(houseMemberships).values({ houseId: house.id, userId: user.id, role: 'admin' });

    const entryId = randomUUID();
    const operationId = randomUUID();
    const command: DinnerConsumptionCommand = {
      operationId,
      entryId,
      scope: `house:${house.id}`,
      servings: 1,
      ingredients: [],
    };
    const entry: DinnerEntry = {
      id: entryId,
      date: now.toISOString().slice(0, 10),
      text: 'Dinner without pantry ingredients',
      servings: 1,
      note: null,
      recipes: [],
      authorId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const repository = createDrizzleSyncRepository(database.db);
    await repository.consumeDinner(user.id, { command, entry });

    expect(await createDrizzleHouseRepository(database.db).leaveHouse({ userId: user.id })).toBe('left');
    const orphanedReceipt = await database.db.select().from(dinnerConsumptionReceipts)
      .where(eq(dinnerConsumptionReceipts.operationId, operationId));
    expect(orphanedReceipt).toHaveLength(0);
  });
});
