import type { PlanCommand, SyncMutationScope } from '@ikuck/shared/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';

const origin = 'http://127.0.0.1:5173';
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

const headers = {
  cookie: 'ikuck_session=session-token',
  origin,
  'x-csrf-token': 'csrf-token',
};

const createMembershipFixture = async () => {
  let userIsMember = false;
  const houseRepository = createMemoryHouseRepository([
    { id: 'user-1', email: 'user-1@example.com', displayName: 'User', emailVerifiedAt: new Date() },
    { id: 'house-admin', email: 'house-admin@example.com', displayName: 'House Admin', emailVerifiedAt: new Date() },
  ]);
  const repository = createMemorySyncRepository({
    clock: fixedClock,
    scopeResolver: async (userId) => userId === 'house-admin' || (userId === 'user-1' && userIsMember)
      ? { kind: 'house', id: 'house-1' }
      : null,
  });
  const makeApp = (userId: string) => {
    const authService = authFor(userId);
    return createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: authService, appOrigin: origin, secureCookies: false },
      sync: { repository, authService, appOrigin: origin },
      house: {
        service: createHouseService({ repository: houseRepository, syncRepository: repository }),
        authService,
        appOrigin: origin,
        rateLimiter: { enforce: async () => undefined },
      },
    });
  };
  const userApp = makeApp('user-1');
  const adminApp = makeApp('house-admin');

  // Create house
  const createHouse = await adminApp.inject({
    method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' },
  });
  expect(createHouse.statusCode).toBe(201);
  const houseId = createHouse.json<{ house: { id: string } }>().house.id;

  return {
    userApp,
    adminApp,
    houseRepository,
    repository,
    houseId,
    joinHouse: () => { userIsMember = true; },
  };
};

describe('meal-plan migration quarantine route/service tests (uncovered REDs)', () => {
  it('returns 409 plan_migration_quarantined on direct meal-plan read for manual source without tuple', async () => {
    const fixture = await createMembershipFixture();
    try {
      const accountCommand = makeManualPlanCommand(accountScope, 'account-manual-no-tuple-read', 'personal-recipe', '2026-01-01T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('user-1', accountCommand);

      fixture.joinHouse();
      await fixture.repository.updateAiConsent('user-1', { enabled: false });
      await fixture.repository.migrateUserSharedDataToHouse('user-1', fixture.houseId);

      const read = await fixture.userApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
      });
      expect(read.statusCode).toBe(409);
      expect(read.json()).toMatchObject({ code: 'plan_migration_quarantined' });
    } finally {
      await fixture.userApp.close();
      await fixture.adminApp.close();
    }
  });

  it('returns 409 plan_migration_quarantined on v2 Plan sync for manual source without tuple', async () => {
    const fixture = await createMembershipFixture();
    try {
      const accountCommand = makeManualPlanCommand(accountScope, 'account-manual-no-tuple-sync', 'personal-recipe', '2026-01-01T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('user-1', accountCommand);

      fixture.joinHouse();
      await fixture.repository.updateAiConsent('user-1', { enabled: false });
      await fixture.repository.migrateUserSharedDataToHouse('user-1', fixture.houseId);

      const sync = await fixture.userApp.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: {
          deviceId: 'quarantine-reader', cursor: 0, syncScope: `house:${fixture.houseId}`, mutations: [],
          supportedEntityTypes: ['meal_plan_entry'], mealPlanReadVersion: 2,
        },
      });
      expect(sync.statusCode).toBe(409);
      expect(sync.json()).toMatchObject({ code: 'plan_migration_quarantined' });
    } finally {
      await fixture.userApp.close();
      await fixture.adminApp.close();
    }
  });

  it('returns 409 plan_migration_quarantined on direct meal-plan read for deleted source without tuple', async () => {
    const fixture = await createMembershipFixture();
    try {
      const accountCommand = makeDeleteCommand(accountScope, 'account-deleted-no-tuple-read', '2026-01-01T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('user-1', accountCommand);

      fixture.joinHouse();
      await fixture.repository.updateAiConsent('user-1', { enabled: false });
      await fixture.repository.migrateUserSharedDataToHouse('user-1', fixture.houseId);

      const read = await fixture.userApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
      });
      expect(read.statusCode).toBe(409);
      expect(read.json()).toMatchObject({ code: 'plan_migration_quarantined' });
    } finally {
      await fixture.userApp.close();
      await fixture.adminApp.close();
    }
  });

  it('returns 409 plan_migration_quarantined on direct meal-plan read for source projection inconsistent', async () => {
    const fixture = await createMembershipFixture();
    try {
      const accountCommand = makeManualPlanCommand(accountScope, 'account-source-inconsistent-read', 'canonical-recipe', '2026-01-01T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('user-1', accountCommand);

      fixture.joinHouse();
      await fixture.repository.updateAiConsent('user-1', { enabled: false });
      await fixture.repository.migrateUserSharedDataToHouse('user-1', fixture.houseId);

      const read = await fixture.userApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
      });
      expect(read.statusCode).toBe(409);
      expect(read.json()).toMatchObject({ code: 'plan_migration_quarantined' });
    } finally {
      await fixture.userApp.close();
      await fixture.adminApp.close();
    }
  });

  it('returns 409 plan_migration_quarantined on direct meal-plan read for target projection inconsistent', async () => {
    const fixture = await createMembershipFixture();
    try {
      const accountCommand = makeManualPlanCommand(accountScope, 'account-target-inconsistent-source', 'source-recipe', '2026-01-01T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('user-1', accountCommand);

      const houseCommand = makeManualPlanCommand(houseScope, 'house-target-inconsistent-target', 'target-recipe', '2026-01-02T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('house-admin', houseCommand);

      fixture.joinHouse();
      await fixture.repository.updateAiConsent('user-1', { enabled: false });
      await fixture.repository.migrateUserSharedDataToHouse('user-1', fixture.houseId);

      const read = await fixture.userApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
      });
      expect(read.statusCode).toBe(409);
      expect(read.json()).toMatchObject({ code: 'plan_migration_quarantined' });
    } finally {
      await fixture.userApp.close();
      await fixture.adminApp.close();
    }
  });

  it('exposes quarantined evidence through GET /v1/meal-plan/recovery', async () => {
    const fixture = await createMembershipFixture();
    try {
      const accountCommand = makeManualPlanCommand(accountScope, 'account-quarantine-recovery-read', 'personal-recipe', '2026-01-01T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('user-1', accountCommand);

      fixture.joinHouse();
      await fixture.repository.updateAiConsent('user-1', { enabled: false });
      await fixture.repository.migrateUserSharedDataToHouse('user-1', fixture.houseId);

      const recovery = await fixture.userApp.inject({
        method: 'GET', url: '/v1/meal-plan/recovery', headers,
      });
      expect(recovery.statusCode).toBe(200);
      const body = recovery.json();
      expect(body.version).toBe(2);
      expect(body.quarantined.length).toBeGreaterThan(0);
      expect(body.quarantined[0]).toMatchObject({
        planDate,
        reasonCode: expect.stringMatching(/manual_tuple_missing|source_projection_inconsistent|target_projection_inconsistent/),
        sourceSnapshot: { state: expect.any(Object), projection: expect.any(Object) },
        targetSnapshot: { state: expect.any(Object), projection: expect.any(Object) },
        observed: { manualTuple: null, command: null },
      });
    } finally {
      await fixture.userApp.close();
      await fixture.adminApp.close();
    }
  });

  it('keeps quarantine idempotent on repeated GET /v1/house bootstrap retry', async () => {
    const fixture = await createMembershipFixture();
    try {
      const accountCommand = makeManualPlanCommand(accountScope, 'account-quarantine-idempotent-read', 'personal-recipe', '2026-01-01T00:00:00.000Z');
      await fixture.repository.applyMealPlanCommand('user-1', accountCommand);

      fixture.joinHouse();
      await fixture.repository.updateAiConsent('user-1', { enabled: false });
      await fixture.repository.migrateUserSharedDataToHouse('user-1', fixture.houseId);

      // First bootstrap retry
      const bootstrap1 = await fixture.userApp.inject({ method: 'GET', url: '/v1/house', headers });
      expect(bootstrap1.statusCode).toBe(200);

      // Read should still fail closed
      const read1 = await fixture.userApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
      });
      expect(read1.statusCode).toBe(409);
      expect(read1.json()).toMatchObject({ code: 'plan_migration_quarantined' });

      // Second bootstrap retry (idempotent)
      const bootstrap2 = await fixture.userApp.inject({ method: 'GET', url: '/v1/house', headers });
      expect(bootstrap2.statusCode).toBe(200);

      // Read should still fail closed
      const read2 = await fixture.userApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
      });
      expect(read2.statusCode).toBe(409);
      expect(read2.json()).toMatchObject({ code: 'plan_migration_quarantined' });

      // Recovery should show same quarantined entry
      const recovery = await fixture.userApp.inject({
        method: 'GET', url: '/v1/meal-plan/recovery', headers,
      });
      expect(recovery.json().quarantined).toHaveLength(1);
    } finally {
      await fixture.userApp.close();
      await fixture.adminApp.close();
    }
  });
});