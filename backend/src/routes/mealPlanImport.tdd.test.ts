import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { PlanCommand } from '@ikuck/shared/contracts';
import type { AuthService } from '../auth/service.js';
import type { SyncRepository, SyncScope } from '../sync/repository.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };
const memberHeaders = { cookie: 'ikuck_session=member-session', origin, 'x-csrf-token': 'csrf-token' };
const userId = 'plan-import-user';
const memberId = 'plan-import-member';
const houseId = 'plan-import-house';
const date = '2026-11-05';

const authFor = (actualUserId: string, verified = true): AuthService => ({
  authenticate: async () => ({
    id: `session-${actualUserId}`, userId: actualUserId, email: `${actualUserId}@example.com`,
    emailVerifiedAt: verified ? new Date('2026-09-24T00:00:00.000Z') : null,
    csrfTokenHash: hashOpaqueToken('csrf-token'), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  }),
}) as unknown as AuthService;

const manualCommand = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  scope: `account:${userId}`,
  date,
  operationId: 'import-op-1',
  deviceId: 'device-guest',
  clientUpdatedAt: '2026-01-01T00:00:00.000Z',
  action: 'manual_set',
  recipeId: 'chosen-recipe',
  ...overrides,
});

const importBody = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  scope: `account:${userId}`,
  items: [
    {
      source: 'guest',
      sourceId: 'guest-item-1',
      localRevision: 'guest-revision-1',
      command: manualCommand(),
    },
  ],
  ...overrides,
});

const makeApp = (repository: SyncRepository, authService: AuthService = authFor(userId)) => {
  const app = createApp({
    database: { ping: async () => undefined }, cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin: origin, secureCookies: false },
    sync: { repository, authService, appOrigin: origin },
  });
  return { app, repository };
};

const disabledCapabilityRepository = {
  isMealPlanV2Enabled: async () => false,
  importMealPlanCommand: async () => { throw new Error('import must not be called when capability is disabled'); },
} as unknown as SyncRepository;

describe('meal plan v2 import boundary', () => {
  it('requires a verified session, same origin and CSRF', async () => {
    const unverified = makeApp(createMemorySyncRepository(), authFor(userId, false));
    const verified = makeApp(createMemorySyncRepository());
    try {
      const anonymous = await makeApp(createMemorySyncRepository()).app.inject({
        method: 'POST', url: '/v1/meal-plan/import', payload: importBody(),
      });
      expect(anonymous.statusCode).toBe(403);
      expect(anonymous.json()).toMatchObject({ code: 'csrf_failed' });

      const unverifiedWrite = await unverified.app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody(),
      });
      expect(unverifiedWrite.statusCode).toBe(403);
      expect(unverifiedWrite.json()).toMatchObject({ code: 'email_not_verified' });

      const wrongOrigin = await verified.app.inject({
        method: 'POST', url: '/v1/meal-plan/import',
        headers: { ...headers, origin: 'https://attacker.example' },
        payload: importBody(),
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.json()).toMatchObject({ code: 'csrf_failed' });

      const missingCsrf = await verified.app.inject({
        method: 'POST', url: '/v1/meal-plan/import',
        headers: { cookie: headers.cookie, origin },
        payload: importBody(),
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json()).toMatchObject({ code: 'csrf_failed' });
    } finally {
      await unverified.app.close();
      await verified.app.close();
    }
  });

  it('returns 404 until the meal-plan v2 capability is enabled', async () => {
    const { app } = makeApp(disabledCapabilityRepository);
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody() });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'capability_unavailable' });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid import bodies before any item is applied', async () => {
    const { app, repository } = makeApp(createMemorySyncRepository());
    try {
      const badVersion = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: { ...importBody(), version: 1 },
      });
      expect(badVersion.statusCode).toBe(400);
      expect(badVersion.json()).toMatchObject({ code: 'INVALID_PLAN_COMMAND' });

      const emptyItems = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: { ...importBody(), items: [] },
      });
      expect(emptyItems.statusCode).toBe(400);
      expect(emptyItems.json()).toMatchObject({ code: 'INVALID_PLAN_COMMAND' });

      const invalidCommand = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: {
          ...importBody(),
          items: [{ ...importBody().items![0], command: { ...manualCommand(), version: 1 } }],
        },
      });
      expect(invalidCommand.statusCode).toBe(400);
      expect(invalidCommand.json()).toMatchObject({ code: 'INVALID_PLAN_COMMAND' });

      const scopeMismatch = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: {
          ...importBody(),
          items: [{ ...importBody().items![0], command: { ...manualCommand(), scope: `account:other-user` } }],
        },
      });
      expect(scopeMismatch.statusCode).toBe(400);
      expect(scopeMismatch.json()).toMatchObject({ code: 'INVALID_PLAN_COMMAND' });

      await expect(repository.readAll(userId)).resolves.toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('applies a guest import item and echoes provenance in the result', async () => {
    const { app } = makeApp(createMemorySyncRepository());
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody(),
      });
      expect(response.statusCode).toBe(200);
      const firstResult = response.json().results[0];
      expect(Object.keys(firstResult).sort()).toEqual(['localRevision', 'result', 'sourceId']);
      expect(Object.keys(firstResult.result).sort()).toEqual(['current', 'operationId', 'outcome', 'version']);
      expect(response.json()).toMatchObject({
        version: 2,
        results: [{
          sourceId: 'guest-item-1',
          localRevision: 'guest-revision-1',
          result: {
            version: 2,
            operationId: 'import-op-1',
            outcome: 'applied',
            current: { date, kind: 'manual', recipeId: 'chosen-recipe' },
          },
        }],
      });

      const read = await app.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `account:${userId}`, dates: [date] },
      });
      expect(read.json()).toEqual({
        version: 2,
        states: [{ date, state: { date, kind: 'manual', recipeId: 'chosen-recipe', revision: expect.any(String), serverSequence: expect.any(Number) } }],
      });
    } finally {
      await app.close();
    }
  });

  it('returns the original receipt when the same import is retried after a lost response', async () => {
    const { app } = makeApp(createMemorySyncRepository());
    try {
      const first = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody(),
      });
      expect(first.statusCode).toBe(200);

      const retry = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody(),
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());

      const read = await app.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `account:${userId}`, dates: [date] },
      });
      expect(read.json().states).toHaveLength(1);
      expect(read.json().states[0]?.state).toMatchObject({ kind: 'manual', recipeId: 'chosen-recipe' });
    } finally {
      await app.close();
    }
  });

  it('does not acknowledge provenance that differs from the durable receipt', async () => {
    const repository = createMemorySyncRepository();
    const commitImport = repository.importMealPlanCommand.bind(repository);
    repository.importMealPlanCommand = async (actualUserId, source, sourceId, localRevision, command) => ({
      ...await commitImport(actualUserId, source, sourceId, localRevision, command),
      sourceId: 'forged-source-id',
    });
    const { app } = makeApp(repository);
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody(),
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: 'internal_error' });
    } finally {
      await app.close();
    }
  });

  it('rejects a reused operation id with different content and keeps earlier batch items applied', async () => {
    const { app } = makeApp(createMemorySyncRepository());
    try {
      const first = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: importBody({ items: [{ ...importBody().items![0], command: manualCommand({ operationId: 'shared-op' }) }] }),
      });
      expect(first.statusCode).toBe(200);

      const reused = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: importBody({ items: [{ ...importBody().items![0], command: manualCommand({ operationId: 'shared-op', recipeId: 'different-recipe' }) }] }),
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toMatchObject({ code: 'operation_id_reused' });

      const read = await app.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `account:${userId}`, dates: [date] },
      });
      expect(read.json().states[0]?.state).toMatchObject({ recipeId: 'chosen-recipe' });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['source', { source: 'account' }],
    ['revision', { localRevision: 'guest-revision-2' }],
  ])('rejects a retry with changed import %s provenance', async (_field, provenance) => {
    const { app } = makeApp(createMemorySyncRepository());
    const originalItem = importBody().items![0]!;
    try {
      const first = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody(),
      });
      expect(first.statusCode).toBe(200);

      const changed = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: importBody({ items: [{ ...originalItem, ...provenance }] }),
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: 'operation_id_reused' });
    } finally {
      await app.close();
    }
  });

  it('rejects changed content under the same source revision even with a new operation id', async () => {
    const { app } = makeApp(createMemorySyncRepository());
    const originalItem = importBody().items![0]!;
    try {
      const first = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers, payload: importBody(),
      });
      expect(first.statusCode).toBe(200);

      const changed = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: importBody({ items: [{
          ...originalItem,
          command: manualCommand({ operationId: 'different-operation', recipeId: 'changed-recipe' }),
        }] }),
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: 'operation_id_reused' });
    } finally {
      await app.close();
    }
  });

  it('keeps the current state visible as a per-item conflict and preserves the guest source', async () => {
    const { app } = makeApp(createMemorySyncRepository());
    try {
      const existing = await app.inject({
        method: 'POST', url: '/v1/meal-plan/commands', headers,
        payload: manualCommand({ operationId: 'prior-op', recipeId: 'prior-recipe', clientUpdatedAt: '2026-01-02T00:00:00.000Z' }),
      });
      expect(existing.statusCode).toBe(200);

      const response = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: importBody({ items: [{ ...importBody().items![0], command: manualCommand({ operationId: 'conflict-op', clientUpdatedAt: '2026-01-01T00:00:00.000Z' }) }] }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        version: 2,
        results: [{
          sourceId: 'guest-item-1',
          localRevision: 'guest-revision-1',
          result: { version: 2, operationId: 'conflict-op', outcome: 'conflict' },
        }],
      });
      expect(response.json().results[0]!.result.current).toMatchObject({ recipeId: 'prior-recipe' });

      const read = await app.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `account:${userId}`, dates: [date] },
      });
      expect(read.json().states[0]?.state).toMatchObject({ recipeId: 'prior-recipe' });
    } finally {
      await app.close();
    }
  });

  it('returns mixed applied and conflicted results in one batch', async () => {
    const { app } = makeApp(createMemorySyncRepository());
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers,
        payload: {
          ...importBody(),
          items: [
            { ...importBody().items![0], command: manualCommand({ operationId: 'batch-first', date: '2026-11-06' }) },
            { ...importBody().items![0], sourceId: 'guest-item-2', command: manualCommand({ operationId: 'batch-conflict', date: '2026-11-06', clientUpdatedAt: '2025-12-31T00:00:00.000Z' }) },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      const results = response.json().results;
      expect(results).toHaveLength(2);
      expect(results[0]!.sourceId).toBe('guest-item-1');
      expect(results[0]!.result.outcome).toBe('applied');
      expect(results[1]!.sourceId).toBe('guest-item-2');
      expect(results[1]!.result.outcome).toBe('conflict');
    } finally {
      await app.close();
    }
  });

  it('imports into a house scope for a member and rejects scopes the session does not hold', async () => {
    const scopeResolver = async (actualUserId: string): Promise<SyncScope | null> => actualUserId === memberId
      ? { kind: 'house', id: houseId } : null;
    const repository = createMemorySyncRepository({ scopeResolver });
    const memberApp = makeApp(repository, authFor(memberId));
    const outsiderApp = makeApp(createMemorySyncRepository({ scopeResolver }), authFor(userId));
    try {
      const applied = await memberApp.app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers: memberHeaders,
        payload: {
          ...importBody(),
          scope: `house:${houseId}`,
          items: [{ ...importBody().items![0], command: { ...manualCommand(), scope: `house:${houseId}` } }],
        },
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json().results[0]!.result.outcome).toBe('applied');

      const readHouse = await memberApp.app.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers: memberHeaders,
        payload: { version: 2, scope: `house:${houseId}`, dates: [date] },
      });
      expect(readHouse.json().states[0]?.state).toMatchObject({ kind: 'manual', recipeId: 'chosen-recipe' });

      const accountScope = await memberApp.app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers: memberHeaders,
        payload: importBody(),
      });
      expect(accountScope.statusCode).toBe(409);
      expect(accountScope.json()).toMatchObject({ code: 'sync_scope_invalid' });

      const outsiderResponse = await outsiderApp.app.inject({
        method: 'POST', url: '/v1/meal-plan/import', headers: memberHeaders,
        payload: {
          ...importBody(),
          scope: `house:${houseId}`,
          items: [{ ...importBody().items![0], command: { ...manualCommand(), scope: `house:${houseId}` } }],
        },
      });
      expect(outsiderResponse.statusCode).toBe(403);
      expect(outsiderResponse.json()).toMatchObject({ code: 'house_membership_required' });
    } finally {
      await memberApp.app.close();
      await outsiderApp.app.close();
    }
  });

  it('rolls back staged recovery and keeps account sources when a later plan migration write fails', async () => {
    let joined = false;
    let migrationClockCalls = 0;
    let failAfterStaging = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async (actualUserId) => actualUserId === 'plan-import-admin' || (actualUserId === userId && joined)
        ? { kind: 'house', id: houseId }
        : null,
      clock: () => {
        if (failAfterStaging && ++migrationClockCalls === 3) throw new Error('injected failure after conflict staging');
        return new Date('2026-10-29T12:00:00.000Z');
      },
    });
    const losingDate = '2026-12-01';
    const laterDate = '2026-12-02';
    await repository.applyMealPlanCommand('plan-import-admin', {
      version: 2, scope: `house:${houseId}`, date: losingDate, operationId: 'rollback-house-winner',
      deviceId: 'house-device', clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_set', recipeId: 'winner-recipe',
    });
    await repository.applyMealPlanCommand(userId, {
      version: 2, scope: `account:${userId}`, date: losingDate, operationId: 'rollback-account-loser',
      deviceId: 'account-device', clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'manual_set', recipeId: 'loser-recipe',
    });
    await repository.applyMealPlanCommand(userId, {
      version: 2, scope: `account:${userId}`, date: laterDate, operationId: 'rollback-account-winner',
      deviceId: 'account-device', clientUpdatedAt: '2026-01-03T00:00:00.000Z', action: 'manual_set', recipeId: 'later-recipe',
    });
    migrationClockCalls = 0;
    joined = true;
    failAfterStaging = true;

    await expect(repository.migrateUserSharedDataToHouse(userId, houseId))
      .rejects.toThrow('injected failure after conflict staging');
    const accountPlans = (await repository.readAll(userId)).filter((change) => change.entityType === 'meal_plan_entry'
      && change.syncScope === `account:${userId}`);
    expect(accountPlans).toEqual([]);
    await expect(repository.readChanges(userId, 0, 100, `account:${userId}`, ['meal_plan_entry']))
      .rejects.toMatchObject({ code: 'sync_scope_invalid' });
    const { app } = makeApp(repository);
    try {
      const recovery = await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
      expect(recovery.statusCode).toBe(200);
      expect(recovery.json().conflicts).toEqual([]);

      failAfterStaging = false;
      await repository.migrateUserSharedDataToHouse(userId, houseId);
      const recovered = await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().conflicts).toEqual([]);
      expect(recovered.json().quarantined).toHaveLength(2);
      expect(recovered.json().quarantined[0]).toMatchObject({ planDate: losingDate, reasonCode: 'target_projection_inconsistent' });
      expect(recovered.json().quarantined[1]).toMatchObject({ planDate: laterDate, reasonCode: 'source_projection_inconsistent' });
      await expect(repository.readMealPlanStates(userId, `house:${houseId}`, [laterDate])).rejects.toMatchObject({ code: 'plan_migration_quarantined' });
    } finally {
      await app.close();
    }
  });

  it('exposes an account manual choice lost during house migration with full provenance', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async (actualUserId) => actualUserId === 'plan-import-admin' || (actualUserId === userId && joined)
        ? { kind: 'house', id: houseId }
        : null,
      clock: () => new Date('2026-10-29T12:00:00.000Z'),
    });
    const losingDate = '2026-11-30';
    const houseCommand: PlanCommand = {
      version: 2, scope: `house:${houseId}`, date: losingDate, operationId: 'recovery-house-winner',
      deviceId: 'house-device', clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_set', recipeId: 'winner-recipe',
    };
    const accountCommand: PlanCommand = {
      version: 2, scope: `account:${userId}`, date: losingDate, operationId: 'recovery-account-loser',
      deviceId: 'account-device', clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'manual_set', recipeId: 'loser-recipe',
    };
    await repository.applyMealPlanCommand('plan-import-admin', houseCommand);
    await repository.applyMealPlanCommand(userId, accountCommand);
    joined = true;
    await repository.migrateUserSharedDataToHouse(userId, houseId);
    await repository.migrateUserSharedDataToHouse(userId, houseId);
    const { app } = makeApp(repository);
    const outsiderApp = makeApp(repository, authFor('recovery-outsider'));
    const unverifiedApp = makeApp(repository, authFor(userId, false));
    try {
        const wrongOriginRead = await app.inject({
          method: 'GET', url: '/v1/meal-plan/recovery', headers: { ...headers, origin: 'https://attacker.example' },
        });
        expect(wrongOriginRead.statusCode).toBe(403);
        expect(wrongOriginRead.json()).toMatchObject({ code: 'csrf_failed' });
        const missingCsrfRead = await app.inject({
          method: 'GET', url: '/v1/meal-plan/recovery', headers: { cookie: headers.cookie, origin },
        });
        expect(missingCsrfRead.statusCode).toBe(403);
        expect(missingCsrfRead.json()).toMatchObject({ code: 'csrf_failed' });
        const unverifiedRead = await unverifiedApp.app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
        expect(unverifiedRead.statusCode).toBe(403);
        expect(unverifiedRead.json()).toMatchObject({ code: 'email_not_verified' });
        const outsiderRead = await outsiderApp.app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
        expect(outsiderRead.statusCode).toBe(403);
        expect(outsiderRead.json()).toMatchObject({ code: 'house_membership_required' });
        const response = await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          version: 2,
          conflicts: [],
          quarantined: [{
            planDate: losingDate,
            reasonCode: 'target_projection_inconsistent',
            sourceSnapshot: { state: expect.any(Object), projection: expect.any(Object) },
            targetSnapshot: { state: expect.any(Object), projection: expect.any(Object) },
            observed: { manualTuple: null, command: null },
          }],
        });
        const retry = await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
        expect(retry.json()).toEqual(response.json());
        expect(response.json().quarantined).toHaveLength(1);

        // A raw quarantine has no resolve/replay path while the product
        // disposition is unanswered: an unknown conflict id is not found.
        const bogusResolve = await app.inject({
          method: 'POST',
          url: `/v1/meal-plan/recovery/${'00000000-0000-0000-0000-000000000000'}/resolve`,
          headers,
          payload: {
            expectedSourceRevision: '00000000-0000-0000-0000-000000000000',
            expectedTargetRevision: '00000000-0000-0000-0000-000000000000',
            command: accountCommand,
          },
        });
        expect(bogusResolve.statusCode).toBe(404);
        expect(bogusResolve.json()).toMatchObject({ code: 'plan_recovery_not_found' });

        // The fenced date stays closed through repeated migration retries.
        await repository.migrateUserSharedDataToHouse(userId, houseId);
        const stillQuarantined = await app.inject({ method: 'GET', url: '/v1/meal-plan/recovery', headers });
        expect(stillQuarantined.json().quarantined).toHaveLength(1);
        await expect(repository.readMealPlanStates(userId, `house:${houseId}`, [losingDate])).rejects.toMatchObject({
          code: 'plan_migration_quarantined',
        });
      } finally {
        await app.close();
        await outsiderApp.app.close();
        await unverifiedApp.app.close();
      }
  });
});
