import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, inArray, sql } from 'drizzle-orm';
import type { PlanCommand, PlanState, SyncMutation, SyncMutationScope } from '@ikuck/shared/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client.js';
import { houses, users } from '../db/schema.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const canonicalJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item !== 'object' || item === null) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
};

const commandDigest = (command: PlanCommand): string => createHash('sha256')
  .update(canonicalJson(command))
  .digest('hex');

integration('meal-plan migration recovery and feed fences in PostgreSQL', () => {
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
      { id: userId, email: `plan-recovery-${label}-${userId}@example.com`, emailVerifiedAt: new Date() },
      { id: adminId, email: `plan-recovery-${label}-${adminId}@example.com`, emailVerifiedAt: new Date() },
    ]);
    await database.db.insert(houses).values({ id: houseId, name: `Plan recovery ${label}`, createdByUserId: adminId });
    await addMembership(adminId, houseId, 'admin');
    return { userId, adminId, houseId };
  };

  const addMembership = async (
    userId: string,
    houseId: string,
    role: 'admin' | 'member',
  ) => database.db.execute(sql`INSERT INTO house_memberships (
    id, house_id, user_id, role, joined_at, updated_at
  ) VALUES (
    ${randomUUID()}, ${houseId}, ${userId}, ${role}, now(), now()
  )`);

  const deleteTrackedData = async () => {
    for (const houseId of houseIds) {
      await database.db.execute(sql`DELETE FROM house_memberships WHERE house_id = ${houseId}`);
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

  const deleteCommand = (
    scope: SyncMutationScope,
    date: string,
    operationId: string,
    clientUpdatedAt: string,
  ): PlanCommand => ({
    version: 2, scope, date, operationId, deviceId: `${operationId}-device`,
    action: 'manual_delete', clientUpdatedAt,
  });

  const setCommand = (
    scope: SyncMutationScope,
    date: string,
    operationId: string,
    recipeId: string,
    clientUpdatedAt: string,
  ): PlanCommand => ({
    version: 2, scope, date, operationId, deviceId: `${operationId}-device`,
    action: 'manual_set', recipeId, clientUpdatedAt,
  });

  const addAccountMemberFeedFixture = async (label: string) => {
    const actors = await createActorsAndHouse(label);
    const repository = createDrizzleSyncRepository(database.db);
    const date = '2026-11-23';
    const accountScope: SyncMutationScope = `account:${actors.userId}`;
    const houseScope: SyncMutationScope = `house:${actors.houseId}`;
    const accountCommand = setCommand(accountScope, date, `account-plan-${label}`, `private-${label}`, '2026-01-01T00:00:00.000Z');
    const accountReceipt = await repository.applyMealPlanCommand(actors.userId, accountCommand);
    expect(accountReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: `private-${label}` } });
    const houseCommand = setCommand(houseScope, date, `house-plan-${label}`, `shared-${label}`, '2026-01-02T00:00:00.000Z');
    const houseReceipt = await repository.applyMealPlanCommand(actors.adminId, houseCommand);
    expect(houseReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: `shared-${label}` } });

    // Seed a complete membership with a stale account projection to exercise read fencing
    // independently of the migration transaction that would normally remove the source.
    await addMembership(actors.userId, actors.houseId, 'member');
    await repository.updateAiConsent(actors.userId, { enabled: false });
    const pantryMutation: SyncMutation = {
      mutationId: `house-pantry-${label}`,
      deviceId: 'house-feed-device',
      entityType: 'pantry_item',
      entityId: `tomato-${label}`,
      operation: 'upsert',
      payload: { id: `tomato-${label}`, label: 'Pomodoro casa', known: true },
      clientUpdatedAt: '2026-01-03T00:00:00.000Z',
      syncScope: houseScope,
    };
    await repository.applyMutation(actors.userId, pantryMutation);
    return { ...actors, repository, date, accountScope, houseScope, accountCommand, accountReceipt, houseCommand, houseReceipt };
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

  it('persists exact accepted regeneration provenance and stages it against a newer house tombstone', async () => {
    const { userId, adminId, houseId } = await createActorsAndHouse('valid-auto-collision');
    const repository = createDrizzleSyncRepository(database.db);
    const date = '2026-11-24';
    const accountScope: SyncMutationScope = `account:${userId}`;
    const houseScope: SyncMutationScope = `house:${houseId}`;
    const accountDelete = deleteCommand(accountScope, date, 'account-delete-before-regenerate', '2026-01-01T00:00:00.000Z');
    const deleteReceipt = await repository.applyMealPlanCommand(userId, accountDelete);
    expect(deleteReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
    const baseRevision = deleteReceipt.current?.revision;
    if (baseRevision === undefined) throw new Error('Accepted account tombstone did not return its revision');

    const exactAcceptedCommand: PlanCommand = {
      version: 2,
      scope: accountScope,
      date,
      operationId: 'account-explicit-regeneration-with-revision',
      deviceId: 'account-regeneration-device',
      action: 'explicit_regenerate',
      recipeId: 'account-auto-recipe',
      baseRevision,
      clientUpdatedAt: '2026-01-02T00:00:00.000Z',
    };
    const acceptedReceipt = await repository.applyMealPlanCommand(userId, exactAcceptedCommand);
    expect(acceptedReceipt).toMatchObject({
      outcome: 'applied', operationId: exactAcceptedCommand.operationId,
      current: { kind: 'automatic', recipeId: exactAcceptedCommand.recipeId },
    });
    const sourceState = acceptedReceipt.current;
    if (sourceState === null) throw new Error('Accepted account regeneration did not return its state');

    const houseTombstoneCommand = deleteCommand(houseScope, date, 'house-delete-prevents-auto-import', '2026-02-01T00:00:00.000Z');
    const houseTombstone = await repository.applyMealPlanCommand(adminId, houseTombstoneCommand);
    expect(houseTombstone).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
    const targetState = houseTombstone.current;
    if (targetState === null) throw new Error('Accepted house tombstone did not return its state');
    await addMembership(userId, houseId, 'member');

    const receiptRows = await database.db.execute(sql`SELECT command_json, request_hash, result_json
      FROM meal_plan_receipts
      WHERE scope_type = 'user' AND scope_id = ${userId} AND actor_id = ${userId}
        AND operation_id = ${exactAcceptedCommand.operationId}`);
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0]).toMatchObject({
      command_json: exactAcceptedCommand,
      request_hash: commandDigest(exactAcceptedCommand),
      result_json: expect.objectContaining({
        operationId: exactAcceptedCommand.operationId,
        outcome: 'applied',
        current: expect.objectContaining({ revision: sourceState.revision, kind: 'automatic', recipeId: exactAcceptedCommand.recipeId }),
      }),
    });

    await repository.migrateUserSharedDataToHouse(userId, houseId);

    await expect(repository.readMealPlanStates(userId, houseScope, [date])).resolves.toMatchObject({
      states: [{ state: { revision: targetState.revision, kind: 'deleted', recipeId: null } }],
    });
    const conflicts = await repository.readMealPlanRecovery(userId);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0] as (typeof conflicts[number] & { sourceState?: PlanState });
    expect(conflict).toMatchObject({
      planDate: date,
      sourceRevision: sourceState.revision,
      sourceProjectionMutationId: exactAcceptedCommand.operationId,
      targetRevisionAtStaging: targetState.revision,
      targetStateAtStaging: expect.objectContaining({ revision: targetState.revision, kind: 'deleted' }),
      sourceState: expect.objectContaining({ revision: sourceState.revision, kind: 'automatic', recipeId: exactAcceptedCommand.recipeId }),
      originalCommand: exactAcceptedCommand,
    });

    const sourceStates = await database.db.execute(sql`SELECT plan_date, revision, kind, recipe_id
      FROM meal_plan_states WHERE scope_type = 'user' AND scope_id = ${userId} AND plan_date = ${date}`);
    const sourceProjections = await database.db.execute(sql`SELECT id, mutation_id, payload
      FROM sync_items WHERE scope_type = 'user' AND scope_id = ${userId}
        AND entity_type = 'meal_plan_entry' AND entity_id = ${date}`);
    expect(sourceStates).toEqual([]);
    expect(sourceProjections).toEqual([]);

    const houseFeed = await repository.readChanges(userId, 0, 100, houseScope, ['meal_plan_entry']);
    expect(houseFeed.filter((change) => change.entityId === date)).toEqual([
      expect.objectContaining({ syncScope: houseScope, entityType: 'meal_plan_entry', payload: expect.objectContaining({ revision: targetState.revision, kind: 'deleted' }) }),
    ]);
    expect((await repository.readAll(userId)).filter((change) =>
      change.entityType === 'meal_plan_entry' && change.syncScope === accountScope,
    )).toEqual([]);

    const recoveryId = conflict.id;
    await repository.migrateUserSharedDataToHouse(userId, houseId);
    const retriedConflicts = await repository.readMealPlanRecovery(userId);
    expect(retriedConflicts).toHaveLength(1);
    expect(retriedConflicts[0]?.id).toBe(recoveryId);
    expect((await repository.readChanges(userId, 0, 100, houseScope, ['meal_plan_entry'])
      ).filter((change) => change.entityId === date)).toHaveLength(1);
  });

  it('quarantines a legacy automatic row without command JSON and never serves it as active Plan', async () => {
    const { userId, adminId, houseId } = await createActorsAndHouse('legacy-no-command');
    const repository = createDrizzleSyncRepository(database.db);
    const date = '2026-11-25';
    const accountScope: SyncMutationScope = `account:${userId}`;
    const houseScope: SyncMutationScope = `house:${houseId}`;
    const accountDelete = deleteCommand(accountScope, date, 'legacy-account-delete', '2026-01-01T00:00:00.000Z');
    const deleted = await repository.applyMealPlanCommand(userId, accountDelete);
    const baseRevision = deleted.current?.revision;
    if (baseRevision === undefined) throw new Error('Accepted legacy setup tombstone did not return its revision');
    const legacyCommand: PlanCommand = {
      version: 2, scope: accountScope, date, operationId: 'legacy-regeneration-no-command',
      deviceId: 'legacy-account-device', action: 'explicit_regenerate', recipeId: 'legacy-auto-recipe',
      baseRevision, clientUpdatedAt: '2026-01-02T00:00:00.000Z',
    };
    const legacyReceipt = await repository.applyMealPlanCommand(userId, legacyCommand);
    expect(legacyReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'automatic', recipeId: 'legacy-auto-recipe' } });
    const legacySourceRevision = legacyReceipt.current?.revision;
    if (legacySourceRevision === undefined) throw new Error('Accepted legacy automatic state did not return its revision');
    await database.db.execute(sql`UPDATE meal_plan_receipts SET command_json = NULL
      WHERE scope_type = 'user' AND scope_id = ${userId} AND actor_id = ${userId}
        AND operation_id = ${legacyCommand.operationId}`);

    const houseDelete = deleteCommand(houseScope, date, 'legacy-house-tombstone', '2026-02-01T00:00:00.000Z');
    const target = await repository.applyMealPlanCommand(adminId, houseDelete);
    expect(target).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
    const targetRevision = target.current?.revision;
    if (targetRevision === undefined) throw new Error('Accepted house tombstone did not return its revision');
    await addMembership(userId, houseId, 'member');

    await repository.migrateUserSharedDataToHouse(userId, houseId);

    const quarantineRows = await database.db.execute(sql`SELECT reason_code, fingerprint, raw_source_state,
      raw_source_projection, raw_target_state, raw_target_projection
      FROM meal_plan_migration_quarantines
      WHERE house_id = ${houseId} AND source_account_id = ${userId} AND plan_date = ${date}`);
    expect(quarantineRows).toHaveLength(1);
    const quarantine = quarantineRows[0] as Record<string, unknown>;
    expect(quarantine.reason_code).toEqual(expect.any(String));
    expect(String(quarantine.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(quarantine.raw_source_state)).toContain(legacySourceRevision);
    expect(JSON.stringify(quarantine.raw_source_state)).toContain('automatic');
    expect(JSON.stringify(quarantine.raw_source_state)).toContain('legacy-auto-recipe');
    expect(quarantine.raw_source_projection).not.toBeNull();
    expect(JSON.stringify(quarantine.raw_source_projection)).toContain(legacyCommand.operationId);
    expect(JSON.stringify(quarantine.raw_target_state)).toContain(targetRevision);
    expect(JSON.stringify(quarantine.raw_target_state)).toContain('deleted');
    expect(quarantine.raw_target_projection).not.toBeNull();

    const activeConflictRows = await database.db.execute(sql`SELECT id FROM meal_plan_migration_conflicts
      WHERE house_id = ${houseId} AND source_account_id = ${userId} AND plan_date = ${date}`);
    expect(activeConflictRows).toEqual([]);
    const sourceStates = await database.db.execute(sql`SELECT 1 FROM meal_plan_states
      WHERE scope_type = 'user' AND scope_id = ${userId} AND plan_date = ${date}`);
    const sourceProjections = await database.db.execute(sql`SELECT 1 FROM sync_items
      WHERE scope_type = 'user' AND scope_id = ${userId} AND entity_type = 'meal_plan_entry' AND entity_id = ${date}`);
    expect(sourceStates).toEqual([]);
    expect(sourceProjections).toEqual([]);

    const composite = await repository.readChanges(userId, 0, 100, undefined, ['meal_plan_entry']);
    expect(composite.filter((change) => change.entityId === date)).toEqual([
      expect.objectContaining({ syncScope: houseScope, payload: expect.objectContaining({ kind: 'deleted', revision: targetRevision }) }),
    ]);
    await expect(repository.readChanges(userId, 0, 100, accountScope, ['meal_plan_entry']))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });

    await repository.migrateUserSharedDataToHouse(userId, houseId);
    const retriedQuarantineRows = await database.db.execute(sql`SELECT id, fingerprint FROM meal_plan_migration_quarantines
      WHERE house_id = ${houseId} AND source_account_id = ${userId} AND plan_date = ${date}`);
    expect(retriedQuarantineRows).toHaveLength(1);
    expect(retriedQuarantineRows[0]?.fingerprint).toBe(quarantine.fingerprint);
    expect((await repository.readChanges(userId, 0, 100, undefined, ['meal_plan_entry'])
      ).filter((change) => change.entityId === date)).toHaveLength(1);
  });

  it('rejects an explicit account Plan feed for a member without blocking personal data', async () => {
    const { userId, repository, accountScope } = await addAccountMemberFeedFixture('explicit-account-scope');

    await expect(repository.readChanges(userId, 0, 100, accountScope, ['meal_plan_entry']))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });
    await expect(repository.readChanges(userId, 0, 100, accountScope, ['ai_consent']))
      .resolves.toContainEqual(expect.objectContaining({ entityType: 'ai_consent', syncScope: accountScope }));
  });

  it('keeps the member compatibility feed to account-personal and current-house changes', async () => {
    const { userId, repository, accountScope, houseScope, accountReceipt, houseReceipt, date } =
      await addAccountMemberFeedFixture('composite-compatibility');

    const changes = await repository.readChanges(userId, 0, 100, undefined, [
      'meal_plan_entry', 'ai_consent', 'pantry_item',
    ]);
    expect(changes).toContainEqual(expect.objectContaining({ entityType: 'ai_consent', syncScope: accountScope }));
    expect(changes).toContainEqual(expect.objectContaining({ entityType: 'pantry_item', syncScope: houseScope }));
    expect(changes.filter((change) => change.entityType === 'meal_plan_entry')).toEqual([
      expect.objectContaining({
        entityType: 'meal_plan_entry', syncScope: houseScope, entityId: date,
        payload: expect.objectContaining({ recipeId: houseReceipt.current?.recipeId }),
      }),
    ]);
    expect(changes).not.toContainEqual(expect.objectContaining({
      entityType: 'meal_plan_entry', syncScope: accountScope,
      payload: expect.objectContaining({ recipeId: accountReceipt.current?.recipeId }),
    }));
  });

  it('does not include stale account Plan in readAll export for a current member', async () => {
    const { userId, repository, accountScope, houseScope, houseReceipt } =
      await addAccountMemberFeedFixture('read-all-export');

    const plans = (await repository.readAll(userId)).filter((change) => change.entityType === 'meal_plan_entry');
    expect(plans).toEqual([
      expect.objectContaining({
        syncScope: houseScope,
        payload: expect.objectContaining({ recipeId: houseReceipt.current?.recipeId }),
      }),
    ]);
    expect(plans).not.toContainEqual(expect.objectContaining({ syncScope: accountScope }));
  });
});
