import type { PlanCommand } from '@ikuck/shared/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';
import { createMemorySyncRepository, type SyncRepository } from '../sync/repository.js';

const origin = 'http://127.0.0.1:5173';
const adminId = 'migration-admin';
const memberId = 'migration-member';
const planDate = '2026-11-27';
const headers = {
  cookie: 'ikuck_session=session-token',
  origin,
  'x-csrf-token': 'csrf-token',
};

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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const makeFixture = async () => {
  const houseRepository = createMemoryHouseRepository([
    { id: adminId, email: `${adminId}@example.com`, displayName: 'Admin', emailVerifiedAt: new Date() },
    { id: memberId, email: `${memberId}@example.com`, displayName: 'Member', emailVerifiedAt: new Date() },
  ]);
  const baseRepository = createMemorySyncRepository({
    mealPlanV2Enabled: true,
    clock: () => new Date('2026-10-29T12:00:00.000Z'),
    scopeResolver: async (userId) => {
      const membership = await houseRepository.getMembershipForUser(userId);
      return membership === null ? null : { kind: 'house', id: membership.houseId };
    },
  });
  let failNextMemberMigration = false;
  let pauseNextMemberMigration = false;
  let migrationStarted = deferred();
  let releaseMigration = deferred();
  const repository = {
    ...baseRepository,
    migrateUserSharedDataToHouse: async (userId: string, houseId: string, mutations?: Parameters<SyncRepository['migrateUserSharedDataToHouse']>[2]) => {
      if (userId === memberId && failNextMemberMigration) {
        failNextMemberMigration = false;
        throw new Error('injected membership migration failure');
      }
      if (userId === memberId && pauseNextMemberMigration) {
        pauseNextMemberMigration = false;
        migrationStarted.resolve();
        await releaseMigration.promise;
      }
      return baseRepository.migrateUserSharedDataToHouse(userId, houseId, mutations);
    },
  } as SyncRepository;

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
  const adminApp = makeApp(adminId);
  const memberApp = makeApp(memberId);
  const sourceCommand: PlanCommand = {
    version: 2,
    scope: `account:${memberId}`,
    date: planDate,
    operationId: 'member-plan-before-house-add',
    deviceId: 'member-device',
    action: 'manual_set',
    recipeId: 'member-recipe',
    clientUpdatedAt: '2026-01-05T12:00:00.000Z',
  };
  await baseRepository.applyMealPlanCommand(memberId, sourceCommand);
  const createHouse = await adminApp.inject({
    method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' },
  });
  if (createHouse.statusCode !== 201) throw new Error(`House setup failed: ${createHouse.statusCode}`);
  const houseId = createHouse.json<{ house: { id: string } }>().house.id;
  failNextMemberMigration = true;
  const addMemberResponse = await adminApp.inject({
    method: 'POST', url: '/v1/house/members', headers, payload: { email: `${memberId}@example.com` },
  });

  return {
    adminApp,
    memberApp,
    houseRepository,
    baseRepository,
    houseId,
    sourceCommand,
    addMemberResponse,
    pauseRetryMigration: () => {
      pauseNextMemberMigration = true;
      migrationStarted = deferred();
      releaseMigration = deferred();
      return { started: migrationStarted.promise, release: releaseMigration.resolve };
    },
  };
};

describe('pending house data migration barrier', () => {
  it('returns a retryable pending result after direct add commits membership but migration fails', async () => {
    const fixture = await makeFixture();
    try {
      await expect(fixture.houseRepository.getMembershipForUser(memberId)).resolves.toMatchObject({
        userId: memberId,
        houseId: fixture.houseId,
      });
      expect(fixture.addMemberResponse.statusCode).toBe(503);
      expect(fixture.addMemberResponse.headers['retry-after']).toBe('1');
      expect(fixture.addMemberResponse.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });
    } finally {
      await fixture.adminApp.close();
      await fixture.memberApp.close();
    }
  });

  it('blocks direct meal-plan reads while bootstrap migration retry is in flight', async () => {
    const fixture = await makeFixture();
    try {
      const retry = fixture.pauseRetryMigration();
      const bootstrap = fixture.memberApp.inject({ method: 'GET', url: '/v1/house', headers });
      await retry.started;

      let planRead;
      try {
        planRead = await fixture.memberApp.inject({
          method: 'POST', url: '/v1/meal-plan/read', headers,
          payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
        });
      } finally {
        retry.release();
      }
      expect(planRead.statusCode).toBe(503);
      expect(planRead.headers['retry-after']).toBe('1');
      expect(planRead.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });
      expect((await bootstrap).statusCode).toBe(200);
    } finally {
      await fixture.adminApp.close();
      await fixture.memberApp.close();
    }
  });

  it('blocks v2 Plan sync while bootstrap migration retry is in flight', async () => {
    const fixture = await makeFixture();
    try {
      const retry = fixture.pauseRetryMigration();
      const bootstrap = fixture.memberApp.inject({ method: 'GET', url: '/v1/house', headers });
      await retry.started;

      let planSync;
      try {
        planSync = await fixture.memberApp.inject({
          method: 'POST', url: '/v1/sync', headers,
          payload: {
            deviceId: 'member-house-device',
            cursor: 0,
            syncScope: `house:${fixture.houseId}`,
            mutations: [],
            supportedEntityTypes: ['meal_plan_entry'],
            mealPlanReadVersion: 2,
          },
        });
      } finally {
        retry.release();
      }
      expect(planSync.statusCode).toBe(503);
      expect(planSync.headers['retry-after']).toBe('1');
      expect(planSync.json()).toMatchObject({ code: 'house_migration_pending', retryable: true });
      expect((await bootstrap).statusCode).toBe(200);
    } finally {
      await fixture.adminApp.close();
      await fixture.memberApp.close();
    }
  });

  it('completes bootstrap retry before exposing the migrated Plan and keeps repeated retries idempotent', async () => {
    const fixture = await makeFixture();
    try {
      const bootstrap = await fixture.memberApp.inject({ method: 'GET', url: '/v1/house', headers });
      expect(bootstrap.statusCode).toBe(200);
      const planRead = await fixture.memberApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope: `house:${fixture.houseId}`, dates: [planDate] },
      });
      expect(planRead.statusCode).toBe(200);
      expect(planRead.json()).toMatchObject({
        version: 2,
        states: [{ date: planDate, state: { kind: 'manual', recipeId: 'member-recipe' } }],
      });

      const repeatedBootstrap = await fixture.memberApp.inject({ method: 'GET', url: '/v1/house', headers });
      expect(repeatedBootstrap.statusCode).toBe(200);
      const housePlanFeed = await fixture.baseRepository.readChanges(
        memberId, 0, 100, `house:${fixture.houseId}`, ['meal_plan_entry'],
      );
      expect(housePlanFeed.filter((change) => change.entityId === planDate)).toHaveLength(1);
      const exportedPlanRows = (await fixture.baseRepository.readAll(memberId))
        .filter((change) => change.entityType === 'meal_plan_entry');
      expect(exportedPlanRows).toHaveLength(1);
    } finally {
      await fixture.adminApp.close();
      await fixture.memberApp.close();
    }
  });
});
