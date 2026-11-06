import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanCommand, PlanResult, SyncMutationScope } from '@ikuck/shared/contracts';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createDatabase } from '../db/client.js';
import { houses, users } from '../db/schema.js';
import { createDrizzleSyncRepository } from '../sync/repository.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('meal plan v2 import in PostgreSQL', () => {
  const database = createDatabase(url!);
  const userId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  const outsiderId = randomUUID();
  const houseId = randomUUID();
  const date = '2026-11-10';
  const houseScope = `house:${houseId}` as SyncMutationScope;
  const accountScope = `account:${userId}` as SyncMutationScope;

  const manualCommand = (
    operationId: string,
    recipeId: string,
    clientUpdatedAt: string,
    scope: SyncMutationScope,
    commandDate = date,
  ): PlanCommand => ({
    version: 2,
    scope,
    date: commandDate,
    operationId,
    deviceId: 'import-integration-device',
    action: 'manual_set',
    recipeId,
    clientUpdatedAt,
  });

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'),
    });
    await database.db.insert(users).values([
      { id: userId, email: `plan-import-${userId}@example.com`, emailVerifiedAt: new Date() },
      { id: adminId, email: `plan-import-${adminId}@example.com`, emailVerifiedAt: new Date() },
      { id: memberId, email: `plan-import-${memberId}@example.com`, emailVerifiedAt: new Date() },
      { id: outsiderId, email: `plan-import-${outsiderId}@example.com`, emailVerifiedAt: new Date() },
    ]);
    await database.db.insert(houses).values({ id: houseId, name: 'Import test house', createdByUserId: adminId });
    await database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at) VALUES
      (gen_random_uuid(), ${houseId}, ${adminId}, 'admin', now(), now()),
      (gen_random_uuid(), ${houseId}, ${memberId}, 'member', now(), now())`);
  });

  afterAll(async () => {
    try {
      await database.db.execute(sql`DELETE FROM house_memberships WHERE house_id = ${houseId}`);
      await database.db.execute(sql`DELETE FROM sync_items
        WHERE user_id IN (${userId}, ${adminId}, ${memberId}, ${outsiderId})
          OR (scope_type = 'house' AND scope_id = ${houseId})`);
      await database.db.execute(sql`DELETE FROM meal_plan_receipts
        WHERE (scope_type = 'user' AND scope_id = ${userId})
          OR (scope_type = 'house' AND scope_id = ${houseId})`);
      await database.db.delete(houses).where(eq(houses.id, houseId));
      await database.db.delete(users).where(inArray(users.id, [userId, adminId, memberId, outsiderId]));
    } finally {
      await database.close();
    }
  });

  it('applies an imported command, replays the same provenance receipt and rejects changed content', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const first = await repository.importMealPlanCommand(userId, 'account', 'account-item-1', 'rev-1', manualCommand('import-op-1', 'recipe-a', '2026-01-01T00:00:00.000Z', accountScope));
    expect(first).toMatchObject({
      sourceAccountId: userId,
      source: 'account',
      sourceId: 'account-item-1',
      localRevision: 'rev-1',
      targetScope: accountScope,
      commandDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      version: 2,
      operationId: 'import-op-1',
      outcome: 'applied',
      current: { date, kind: 'manual', recipeId: 'recipe-a' },
    });

    const retried = await repository.importMealPlanCommand(userId, 'account', 'account-item-1', 'rev-1', manualCommand('import-op-1', 'recipe-a', '2026-01-01T00:00:00.000Z', accountScope));
    expect(retried).toEqual(first);

    const receiptRows = await database.db.execute(sql`SELECT actor_id, scope_type, scope_id, import_source,
      import_source_id, import_local_revision, command_hash, request_hash FROM meal_plan_receipts
      WHERE scope_type = 'user' AND scope_id = ${userId} AND operation_id = 'import-op-1'`);
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0]).toMatchObject({
      actor_id: userId,
      scope_type: 'user',
      scope_id: userId,
      import_source: 'account',
      import_source_id: 'account-item-1',
      import_local_revision: 'rev-1',
      command_hash: first.commandDigest,
      request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const states = await repository.readMealPlanStates(userId, accountScope, [date]);
    expect(states.states).toHaveLength(1);
    expect(states.states[0]!.state!.revision).toBe(first.current!.revision);

    await expect(repository.importMealPlanCommand(userId, 'account', 'account-item-1', 'rev-1', manualCommand('import-op-1', 'recipe-b', '2026-01-01T00:00:00.000Z', accountScope)))
      .rejects.toMatchObject({ code: 'operation_id_reused' });
  });

  it('rejects changed provenance or content under an existing operation and provenance key', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const provenanceDate = '2026-11-21';
    const original = manualCommand('provenance-bound-op', 'provenance-recipe', '2026-01-01T00:00:00.000Z', accountScope, provenanceDate);
    await repository.importMealPlanCommand(userId, 'account', 'provenance-source', 'provenance-revision', original);

    await expect(repository.importMealPlanCommand(
      userId, 'guest', 'provenance-source', 'provenance-revision', original,
    )).rejects.toMatchObject({ code: 'operation_id_reused' });
    await expect(repository.importMealPlanCommand(
      userId, 'account', 'provenance-source', 'changed-revision', original,
    )).rejects.toMatchObject({ code: 'operation_id_reused' });
    await expect(repository.importMealPlanCommand(
      userId, 'account', 'provenance-source', 'provenance-revision',
      manualCommand('provenance-bound-op', 'changed-content', '2026-01-01T00:00:00.000Z', accountScope, provenanceDate),
    )).rejects.toMatchObject({ code: 'operation_id_reused' });
    await expect(repository.importMealPlanCommand(
      userId, 'account', 'provenance-source', 'provenance-revision',
      manualCommand('different-operation', 'changed-content', '2026-01-02T00:00:00.000Z', accountScope, provenanceDate),
    )).rejects.toMatchObject({ code: 'operation_id_reused' });
  });

  it('isolates account provenance receipts and canonical data between accounts', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const isolatedDate = '2026-11-22';
    const first = await repository.importMealPlanCommand(
      userId, 'account', 'same-source-id', 'same-revision',
      manualCommand('same-operation-id', 'account-a-recipe', '2026-01-01T00:00:00.000Z', accountScope, isolatedDate),
    );
    const otherAccountScope = `account:${outsiderId}` as SyncMutationScope;
    const second = await repository.importMealPlanCommand(
      outsiderId, 'account', 'same-source-id', 'same-revision',
      manualCommand('same-operation-id', 'account-b-recipe', '2026-01-01T00:00:00.000Z', otherAccountScope, isolatedDate),
    );

    expect(first).toMatchObject({ sourceAccountId: userId, targetScope: accountScope, outcome: 'applied' });
    expect(second).toMatchObject({ sourceAccountId: outsiderId, targetScope: otherAccountScope, outcome: 'applied' });
    expect((await repository.readMealPlanStates(userId, accountScope, [isolatedDate])).states[0]?.state)
      .toMatchObject({ recipeId: 'account-a-recipe' });
    expect((await repository.readMealPlanStates(outsiderId, otherAccountScope, [isolatedDate])).states[0]?.state)
      .toMatchObject({ recipeId: 'account-b-recipe' });
  });

  it('does not replay an account receipt as a house receipt after scope transition', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const transitionDate = '2026-11-23';
    const commandFor = (scope: SyncMutationScope) => manualCommand(
      'scope-transition-op', 'scope-transition-recipe', '2026-01-01T00:00:00.000Z', scope, transitionDate,
    );
    const accountReceipt = await repository.importMealPlanCommand(
      userId, 'account', 'transition-source', 'transition-revision', commandFor(accountScope),
    );
    expect(accountReceipt.targetScope).toBe(accountScope);

    await database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at)
      VALUES (gen_random_uuid(), ${houseId}, ${userId}, 'member', now(), now())`);
    try {
      const houseReceipt = await repository.importMealPlanCommand(
        userId, 'account', 'transition-source', 'transition-revision', commandFor(houseScope),
      );
      expect(houseReceipt).toMatchObject({
        sourceAccountId: userId,
        sourceId: 'transition-source',
        localRevision: 'transition-revision',
        targetScope: houseScope,
        operationId: 'scope-transition-op',
        outcome: 'applied',
      });
      expect((await repository.readMealPlanStates(userId, houseScope, [transitionDate])).states[0]?.state)
        .toMatchObject({ recipeId: 'scope-transition-recipe' });
    } finally {
      await database.db.execute(sql`DELETE FROM house_memberships WHERE user_id = ${userId} AND house_id = ${houseId}`);
    }
  });

  it('isolates provenance receipts for different accounts in the same house scope', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const sharedDate = '2026-11-25';
    const firstCommand = manualCommand('same-house-operation', 'house-recipe-a', '2026-01-01T00:00:00.000Z', houseScope, sharedDate);
    const secondCommand = manualCommand('same-house-operation', 'house-recipe-b', '2026-01-02T00:00:00.000Z', houseScope, sharedDate);

    const first = await repository.importMealPlanCommand(adminId, 'account', 'local-source-id', 'local-revision', firstCommand);
    const second = await repository.importMealPlanCommand(memberId, 'account', 'local-source-id', 'local-revision', secondCommand);
    const firstReplay = await repository.importMealPlanCommand(adminId, 'account', 'local-source-id', 'local-revision', firstCommand);

    expect(first).toMatchObject({ sourceAccountId: adminId, targetScope: houseScope, outcome: 'applied', current: { recipeId: 'house-recipe-a' } });
    expect(second).toMatchObject({ sourceAccountId: memberId, targetScope: houseScope, outcome: 'applied', current: { recipeId: 'house-recipe-b' } });
    expect(firstReplay).toEqual(first);
    expect((await repository.readMealPlanStates(adminId, houseScope, [sharedDate])).states[0]?.state)
      .toMatchObject({ recipeId: 'house-recipe-b' });
    const receipts = await database.db.execute(sql`SELECT actor_id FROM meal_plan_receipts
      WHERE scope_type = 'house' AND scope_id = ${houseId} AND import_source = 'account'
        AND import_source_id = 'local-source-id' AND import_local_revision = 'local-revision'
        AND operation_id = 'same-house-operation'`);
    expect(receipts.map((row) => (row as { actor_id: string }).actor_id).sort()).toEqual([adminId, memberId].sort());
  });

  it('preserves automatic command semantics and source metadata through PostgreSQL import', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const commandDate = '2026-11-24';
    const automaticCommand: PlanCommand = {
      version: 2,
      scope: accountScope,
      date: commandDate,
      operationId: 'postgres-auto-import-op',
      deviceId: 'postgres-auto-import-device',
      clientUpdatedAt: '2026-01-03T04:05:06.000Z',
      action: 'auto_create',
      recipeId: 'automatic-import-recipe',
      baseRevision: null,
    };

    const receipt = await repository.importMealPlanCommand(
      userId, 'account', 'automatic-source', 'automatic-revision', automaticCommand,
    );
    const changes = await repository.readChanges(userId, 0, 100, accountScope, ['meal_plan_entry']);

    expect(receipt).toMatchObject({ outcome: 'applied', current: { kind: 'automatic', recipeId: 'automatic-import-recipe' } });
    expect(changes.find((change) => change.entityId === commandDate)).toMatchObject({
      deviceId: automaticCommand.deviceId,
      mutationId: automaticCommand.operationId,
      clientUpdatedAt: automaticCommand.clientUpdatedAt,
      payload: { kind: 'automatic', recipeId: 'automatic-import-recipe' },
    });
  });

  it('keeps receipt, canonical read and sync projection sequence aligned after an update', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const sequenceDate = '2026-11-15';
    const initialCommand = manualCommand('sequence-initial', 'sequence-recipe-a', '2026-01-01T00:00:00.000Z', accountScope, sequenceDate);
    const initial = await repository.importMealPlanCommand(userId, 'guest', 'sequence-item-a', 'sequence-rev-a', initialCommand);
    expect(initial.outcome).toBe('applied');
    const initialRead = await repository.readMealPlanStates(userId, accountScope, [sequenceDate]);
    expect(initialRead.states[0]!.state).toEqual(initial.current);

    const updateCommand = manualCommand('sequence-update', 'sequence-recipe-b', '2026-01-02T00:00:00.000Z', accountScope, sequenceDate);
    const updated = await repository.importMealPlanCommand(userId, 'guest', 'sequence-item-b', 'sequence-rev-b', updateCommand);
    expect(updated.outcome).toBe('applied');
    expect(updated.current!.revision).not.toBe(initial.current!.revision);

    const updatedRead = await repository.readMealPlanStates(userId, accountScope, [sequenceDate]);
    expect(updatedRead.states[0]!.state).toEqual(updated.current);
    const changes = await repository.readChanges(userId, 0, 100, accountScope, ['meal_plan_entry']);
    const projected = changes.find((change) => change.entityId === sequenceDate);
    expect(projected).toBeDefined();
    expect(projected!.serverSequence).toBe(updated.current!.serverSequence);
    expect(projected!.payload).toMatchObject({ revision: updated.current!.revision, serverSequence: updated.current!.serverSequence });

    const retried = await repository.importMealPlanCommand(userId, 'guest', 'sequence-item-b', 'sequence-rev-b', updateCommand);
    expect(retried).toEqual(updated);
    expect((await repository.readMealPlanStates(userId, accountScope, [sequenceDate])).states[0]!.state).toEqual(retried.current);
  });

  it('keeps the account-to-house projection sequence aligned when migration replaces an existing house choice', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const migrationDate = '2026-11-17';
    const houseChoice = await repository.applyMealPlanCommand(adminId, manualCommand(
      'migration-house-choice', 'house-choice', '2026-01-01T00:00:00.000Z', houseScope, migrationDate,
    ));
    expect(houseChoice.outcome).toBe('applied');
    const accountChoice = await repository.applyMealPlanCommand(userId, manualCommand(
      'migration-account-choice', 'account-choice', '2026-01-02T00:00:00.000Z', accountScope, migrationDate,
    ));
    expect(accountChoice.outcome).toBe('applied');

    await database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at)
      VALUES (gen_random_uuid(), ${houseId}, ${userId}, 'member', now(), now())`);
    try {
      await repository.migrateUserSharedDataToHouse(userId, houseId);

      const migrated = await repository.readMealPlanStates(userId, houseScope, [migrationDate]);
      const state = migrated.states[0]!.state;
      expect(state).toMatchObject({ kind: 'manual', recipeId: 'account-choice' });
      const changes = await repository.readChanges(userId, 0, 100, houseScope, ['meal_plan_entry']);
      const projected = changes.find((change) => change.entityId === migrationDate);
      expect(projected).toBeDefined();
      expect(projected!.serverSequence).toBe(state!.serverSequence);
      expect(projected!.payload).toMatchObject({ revision: state!.revision, serverSequence: state!.serverSequence });

      await expect(repository.readMealPlanStates(userId, accountScope, [migrationDate]))
        .rejects.toMatchObject({ code: 'sync_scope_invalid' });
      const personalStateRows = await database.db.execute(sql`SELECT count(*)::int AS count FROM meal_plan_states
        WHERE scope_type = 'user' AND scope_id = ${userId} AND plan_date = ${migrationDate}`);
      expect((personalStateRows[0] as { count: number }).count).toBe(0);
      const personalProjectionRows = await database.db.execute(sql`SELECT count(*)::int AS count FROM sync_items
        WHERE scope_type = 'user' AND scope_id = ${userId} AND entity_type = 'meal_plan_entry' AND entity_id = ${migrationDate}`);
      expect((personalProjectionRows[0] as { count: number }).count).toBe(0);
    } finally {
      await database.db.execute(sql`DELETE FROM house_memberships WHERE user_id = ${userId} AND house_id = ${houseId}`);
    }
  });

  it('keeps a newer house manual choice out of the account feed when an older account choice loses migration', async () => {
    const repository = createDrizzleSyncRepository(database.db, {
      clock: () => new Date('2026-10-29T12:00:00.000Z'),
      mealPlanV2Enabled: true,
    });
    const losingDate = '2026-11-27';
    const houseChoice = await repository.applyMealPlanCommand(adminId, manualCommand(
      'losing-migration-house-choice', 'house-winning-recipe', '2026-01-02T00:00:00.000Z', houseScope, losingDate,
    ));
    const losingAccountCommand = manualCommand(
      'losing-migration-account-choice', 'account-losing-recipe', '2026-01-01T00:00:00.000Z', accountScope, losingDate,
    );
    const accountChoice = await repository.applyMealPlanCommand(userId, losingAccountCommand);
    expect(houseChoice.outcome).toBe('applied');
    expect(accountChoice.outcome).toBe('applied');

    await database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at)
      VALUES (gen_random_uuid(), ${houseId}, ${userId}, 'member', now(), now())`);
    try {
      await repository.migrateUserSharedDataToHouse(userId, houseId);

      const houseState = await repository.readMealPlanStates(userId, houseScope, [losingDate]);
      expect(houseState.states[0]?.state).toMatchObject({ kind: 'manual', recipeId: 'house-winning-recipe' });
      const houseFeed = await repository.readChanges(userId, 0, 100, houseScope, ['meal_plan_entry']);
      expect.soft(houseFeed.filter((change) => change.entityId === losingDate)).toEqual([
        expect.objectContaining({
          entityType: 'meal_plan_entry', entityId: losingDate, syncScope: houseScope,
          payload: expect.objectContaining({ kind: 'manual', recipeId: 'house-winning-recipe' }),
        }),
      ]);
      await expect(repository.readChanges(userId, 0, 100, accountScope, ['meal_plan_entry']))
        .rejects.toMatchObject({ code: 'sync_scope_invalid' });
      const sourceRows = await database.db.execute(sql`SELECT state.plan_date, projection.id AS projection_id
        FROM meal_plan_states AS state
        JOIN sync_items AS projection ON projection.scope_type = 'user' AND projection.scope_id = ${userId}
          AND projection.entity_type = 'meal_plan_entry' AND projection.entity_id = state.plan_date::text
        WHERE state.scope_type = 'user' AND state.scope_id = ${userId} AND state.plan_date = ${losingDate}`);
      expect(sourceRows).toEqual([]);
      const staged = await database.db.execute(sql`SELECT id, source_account_id, plan_date, source_revision,
        source_projection_mutation_id, source_device_id, source_client_updated_at, target_revision,
        original_command, status FROM meal_plan_migration_conflicts
        WHERE house_id = ${houseId} AND source_account_id = ${userId} AND plan_date = ${losingDate}`);
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        source_account_id: userId,
        plan_date: losingDate,
        source_revision: expect.any(String),
        source_projection_mutation_id: 'losing-migration-account-choice',
        source_device_id: 'import-integration-device',
        target_revision: houseState.states[0]!.state!.revision,
        original_command: losingAccountCommand,
        status: 'pending',
      });
      await repository.migrateUserSharedDataToHouse(userId, houseId);
      const stagedAfterRetry = await database.db.execute(sql`SELECT id FROM meal_plan_migration_conflicts
        WHERE house_id = ${houseId} AND source_account_id = ${userId} AND plan_date = ${losingDate}`);
      expect(stagedAfterRetry).toHaveLength(1);

      const origin = 'http://127.0.0.1:5173';
      const authService = {
        authenticate: async () => ({
          id: `session-${userId}`, userId, email: `plan-import-${userId}@example.com`,
          emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'), csrfTokenHash: hashOpaqueToken('csrf-token'),
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
      } as unknown as AuthService;
      const app = createApp({
        database: { ping: async () => undefined },
        cache: { ping: async () => undefined },
        sync: { repository, authService, appOrigin: origin },
      });
      try {
        const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };
        const pending = await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
        expect(pending.statusCode).toBe(200);
        const conflict = pending.json().conflicts[0] as {
          id: string; sourceRevision: string; targetRevisionAtStaging: string;
        };
        const resolutionCommand = manualCommand(
          'losing-migration-resolution', 'account-losing-recipe', '2026-01-03T00:00:00.000Z', houseScope, losingDate,
        );
        const resolutionBody = {
          expectedSourceRevision: conflict.sourceRevision,
          expectedTargetRevision: conflict.targetRevisionAtStaging,
          command: resolutionCommand,
        };
        const resolved = await app.inject({
          method: 'POST', url: `/v1/meal-plan/recovery/${conflict.id}/resolve`, headers, payload: resolutionBody,
        });
        expect(resolved.statusCode).toBe(200);
        expect(resolved.json()).toMatchObject({ outcome: 'applied', current: { recipeId: 'account-losing-recipe' } });
        const replay = await app.inject({
          method: 'POST', url: `/v1/meal-plan/recovery/${conflict.id}/resolve`, headers, payload: resolutionBody,
        });
        expect(replay.json()).toEqual(resolved.json());
        const pendingAfterResolution = (await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers })).json().conflicts as Array<{ id: string }>;
        expect(pendingAfterResolution.map((item) => item.id)).not.toContain(conflict.id);
      } finally {
        await app.close();
      }
    } finally {
      await database.db.execute(sql`DELETE FROM house_memberships WHERE user_id = ${userId} AND house_id = ${houseId}`);
    }
  });

  it('rolls back PostgreSQL conflict staging when guarded account-source removal fails', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const rollbackDate = '2026-11-29';
    const houseChoice = await repository.applyMealPlanCommand(adminId, manualCommand(
      'rollback-staged-house-choice', 'rollback-staged-winner', '2026-01-02T00:00:00.000Z', houseScope, rollbackDate,
    ));
    const accountChoice = await repository.applyMealPlanCommand(userId, manualCommand(
      'rollback-staged-account-choice', 'rollback-staged-loser', '2026-01-01T00:00:00.000Z', accountScope, rollbackDate,
    ));
    expect(houseChoice.outcome).toBe('applied');
    expect(accountChoice.outcome).toBe('applied');
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `t06_plan_rollback_${suffix.slice(0, 12)}`;
    const triggerName = `${functionName}_trg`;
    await database.db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.scope_type = 'user' AND OLD.scope_id = '${userId}' AND OLD.plan_date = '${rollbackDate}' THEN
          RAISE EXCEPTION 'forced account meal-plan source removal failure';
        END IF;
        RETURN OLD;
      END
    $$`));
    await database.db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON meal_plan_states
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`));
    await database.db.execute(sql`INSERT INTO house_memberships (id, house_id, user_id, role, joined_at, updated_at)
      VALUES (gen_random_uuid(), ${houseId}, ${userId}, 'member', now(), now())`);
    try {
      await expect(repository.migrateUserSharedDataToHouse(userId, houseId)).rejects.toThrow();
      const accountState = await database.db.execute(sql`SELECT revision, kind, recipe_id FROM meal_plan_states
        WHERE scope_type = 'user' AND scope_id = ${userId} AND plan_date = ${rollbackDate}`);
      expect(accountState).toHaveLength(1);
      expect(accountState[0]).toMatchObject({ kind: 'manual', recipe_id: 'rollback-staged-loser' });
      const staged = await database.db.execute(sql`SELECT count(*)::int AS count FROM meal_plan_migration_conflicts
        WHERE house_id = ${houseId} AND source_account_id = ${userId} AND plan_date = ${rollbackDate}`);
      expect((staged[0] as { count: number }).count).toBe(0);
      const houseState = await repository.readMealPlanStates(userId, houseScope, [rollbackDate]);
      expect(houseState.states[0]?.state).toMatchObject({ kind: 'manual', recipeId: 'rollback-staged-winner' });
    } finally {
      await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON meal_plan_states`));
      await database.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
      await database.db.execute(sql`DELETE FROM house_memberships WHERE user_id = ${userId} AND house_id = ${houseId}`);
    }
  });

  it('rolls back canonical state and receipt when the projection write fails', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const rollbackDate = '2026-11-18';
    const initialCommand = manualCommand('rollback-initial', 'rollback-original', '2026-01-01T00:00:00.000Z', accountScope, rollbackDate);
    const initial = await repository.importMealPlanCommand(userId, 'guest', 'rollback-source', 'rollback-rev-1', initialCommand);
    expect(initial.outcome).toBe('applied');

    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `meal_plan_rollback_${suffix}`;
    const triggerName = `${functionName}_trigger`;
    await database.db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entity_type = 'meal_plan_entry' AND NEW.entity_id = '${rollbackDate}' THEN
          RAISE EXCEPTION 'forced meal-plan projection failure';
        END IF;
        RETURN NEW;
      END
    $$`));
    await database.db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON sync_items
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`));

    try {
      const failedCommand = manualCommand('rollback-update', 'rollback-must-not-commit', '2026-01-02T00:00:00.000Z', accountScope, rollbackDate);
      await expect(repository.importMealPlanCommand(userId, 'guest', 'rollback-source', 'rollback-rev-2', failedCommand))
        .rejects.toMatchObject({
          query: expect.stringContaining('update "sync_items"'),
          cause: expect.objectContaining({ message: expect.stringContaining('forced meal-plan projection failure') }),
        });

      const afterFailure = await repository.readMealPlanStates(userId, accountScope, [rollbackDate]);
      expect(afterFailure.states[0]!.state).toEqual(initial.current);
      const failedReceipt = await database.db.execute(sql`SELECT count(*)::int AS count FROM meal_plan_receipts
        WHERE scope_type = 'user' AND scope_id = ${userId} AND operation_id = 'rollback-update'`);
      expect((failedReceipt[0] as { count: number }).count).toBe(0);
      const failedProvenance = await database.db.execute(sql`SELECT count(*)::int AS count FROM meal_plan_receipts
        WHERE scope_type = 'user' AND scope_id = ${userId} AND actor_id = ${userId}
          AND import_source = 'guest' AND import_source_id = 'rollback-source'
          AND import_local_revision = 'rollback-rev-2'`);
      expect((failedProvenance[0] as { count: number }).count).toBe(0);
      const projected = (await repository.readChanges(userId, 0, 100, accountScope, ['meal_plan_entry']))
        .find((change) => change.entityId === rollbackDate);
      expect(projected).toBeDefined();
      expect(projected!.payload).toMatchObject({ revision: initial.current!.revision, recipeId: 'rollback-original' });
    } finally {
      await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON sync_items`));
      await database.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }
  });

  it('keeps the current state and the guest source on import conflict', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const conflictDate = '2026-11-11';
    const prior = await repository.applyMealPlanCommand(userId, manualCommand('prior-op', 'prior-recipe', '2026-01-02T00:00:00.000Z', accountScope, conflictDate));
    expect(prior.outcome).toBe('applied');

    const result = await repository.importMealPlanCommand(userId, 'guest', 'guest-item-2', 'rev-2', manualCommand('import-stale', 'imported-recipe', '2026-01-01T00:00:00.000Z', accountScope, conflictDate));
    expect(result).toMatchObject({ version: 2, operationId: 'import-stale', outcome: 'conflict', current: { recipeId: 'prior-recipe' } });

    const states = await repository.readMealPlanStates(userId, accountScope, [conflictDate]);
    expect(states.states[0]!.state).toMatchObject({ recipeId: 'prior-recipe' });
  });

  it('applies a batch with mixed applied and conflicted outcomes through separate item transactions', async () => {
    const repository = createDrizzleSyncRepository(database.db);
    const batchDate = '2026-11-12';
    const applied = await repository.importMealPlanCommand(userId, 'guest', 'batch-item-1', 'rev-3', manualCommand('batch-applied', 'batch-recipe-a', '2026-01-05T00:00:00.000Z', accountScope, batchDate));
    expect(applied.outcome).toBe('applied');

    const conflicted = await repository.importMealPlanCommand(userId, 'guest', 'batch-item-2', 'rev-4', manualCommand('batch-conflicted', 'batch-recipe-b', '2026-01-01T00:00:00.000Z', accountScope, batchDate));
    expect(conflicted.outcome).toBe('conflict');
    expect(conflicted.current).toEqual(applied.current);

    const states = await repository.readMealPlanStates(userId, accountScope, [batchDate]);
    expect(states.states[0]!.state).toMatchObject({ recipeId: 'batch-recipe-a' });
  });

  it('imports into the house scope for a member and rejects scopes the session does not hold', async () => {
    const repository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (actualUserId) => actualUserId === memberId ? { kind: 'house', id: houseId } : null,
    });

    const applied = await repository.importMealPlanCommand(memberId, 'guest', 'house-item-1', 'rev-5', manualCommand('house-op-1', 'house-recipe', '2026-01-01T00:00:00.000Z', houseScope));
    expect(applied.outcome).toBe('applied');

    const readHouse = await repository.readMealPlanStates(memberId, houseScope, [date]);
    expect(readHouse.states[0]!.state).toMatchObject({ kind: 'manual', recipeId: 'house-recipe' });

    await expect(repository.importMealPlanCommand(memberId, 'guest', 'house-item-2', 'rev-6', manualCommand('house-account-op', 'anything', '2026-01-01T00:00:00.000Z', accountScope)))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });

    const outsiderRepository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async () => null,
    });
    await expect(outsiderRepository.importMealPlanCommand(outsiderId, 'guest', 'outsider-item', 'rev-7', manualCommand('outsider-op', 'anything', '2026-01-01T00:00:00.000Z', houseScope)))
      .rejects.toMatchObject({ code: 'house_membership_required' });
  });

  it('rejects house-scoped imports after membership revocation', async () => {
    const repository = createDrizzleSyncRepository(database.db, {
      scopeResolver: async (actualUserId) => actualUserId === memberId ? { kind: 'house', id: houseId } : null,
    });

    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const revokeReady = new Promise<void>((resolve) => { ready = resolve; });
    const revoke = database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM houses WHERE id = ${houseId} FOR UPDATE`);
      await tx.execute(sql`DELETE FROM house_memberships WHERE user_id = ${memberId} AND house_id = ${houseId}`);
      ready();
      await gate;
    });
    await revokeReady;

    const revokeDate = '2026-11-16';
    const pending = repository.importMealPlanCommand(memberId, 'guest', 'revoked-item', 'rev-8', manualCommand('revoked-op', 'anything', '2026-01-01T00:00:00.000Z', houseScope, revokeDate));
    let waitingForHouseLock = false;
    const lockDeadline = Date.now() + 5_000;
    while (!waitingForHouseLock && Date.now() < lockDeadline) {
      const activity = await database.db.execute(sql`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%houses%'
          AND query ILIKE '%FOR UPDATE%'
      ) AS waiting`);
      waitingForHouseLock = (activity[0] as { waiting?: unknown } | undefined)?.waiting === true;
      if (!waitingForHouseLock) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waitingForHouseLock).toBe(true);
    release();
    await revoke;
    await expect(pending).rejects.toMatchObject({ code: 'house_membership_required' });

    const stillApplied = await repository.readMealPlanStates(adminId, houseScope, [revokeDate]);
    expect(stillApplied.states).toEqual([{ date: revokeDate, state: null }]);
  });

  it('keeps server sequence order aligned with commit order across independent scopes', async () => {
    const independentDatabase = createDatabase(url!, { max: 2 });
    const repositoryA = createDrizzleSyncRepository(database.db);
    const repositoryB = createDrizzleSyncRepository(independentDatabase.db);
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `meal_plan_commit_order_${suffix}`;
    const triggerName = `zz_meal_plan_commit_order_${suffix}`;
    const gateKey = 'ikuck:test:meal-plan-commit-order-writer-gate';
    let releaseGate: () => void = () => undefined;
    let blocker: Promise<void> | undefined;
    let firstPromise: Promise<PlanResult> | undefined;
    let secondPromise: Promise<PlanResult> | undefined;
    let gateAcquired!: () => void;
    const gateReady = new Promise<void>((resolve) => { gateAcquired = resolve; });

    const waitForBlockedWriter = async (queryText: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const rows = await database.db.execute(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${queryText}%`}
        ) AS waiting`);
        if ((rows[0] as { waiting?: unknown } | undefined)?.waiting === true) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No writer blocked on expected PostgreSQL lock: ${queryText}`);
    };

    try {
      await database.db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.entity_type = 'meal_plan_entry' AND NEW.device_id = 'commit-order-first' THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}', 0));
          END IF;
          RETURN NEW;
        END
      $$`));
      await database.db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE ON sync_items
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`));

      let releaseBlocker!: () => void;
      const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      releaseGate = releaseBlocker;
      blocker = database.db.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${gateKey}, 0))`);
        gateAcquired();
        await blockerGate;
      });
      await gateReady;

      const firstDate = '2026-11-19';
      const secondDate = '2026-11-20';
      const firstCommand = {
        ...manualCommand('commit-order-first-op', 'commit-order-first-recipe', '2026-01-01T00:00:00.000Z', accountScope, firstDate),
        deviceId: 'commit-order-first',
      };
      const secondScope = `account:${outsiderId}` as SyncMutationScope;
      const secondCommand = manualCommand('commit-order-second-op', 'commit-order-second-recipe', '2026-01-01T00:00:00.000Z', secondScope, secondDate);
      firstPromise = repositoryA.applyMealPlanCommand(userId, firstCommand);
      await waitForBlockedWriter('insert into "sync_items"');
      secondPromise = repositoryB.applyMealPlanCommand(outsiderId, secondCommand);
      await waitForBlockedWriter('ikuck:sync-server-sequence-commit-order');

      releaseGate();
      await blocker;
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.outcome).toBe('applied');
      expect(second.outcome).toBe('applied');
      expect(first.current!.serverSequence).toBeLessThan(second.current!.serverSequence);
      await expect(repositoryA.readMealPlanStates(userId, accountScope, [firstDate]))
        .resolves.toMatchObject({ states: [{ state: first.current }] });
      await expect(repositoryB.readMealPlanStates(outsiderId, secondScope, [secondDate]))
        .resolves.toMatchObject({ states: [{ state: second.current }] });
    } finally {
      releaseGate();
      if (blocker !== undefined) await blocker.catch(() => undefined);
      await Promise.allSettled([firstPromise, secondPromise].filter((promise): promise is Promise<PlanResult> => promise !== undefined));
      await database.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON sync_items`));
      await database.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
      await independentDatabase.close();
    }
  }, 15_000);

  it('deduplicates retries and rejects concurrent id reuse across independent PostgreSQL pools', async () => {
    const independentDatabase = createDatabase(url!, { max: 2 });
    try {
      const repositoryA = createDrizzleSyncRepository(database.db);
      const repositoryB = createDrizzleSyncRepository(independentDatabase.db);
      const concurrencyDate = '2026-11-13';
      const shared = manualCommand('shared-concurrent-op', 'recipe-a', '2026-01-01T00:00:00.000Z', accountScope, concurrencyDate);

      const [first, replayed] = await Promise.all([
        repositoryA.importMealPlanCommand(userId, 'guest', 'conc-item', 'rev-9', shared),
        repositoryB.importMealPlanCommand(userId, 'guest', 'conc-item', 'rev-9', shared),
      ]);
      expect(first).toEqual(replayed);
      expect(first.outcome).toBe('applied');

      const states = await repositoryA.readMealPlanStates(userId, accountScope, [concurrencyDate]);
      expect(states.states).toHaveLength(1);
      expect(states.states[0]!.state!.revision).toBe(first.current!.revision);

      const conflictingA = manualCommand('shared-conflicting-op', 'recipe-b', '2026-01-01T00:00:00.000Z', accountScope, concurrencyDate);
      const conflictingB = manualCommand('shared-conflicting-op', 'recipe-c', '2026-01-01T00:00:00.000Z', accountScope, concurrencyDate);
      const outcomes = await Promise.allSettled([
        repositoryA.importMealPlanCommand(userId, 'guest', 'conc-item-2', 'rev-10', conflictingA),
        repositoryB.importMealPlanCommand(userId, 'guest', 'conc-item-2', 'rev-10', conflictingB),
      ]);
      const settled = outcomes.map((outcome) => outcome.status === 'fulfilled' ? outcome.value.outcome : String((outcome as PromiseRejectedResult).reason?.code));
      expect(settled.sort()).toEqual(['applied', 'operation_id_reused']);
    } finally {
      await independentDatabase.close();
    }
  });
});
