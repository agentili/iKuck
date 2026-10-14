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
    const distinctReceiptRows = await Promise.all(concurrentRequests.map(({ command: distinctCommand }) => (
      database.db.select().from(dinnerConsumptionReceipts)
        .where(eq(dinnerConsumptionReceipts.operationId, distinctCommand.operationId))
    )));
    const hydratedMemberChanges = await secondRepository.readAll(member.id);

    expect(initialAttempts.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(initialAttempts[0]?.receipt).toEqual(initialAttempts[1]?.receipt);
    expect(committed.pantrySnapshot.pantryLots).toEqual([{ ...lot, quantity: 300, updatedAt: committed.receipt.committedAt }]);
    expect((storedLot?.payload as PantryLot).quantity).toBe(100);
    expect(receiptRows).toHaveLength(1);
    expect(persistedEntryRows).toHaveLength(1);
    expect(changes.filter((change) => change.entityType === 'dinner_entry')).toHaveLength(3);
    expect(changes.filter((change) => change.entityType === 'cook_event')).toHaveLength(3);
    expect(distinctReceiptRows.map((rows) => rows.length)).toEqual([1, 1]);
    expect(hydratedMemberChanges.filter((change) => change.entityType === 'dinner_entry' && change.syncScope === scope)).toHaveLength(3);
    expect(hydratedMemberChanges.find((change) => change.entityType === 'pantry_lot' && change.entityId === lot.id))
      .toMatchObject({ operation: 'upsert', payload: { quantity: 100 }, syncScope: scope });

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

  it('keeps historical account dinners and pantry stock unchanged during house hydration', async () => {
    if (database === null) throw new Error('Integration database is not configured');
    const now = new Date();
    const [user] = await database.db.insert(users).values({
      email: `dinner-consumption-history-${randomUUID()}@example.test`,
      emailVerifiedAt: now,
    }).returning();
    if (user === undefined) throw new Error('Historical dinner account was not inserted');
    const accountScope = `account:${user.id}` as const;
    const lot: PantryLot = {
      id: randomUUID(), ingredientId: 'pasta', label: 'Pasta', known: true,
      quantity: 500, unit: 'g', expiresAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    const entryId = randomUUID();
    const historicalEntry: DinnerEntry = {
      id: entryId,
      date: now.toISOString().slice(0, 10),
      text: 'Historical imported pasta dinner',
      servings: 2,
      note: null,
      recipes: [],
      authorId: user.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const repository = createDrizzleSyncRepository(database.db);
    await repository.applyMutation(user.id, {
      mutationId: randomUUID(), deviceId: 'historical-dinner-fixture', entityType: 'pantry_lot',
      entityId: lot.id, operation: 'upsert', payload: lot, clientUpdatedAt: now.toISOString(), syncScope: accountScope,
    });
    await repository.applyMutation(user.id, {
      mutationId: randomUUID(), deviceId: 'historical-dinner-fixture', entityType: 'dinner_entry',
      entityId: historicalEntry.id, operation: 'upsert', payload: historicalEntry,
      clientUpdatedAt: now.toISOString(), syncScope: accountScope,
    });
    const [house] = await database.db.insert(houses).values({ name: 'Historical dinner hydration', createdByUserId: user.id }).returning();
    if (house === undefined) throw new Error('Historical dinner house was not inserted');
    await database.db.insert(houseMemberships).values({ houseId: house.id, userId: user.id, role: 'admin' });

    await repository.migrateUserSharedDataToHouse(user.id, house.id);

    const storedLot = await repository.readEntity(user.id, 'pantry_lot', lot.id);
    const storedEntry = await repository.readEntity(user.id, 'dinner_entry', entryId);
    const receipts = await database.db.select().from(dinnerConsumptionReceipts)
      .where(eq(dinnerConsumptionReceipts.entryId, entryId));
    expect((storedLot?.payload as PantryLot).quantity).toBe(500);
    expect(storedEntry?.payload).toMatchObject({ id: entryId, text: historicalEntry.text, authorId: user.id });
    expect(receipts).toHaveLength(0);
  });

  it('revokes household reads and dinner consumption after membership removal', async () => {
    if (database === null || secondDatabase === null) throw new Error('Integration database is not configured');
    const now = new Date();
    const [admin, member] = await database.db.insert(users).values([
      { email: `dinner-consumption-revoke-admin-${randomUUID()}@example.test`, emailVerifiedAt: now },
      { email: `dinner-consumption-revoke-member-${randomUUID()}@example.test`, emailVerifiedAt: now },
    ]).returning();
    if (admin === undefined || member === undefined) throw new Error('Revocation users were not inserted');
    const [house] = await database.db.insert(houses).values({ name: 'Dinner revocation', createdByUserId: admin.id }).returning();
    if (house === undefined) throw new Error('Revocation house was not inserted');
    await database.db.insert(houseMemberships).values([
      { houseId: house.id, userId: admin.id, role: 'admin' },
      { houseId: house.id, userId: member.id, role: 'member' },
    ]);

    const scope = `house:${house.id}` as const;
    const entryId = randomUUID();
    const lot: PantryLot = {
      id: randomUUID(), ingredientId: 'pasta', label: 'Pasta', known: true,
      quantity: 500, unit: 'g', expiresAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    const command: DinnerConsumptionCommand = {
      operationId: randomUUID(), entryId, scope, servings: 1,
      ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
    };
    const entry: DinnerEntry = {
      id: entryId, date: now.toISOString().slice(0, 10), text: 'Shared dinner before revocation', servings: 1,
      note: null, recipes: [], authorId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    const adminRepository = createDrizzleSyncRepository(database.db);
    const memberRepository = createDrizzleSyncRepository(secondDatabase.db);
    await adminRepository.applyMutation(admin.id, {
      mutationId: randomUUID(), deviceId: 'dinner-revocation-fixture', entityType: 'pantry_lot',
      entityId: lot.id, operation: 'upsert', payload: lot, clientUpdatedAt: now.toISOString(), syncScope: scope,
    });
    await adminRepository.consumeDinner(admin.id, { command, entry });

    const hydratedMemberChanges = await memberRepository.readAll(member.id);
    expect(hydratedMemberChanges).toContainEqual(expect.objectContaining({
      entityType: 'dinner_entry', entityId: entryId, operation: 'upsert', syncScope: scope,
      payload: expect.objectContaining({ text: entry.text }),
    }));
    expect(hydratedMemberChanges).toContainEqual(expect.objectContaining({
      entityType: 'pantry_lot', entityId: lot.id, operation: 'upsert', syncScope: scope,
      payload: expect.objectContaining({ quantity: 400 }),
    }));

    await expect(createDrizzleHouseRepository(database.db).removeMember({ adminUserId: admin.id, userId: member.id }))
      .resolves.toBe('removed');
    await expect(memberRepository.readChanges(member.id, 0, 100, scope))
      .rejects.toMatchObject({ code: 'house_membership_required', status: 403 });
    const revokedEntryId = randomUUID();
    await expect(memberRepository.consumeDinner(member.id, {
      command: { ...command, operationId: randomUUID(), entryId: revokedEntryId },
      entry: { ...entry, id: revokedEntryId, text: 'Must be rejected after revocation' },
    })).rejects.toMatchObject({ code: 'house_membership_required', status: 403 });

    const isolatedAccountChanges = await memberRepository.readAll(member.id);
    expect(isolatedAccountChanges.some((change) => change.syncScope === scope)).toBe(false);
    expect(await adminRepository.readEntity(admin.id, 'pantry_lot', lot.id))
      .toMatchObject({ payload: expect.objectContaining({ quantity: 400 }) });
    expect(await adminRepository.readEntity(admin.id, 'dinner_entry', entryId))
      .toMatchObject({ payload: expect.objectContaining({ id: entryId, text: entry.text }) });
  });

  it('rolls back dinner, pantry, receipt and feed on PostgreSQL failure and releases its pool slot', async () => {
    if (database === null || secondDatabase === null) throw new Error('Integration database is not configured');
    const now = new Date();
    const [user] = await database.db.insert(users).values({
      email: `dinner-consumption-rollback-${randomUUID()}@example.test`,
      emailVerifiedAt: now,
    }).returning();
    if (user === undefined) throw new Error('Rollback account was not inserted');
    const scope = `account:${user.id}` as const;
    const entryId = randomUUID();
    const operationId = randomUUID();
    const lot: PantryLot = {
      id: randomUUID(), ingredientId: 'pasta', label: 'Pasta', known: true,
      quantity: 500, unit: 'g', expiresAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    const command: DinnerConsumptionCommand = {
      operationId, entryId, scope, servings: 1,
      ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
    };
    const entry: DinnerEntry = {
      id: entryId, date: now.toISOString().slice(0, 10), text: 'Rollback dinner', servings: 1,
      note: null, recipes: [], authorId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    const firstRepository = createDrizzleSyncRepository(database.db);
    const singleConnectionRepository = createDrizzleSyncRepository(secondDatabase.db);
    await firstRepository.applyMutation(user.id, {
      mutationId: randomUUID(), deviceId: 'dinner-rollback-fixture', entityType: 'pantry_lot',
      entityId: lot.id, operation: 'upsert', payload: lot, clientUpdatedAt: now.toISOString(), syncScope: scope,
    });

    const suffix = randomUUID().replaceAll('-', '');
    const triggerName = `reject_dinner_entry_${suffix}`;
    const functionName = `reject_dinner_entry_fn_${suffix}`;
    try {
      await database.db.execute(sql.raw(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW.entity_type = 'dinner_entry' AND NEW.entity_id = '${entryId}' THEN
            RAISE EXCEPTION 'injected dinner consumption persistence failure';
          END IF;
          RETURN NEW;
        END;
        $body$
      `));
      await database.db.execute(sql.raw(`
        CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE ON sync_items
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()
      `));

      await expect(singleConnectionRepository.consumeDinner(user.id, { command, entry }))
        .rejects.toThrow(/Failed query: insert into "sync_items"/);
      await expect(secondDatabase.ping()).resolves.toBeUndefined();
      expect(await singleConnectionRepository.readEntity(user.id, 'pantry_lot', lot.id))
        .toMatchObject({ payload: expect.objectContaining({ quantity: 500 }) });
      expect((await singleConnectionRepository.readAll(user.id))
        .some((change) => change.entityType === 'dinner_entry' && change.entityId === entryId)).toBe(false);
      expect(await database.db.select().from(dinnerConsumptionReceipts)
        .where(eq(dinnerConsumptionReceipts.operationId, operationId))).toHaveLength(0);
      expect(await database.db.select().from(processedSyncMutations)
        .where(eq(processedSyncMutations.mutationId, `dinner-consumption:${operationId}`))).toHaveLength(0);
    } finally {
      await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON sync_items`));
      await database.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }
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
