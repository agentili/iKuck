import type { PlanCommand, SyncMutationScope } from '@ikuck/shared/contracts';
import { describe, expect, it } from 'vitest';
import { createMemorySyncRepository } from './repository.js';

const planDate = '2026-11-21';
const fixedClock = () => new Date('2026-10-29T12:00:00.000Z');
const accountScope: SyncMutationScope = 'account:user-1';
const houseScope: SyncMutationScope = 'house:house-1';

const makeManualPlanCommand = (
  scope: SyncMutationScope,
  operationId: string,
  recipeId: string,
  clientUpdatedAt: string,
  date = planDate,
): PlanCommand => ({
  version: 2,
  scope,
  date,
  operationId,
  deviceId: `${operationId}-device`,
  action: 'manual_set',
  recipeId,
  clientUpdatedAt,
});

const makeDeleteCommand = (
  scope: SyncMutationScope,
  operationId: string,
  clientUpdatedAt: string,
  date = planDate,
): PlanCommand => ({
  version: 2,
  scope,
  date,
  operationId,
  deviceId: `${operationId}-device`,
  action: 'manual_delete',
  clientUpdatedAt,
});

const createMembershipFixture = () => {
  let userIsMember = false;
  const repository = createMemorySyncRepository({
    clock: fixedClock,
    scopeResolver: async (userId) => userId === 'house-admin' || (userId === 'user-1' && userIsMember)
      ? { kind: 'house', id: 'house-1' }
      : null,
  });
  return { repository, joinHouse: () => { userIsMember = true; } };
};

describe('meal-plan migration quarantine in memory repository (uncovered REDs)', () => {
  it('quarantines a manual source without a manual tuple and fails closed on direct read', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeManualPlanCommand(accountScope, 'account-manual-no-tuple', 'personal-recipe', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    // Direct read for quarantined date should fail with plan_migration_quarantined
    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });
  });

  it('quarantines a manual source without a manual tuple and fails closed on v2 Plan sync', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeManualPlanCommand(accountScope, 'account-manual-no-tuple-sync', 'personal-recipe', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    // Sync for quarantined date should fail with plan_migration_quarantined
    await expect(repository.readChanges('user-1', 0, 100, houseScope, ['meal_plan_entry']))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });
  });

  it('quarantines a deleted source without a manual tuple and fails closed on direct read', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeDeleteCommand(accountScope, 'account-deleted-no-tuple', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });
  });

  it('quarantines a manual source whose canonical state disagrees with its sync projection', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeManualPlanCommand(accountScope, 'account-source-mismatch', 'canonical-recipe', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });
  });

  it('quarantines the account source when the house canonical state disagrees with its projection', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeManualPlanCommand(accountScope, 'account-target-mismatch-source', 'source-recipe', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    const houseCommand = makeManualPlanCommand(houseScope, 'house-target-mismatch-target', 'target-recipe', '2026-01-02T00:00:00.000Z');
    await repository.applyMealPlanCommand('house-admin', houseCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });
  });

  it('exposes quarantined evidence through read-only recovery API', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeManualPlanCommand(accountScope, 'account-quarantine-recovery', 'personal-recipe', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    // Recovery API should expose quarantined entries with raw evidence
    const recovery = await repository.readMealPlanRecovery('user-1');
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery[0]).toMatchObject({
      planDate,
      reasonCode: expect.stringMatching(/manual_tuple_missing|source_projection_inconsistent|target_projection_inconsistent/),
    });
  });

  it('keeps quarantine raw evidence durable and idempotent on retry', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeManualPlanCommand(accountScope, 'account-quarantine-idempotent', 'personal-recipe', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    // First migration should quarantine
    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });

    // Second migration should be idempotent and not change quarantine state
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');
    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });

    // Third migration should also be idempotent
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');
    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });

    // Recovery should still show the same quarantined entry
    const recovery = await repository.readMealPlanRecovery('user-1');
    expect(recovery.length).toBeGreaterThan(0);
  });

  it('account source is removed from active Plan sync after quarantine', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountCommand = makeManualPlanCommand(accountScope, 'account-quarantine-source-removed', 'personal-recipe', '2026-01-01T00:00:00.000Z');
    await repository.applyMealPlanCommand('user-1', accountCommand);

    joinHouse();
    await repository.updateAiConsent('user-1', { enabled: false });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    // Account scope feed should not contain the quarantined plan (scope fence)
    await expect(repository.readChanges('user-1', 0, 100, accountScope, ['meal_plan_entry']))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });

    // House scope feed should fail closed for the quarantined date
    await expect(repository.readChanges('user-1', 0, 100, houseScope, ['meal_plan_entry']))
      .rejects.toMatchObject({ code: 'plan_migration_quarantined' });
  });
});