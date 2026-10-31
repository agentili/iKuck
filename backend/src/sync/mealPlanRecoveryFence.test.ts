import type { PlanCommand, SyncMutation, SyncMutationScope } from '@ikuck/shared/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from './repository.js';

const planDate = '2026-11-21';
const fixedClock = () => new Date('2026-10-29T12:00:00.000Z');
const accountScope: SyncMutationScope = 'account:user-1';
const houseScope: SyncMutationScope = 'house:house-1';

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

const createStalePlanMembership = async () => {
  const fixture = createMembershipFixture();
  const accountCommand = makeManualPlanCommand(accountScope, 'account-plan-choice', 'personal-recipe', '2026-01-01T00:00:00.000Z');
  const accountReceipt = await fixture.repository.applyMealPlanCommand('user-1', accountCommand);
  expect(accountReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'personal-recipe' } });

  const houseCommand = makeManualPlanCommand(houseScope, 'house-plan-choice', 'shared-recipe', '2026-01-02T00:00:00.000Z');
  const houseReceipt = await fixture.repository.applyMealPlanCommand('house-admin', houseCommand);
  expect(houseReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'shared-recipe' } });

  fixture.joinHouse();
  await fixture.repository.updateAiConsent('user-1', { enabled: false });
  const pantryItem: SyncMutation = {
    mutationId: 'house-tomato',
    deviceId: 'house-device',
    entityType: 'pantry_item',
    entityId: 'tomato',
    operation: 'upsert',
    payload: { id: 'tomato', label: 'Pomodoro casa', known: true },
    clientUpdatedAt: '2026-01-03T00:00:00.000Z',
    syncScope: houseScope,
  };
  await fixture.repository.applyMutation('user-1', pantryItem);
  return { ...fixture, accountCommand, accountReceipt, houseCommand, houseReceipt };
};

const sessionService = {
  authenticate: async () => ({
    id: 'session-user-1',
    userId: 'user-1',
    email: 'user-1@example.com',
    emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  }),
} as unknown as AuthService;

const syncHeaders = {
  cookie: 'ikuck_session=session-token',
  origin: 'http://127.0.0.1:5173',
  'x-csrf-token': 'csrf-token',
};

const createSyncApp = (repository: ReturnType<typeof createMemorySyncRepository>) => createApp({
  database: { ping: async () => undefined },
  cache: { ping: async () => undefined },
  auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
  sync: { repository, authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
});

describe('meal-plan migration and account-feed fencing', () => {
  it('stages a valid regenerated account automatic plan against a newer house tombstone and removes it idempotently', async () => {
    const { repository, joinHouse } = createMembershipFixture();
    const accountTombstoneCommand = makeDeleteCommand(accountScope, 'account-manual-delete', '2026-01-01T00:00:00.000Z');
    const accountTombstoneReceipt = await repository.applyMealPlanCommand('user-1', accountTombstoneCommand);
    expect(accountTombstoneReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
    const accountTombstoneRevision = accountTombstoneReceipt.current?.revision;
    if (accountTombstoneRevision === undefined) throw new Error('Accepted account tombstone did not return its revision');

    const exactAcceptedCommand: PlanCommand = {
      version: 2,
      scope: accountScope,
      date: planDate,
      operationId: 'account-explicit-regenerate',
      deviceId: 'account-regeneration-device',
      action: 'explicit_regenerate',
      recipeId: 'account-automatic-recipe',
      baseRevision: accountTombstoneRevision,
      clientUpdatedAt: '2026-01-02T00:00:00.000Z',
    };
    const acceptedReceipt = await repository.applyMealPlanCommand('user-1', exactAcceptedCommand);
    expect(acceptedReceipt).toMatchObject({
      outcome: 'applied',
      operationId: exactAcceptedCommand.operationId,
      current: { kind: 'automatic', recipeId: exactAcceptedCommand.recipeId },
    });
    const acceptedRevision = acceptedReceipt.current?.revision;
    if (acceptedRevision === undefined) throw new Error('Accepted regeneration did not return its revision');

    const houseTombstoneCommand = makeDeleteCommand(houseScope, 'house-manual-delete', '2026-02-01T00:00:00.000Z');
    const houseTombstoneReceipt = await repository.applyMealPlanCommand('house-admin', houseTombstoneCommand);
    expect(houseTombstoneReceipt).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
    const houseTombstoneBeforeMigration = await repository.readMealPlanStates('house-admin', houseScope, [planDate]);
    joinHouse();

    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    await expect(repository.readMealPlanStates('user-1', houseScope, [planDate]))
      .resolves.toEqual(houseTombstoneBeforeMigration);
    const recovery = await repository.readMealPlanRecovery('user-1');
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({
      planDate,
      sourceRevision: acceptedRevision,
      sourceProjectionMutationId: exactAcceptedCommand.operationId,
      sourceDeviceId: exactAcceptedCommand.deviceId,
      targetRevisionAtStaging: houseTombstoneReceipt.current?.revision,
      targetStateAtStaging: houseTombstoneBeforeMigration.states[0]?.state,
      sourceState: { date: planDate, revision: acceptedRevision, kind: 'automatic', recipeId: exactAcceptedCommand.recipeId },
      originalCommand: exactAcceptedCommand,
    });

    const activeAccountPlans = (await repository.readAll('user-1')).filter((change) =>
      change.entityType === 'meal_plan_entry' && change.syncScope === accountScope,
    );
    expect(activeAccountPlans).toEqual([]);

    const recoveryId = recovery[0]?.id;
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');
    const retriedRecovery = await repository.readMealPlanRecovery('user-1');
    expect(retriedRecovery).toHaveLength(1);
    expect(retriedRecovery[0]?.id).toBe(recoveryId);
    expect((await repository.readAll('user-1')).filter((change) =>
      change.entityType === 'meal_plan_entry' && change.syncScope === accountScope,
    )).toEqual([]);
  });

  it('rejects an explicit account Plan feed for a current member while preserving personal account sync', async () => {
    const { repository, accountCommand } = await createStalePlanMembership();

    await expect(repository.readChanges('user-1', 0, 100, accountScope, ['meal_plan_entry']))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });
    await expect(repository.readChanges('user-1', 0, 100, accountScope, ['ai_consent']))
      .resolves.toContainEqual(expect.objectContaining({ entityType: 'ai_consent', syncScope: accountScope }));
    expect(accountCommand.scope).toBe(accountScope);
  });

  it('keeps the unscoped member feed composite and excludes stale account Plan from readAll export', async () => {
    const { repository, accountReceipt, houseReceipt } = await createStalePlanMembership();
    const composite = await repository.readChanges('user-1', 0, 100, undefined, [
      'meal_plan_entry', 'ai_consent', 'pantry_item',
    ]);

    expect(composite).toContainEqual(expect.objectContaining({ entityType: 'ai_consent', syncScope: accountScope }));
    expect(composite).toContainEqual(expect.objectContaining({ entityType: 'pantry_item', syncScope: houseScope }));
    expect(composite.filter((change) => change.entityType === 'meal_plan_entry')).toEqual([
      expect.objectContaining({
        entityType: 'meal_plan_entry',
        syncScope: houseScope,
        payload: expect.objectContaining({ recipeId: houseReceipt.current?.recipeId }),
      }),
    ]);
    expect(composite).not.toContainEqual(expect.objectContaining({
      entityType: 'meal_plan_entry',
      syncScope: accountScope,
      payload: expect.objectContaining({ recipeId: accountReceipt.current?.recipeId }),
    }));

    const exportRows = await repository.readAll('user-1');
    expect(exportRows.filter((change) => change.entityType === 'meal_plan_entry')).toEqual([
      expect.objectContaining({ syncScope: houseScope, payload: expect.objectContaining({ recipeId: houseReceipt.current?.recipeId }) }),
    ]);
  });

  it('keeps the legacy-composite, account-personal, and current-house cursors independent across reads', async () => {
    const { repository } = await createStalePlanMembership();
    const legacyCursor = 0;
    const accountCursor = 0;
    const houseCursor = 0;

    const legacyRead = await repository.readChanges('user-1', legacyCursor, 100, undefined, [
      'meal_plan_entry', 'ai_consent', 'pantry_item',
    ]);
    const accountRead = await repository.readChanges('user-1', accountCursor, 100, accountScope, ['ai_consent']);
    const houseRead = await repository.readChanges('user-1', houseCursor, 100, houseScope, ['meal_plan_entry', 'pantry_item']);

    expect(legacyRead.some((change) => change.syncScope === accountScope && change.entityType === 'meal_plan_entry')).toBe(false);
    expect(accountRead.every((change) => change.syncScope === accountScope && change.entityType === 'ai_consent')).toBe(true);
    expect(houseRead.every((change) => change.syncScope === houseScope && change.entityType !== 'ai_consent')).toBe(true);

    const accountCursorAfterRead = Math.max(accountCursor, ...accountRead.map((change) => change.serverSequence));
    const houseCursorAfterRead = Math.max(houseCursor, ...houseRead.map((change) => change.serverSequence));
    const legacyCursorAfterRead = Math.max(legacyCursor, ...legacyRead.map((change) => change.serverSequence));
    await repository.updateAiConsent('user-1', { enabled: false });

    const accountDelta = await repository.readChanges('user-1', accountCursorAfterRead, 100, accountScope, ['ai_consent']);
    const houseDelta = await repository.readChanges('user-1', houseCursorAfterRead, 100, houseScope, ['meal_plan_entry', 'pantry_item']);
    const legacyDelta = await repository.readChanges('user-1', legacyCursorAfterRead, 100, undefined, [
      'meal_plan_entry', 'ai_consent', 'pantry_item',
    ]);

    expect(accountDelta).toHaveLength(1);
    expect(accountDelta[0]).toMatchObject({ entityType: 'ai_consent', syncScope: accountScope });
    expect(houseDelta).toEqual([]);
    expect(legacyDelta).toEqual([expect.objectContaining({ entityType: 'ai_consent', syncScope: accountScope })]);
  });

  it('returns sync_scope_invalid from the sync route when a member requests Plan in account scope', async () => {
    const { repository } = await createStalePlanMembership();
    const app = createSyncApp(repository);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sync',
        headers: syncHeaders,
        payload: {
          deviceId: 'account-device',
          cursor: 0,
          syncScope: accountScope,
          mutations: [],
          supportedEntityTypes: ['meal_plan_entry'],
          mealPlanReadVersion: 2,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'sync_scope_invalid' });
    } finally {
      await app.close();
    }
  });

  it('serves an unscoped v2 composite through the route without duplicating stale account Plan', async () => {
    const { repository, accountReceipt, houseReceipt } = await createStalePlanMembership();
    const app = createSyncApp(repository);
    try {
      const legacyCursor = 0;
      const accountCursor = 0;
      const houseCursor = 0;
      const compositeResponse = await app.inject({
        method: 'POST',
        url: '/v1/sync',
        headers: syncHeaders,
        payload: {
          deviceId: 'legacy-device', cursor: legacyCursor, mutations: [], mealPlanReadVersion: 2,
          supportedEntityTypes: ['meal_plan_entry', 'ai_consent', 'pantry_item'],
        },
      });
      expect(compositeResponse.statusCode).toBe(200);
      const composite = compositeResponse.json<{ changes: SyncMutation[]; nextCursor: number }>();
      expect(composite.changes.filter((change) => change.entityType === 'meal_plan_entry')).toEqual([
        expect.objectContaining({
          entityType: 'meal_plan_entry',
          syncScope: houseScope,
          payload: expect.objectContaining({ recipeId: houseReceipt.current?.recipeId }),
        }),
      ]);
      expect(composite.changes).not.toContainEqual(expect.objectContaining({
        entityType: 'meal_plan_entry', syncScope: accountScope,
        payload: expect.objectContaining({ recipeId: accountReceipt.current?.recipeId }),
      }));

      const accountResponse = await app.inject({
        method: 'POST', url: '/v1/sync', headers: syncHeaders,
        payload: { deviceId: 'account-device', cursor: accountCursor, syncScope: accountScope, mutations: [], supportedEntityTypes: ['ai_consent'] },
      });
      const houseResponse = await app.inject({
        method: 'POST', url: '/v1/sync', headers: syncHeaders,
        payload: {
          deviceId: 'house-device', cursor: houseCursor, syncScope: houseScope, mutations: [],
          supportedEntityTypes: ['meal_plan_entry', 'pantry_item'], mealPlanReadVersion: 2,
        },
      });
      expect(accountResponse.statusCode).toBe(200);
      expect(accountResponse.json().changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: 'ai_consent', syncScope: accountScope }),
      ]));
      expect(houseResponse.statusCode).toBe(200);
      expect(houseResponse.json().changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: 'meal_plan_entry', syncScope: houseScope }),
        expect.objectContaining({ entityType: 'pantry_item', syncScope: houseScope }),
      ]));

      const legacyCursorAfterRead = composite.nextCursor;
      const accountCursorAfterRead = accountResponse.json<{ nextCursor: number }>().nextCursor;
      const houseCursorAfterRead = houseResponse.json<{ nextCursor: number }>().nextCursor;
      await repository.updateAiConsent('user-1', { enabled: false });
      const accountDelta = await app.inject({
        method: 'POST', url: '/v1/sync', headers: syncHeaders,
        payload: { deviceId: 'account-device', cursor: accountCursorAfterRead, syncScope: accountScope, mutations: [], supportedEntityTypes: ['ai_consent'] },
      });
      const houseDelta = await app.inject({
        method: 'POST', url: '/v1/sync', headers: syncHeaders,
        payload: {
          deviceId: 'house-device', cursor: houseCursorAfterRead, syncScope: houseScope, mutations: [],
          supportedEntityTypes: ['meal_plan_entry', 'pantry_item'], mealPlanReadVersion: 2,
        },
      });
      const legacyDelta = await app.inject({
        method: 'POST', url: '/v1/sync', headers: syncHeaders,
        payload: {
          deviceId: 'legacy-device', cursor: legacyCursorAfterRead, mutations: [], mealPlanReadVersion: 2,
          supportedEntityTypes: ['meal_plan_entry', 'ai_consent', 'pantry_item'],
        },
      });
      expect(accountDelta.json().changes).toHaveLength(1);
      expect(houseDelta.json().changes).toEqual([]);
      expect(legacyDelta.json().changes).toEqual([expect.objectContaining({ entityType: 'ai_consent', syncScope: accountScope })]);
    } finally {
      await app.close();
    }
  });
});
