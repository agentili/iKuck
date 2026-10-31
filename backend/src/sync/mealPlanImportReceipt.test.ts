import { describe, expect, it } from 'vitest';
import { createMemorySyncRepository } from './repository.js';
import type { PlanCommand, SyncMutationScope } from '@ikuck/shared/contracts';

const command = (scope: SyncMutationScope, operationId = 'import-operation', recipeId = 'imported-recipe'): PlanCommand => ({
  version: 2,
  scope,
  date: '2026-11-07',
  operationId,
  deviceId: 'account-device',
  clientUpdatedAt: '2026-01-01T00:00:00.000Z',
  action: 'manual_set',
  recipeId,
});

describe('meal plan import receipt provenance in memory', () => {
  it('returns the same durable provenance receipt on an identical retry', async () => {
    const repository = createMemorySyncRepository();
    const userId = 'import-receipt-user';
    const planCommand = command(`account:${userId}`);

    const first = await repository.importMealPlanCommand(userId, 'account', 'source-row-1', 'revision-1', planCommand);
    const replay = await repository.importMealPlanCommand(userId, 'account', 'source-row-1', 'revision-1', planCommand);

    expect(first).toMatchObject({
      sourceAccountId: userId,
      source: 'account',
      sourceId: 'source-row-1',
      localRevision: 'revision-1',
      targetScope: `account:${userId}`,
      commandDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      version: 2,
      operationId: 'import-operation',
      outcome: 'applied',
    });
    expect(replay).toEqual(first);
  });

  it('rejects reuse of a source revision with changed command content and operation id', async () => {
    const repository = createMemorySyncRepository();
    const userId = 'import-content-user';
    const scope = `account:${userId}` as const;

    await repository.importMealPlanCommand(userId, 'account', 'source-row-2', 'revision-2', command(scope));

    await expect(repository.importMealPlanCommand(
      userId,
      'account',
      'source-row-2',
      'revision-2',
      command(scope, 'new-operation', 'changed-recipe'),
    )).rejects.toMatchObject({ code: 'operation_id_reused' });
  });

  it('keeps same provenance keys isolated by authenticated account and house scope', async () => {
    const houseByUser = new Map([
      ['house-import-user-a', 'house-a'],
      ['house-import-user-b', 'house-b'],
    ]);
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => {
        const houseId = houseByUser.get(userId);
        return houseId === undefined ? null : { kind: 'house', id: houseId };
      },
    });
    const userA = 'house-import-user-a';
    const userB = 'house-import-user-b';

    const receiptA = await repository.importMealPlanCommand(
      userA, 'account', 'source-row-shared', 'revision-shared',
      command('house:house-a', 'shared-operation', 'recipe-a'),
    );
    const receiptB = await repository.importMealPlanCommand(
      userB, 'account', 'source-row-shared', 'revision-shared',
      command('house:house-b', 'shared-operation', 'recipe-b'),
    );

    expect(receiptA).toMatchObject({ sourceAccountId: userA, targetScope: 'house:house-a' });
    expect(receiptB).toMatchObject({ sourceAccountId: userB, targetScope: 'house:house-b' });
    expect((await repository.readMealPlanStates(userA, 'house:house-a', ['2026-11-07'])).states[0]?.state)
      .toMatchObject({ recipeId: 'recipe-a' });
    expect((await repository.readMealPlanStates(userB, 'house:house-b', ['2026-11-07'])).states[0]?.state)
      .toMatchObject({ recipeId: 'recipe-b' });
  });

  it('binds same-house provenance receipts to each authenticated source account', async () => {
    const houseByUser = new Map([
      ['shared-house-user-a', 'shared-house'],
      ['shared-house-user-b', 'shared-house'],
    ]);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const repository = createMemorySyncRepository({
      clock: () => new Date(now += 1_000),
      scopeResolver: async (userId) => {
        const houseId = houseByUser.get(userId);
        return houseId === undefined ? null : { kind: 'house', id: houseId };
      },
    });
    const userA = 'shared-house-user-a';
    const userB = 'shared-house-user-b';

    const receiptA = await repository.importMealPlanCommand(
      userA, 'account', 'same-account-local-id', 'same-account-revision',
      command('house:shared-house', 'same-operation', 'recipe-from-a'),
    );
    const receiptB = await repository.importMealPlanCommand(
      userB, 'account', 'same-account-local-id', 'same-account-revision',
      command('house:shared-house', 'same-operation', 'recipe-from-b'),
    );
    const replayA = await repository.importMealPlanCommand(
      userA, 'account', 'same-account-local-id', 'same-account-revision',
      command('house:shared-house', 'same-operation', 'recipe-from-a'),
    );

    expect(receiptA).toMatchObject({ sourceAccountId: userA, outcome: 'applied', current: { recipeId: 'recipe-from-a' } });
    expect(receiptB).toMatchObject({ sourceAccountId: userB, outcome: 'applied', current: { recipeId: 'recipe-from-b' } });
    expect(replayA).toEqual(receiptA);
    expect((await repository.readMealPlanStates(userA, 'house:shared-house', ['2026-11-07'])).states[0]?.state)
      .toMatchObject({ recipeId: 'recipe-from-b' });
  });

  it('preserves automatic action identity and causal metadata through import', async () => {
    const repository = createMemorySyncRepository();
    const userId = 'import-action-user';
    const scope = `account:${userId}` as const;
    const automaticCommand: PlanCommand = {
      version: 2,
      scope,
      date: '2026-11-08',
      operationId: 'original-auto-operation',
      deviceId: 'original-auto-device',
      clientUpdatedAt: '2026-01-03T04:05:06.000Z',
      action: 'auto_create',
      recipeId: 'automatic-recipe',
      baseRevision: null,
    };

    const receipt = await repository.importMealPlanCommand(
      userId, 'account', 'automatic-source', 'automatic-revision', automaticCommand,
    );
    const changes = await repository.readChanges(userId, 0, 20, scope, ['meal_plan_entry']);

    expect(receipt).toMatchObject({ outcome: 'applied', current: { kind: 'automatic', recipeId: 'automatic-recipe' } });
    expect(changes).toContainEqual(expect.objectContaining({
      entityType: 'meal_plan_entry',
      entityId: automaticCommand.date,
      deviceId: automaticCommand.deviceId,
      mutationId: automaticCommand.operationId,
      clientUpdatedAt: automaticCommand.clientUpdatedAt,
      payload: expect.objectContaining({ kind: 'automatic', recipeId: 'automatic-recipe' }),
    }));
  });
});
