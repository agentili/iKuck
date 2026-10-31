import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };
const userId = 'plan-v2-user';
const date = '2026-11-05';

const authFor = (verified = true): AuthService => ({
  authenticate: async () => ({
    id: 'session-plan-v2', userId, email: 'plan-v2@example.com',
    emailVerifiedAt: verified ? new Date('2026-09-24T00:00:00.000Z') : null,
    csrfTokenHash: hashOpaqueToken('csrf-token'), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  }),
}) as unknown as AuthService;

const makeApp = (repository = createMemorySyncRepository(), authService = authFor()) => ({
  repository,
  app: createApp({
    database: { ping: async () => undefined }, cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin: origin, secureCookies: false },
    sync: { repository, authService, appOrigin: origin },
  }),
});

const manualCommand = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  scope: `account:${userId}`,
  date,
  operationId: 'manual-op-1',
  deviceId: 'device-manual',
  clientUpdatedAt: '2026-01-01T00:00:00.000Z',
  action: 'manual_set',
  recipeId: 'chosen-recipe',
  ...overrides,
});

describe('meal plan v2 command boundary', () => {
  it('returns the original receipt for an identical operation and rejects changed content', async () => {
    const { app } = makeApp();
    try {
      const first = await app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload: manualCommand() });
      expect(first.statusCode).toBe(200);
      const replay = await app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload: manualCommand() });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      const changed = await app.inject({
        method: 'POST', url: '/v1/meal-plan/commands', headers,
        payload: manualCommand({ recipeId: 'different-recipe' }),
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: 'operation_id_reused' });
    } finally {
      await app.close();
    }
  });

  it('rejects malformed versions, impossible civil dates and extra command fields', async () => {
    const { app } = makeApp();
    try {
      const invalidVersion = await app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload: manualCommand({ version: 1 }) });
      const impossibleDate = await app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload: manualCommand({ date: '2026-02-30' }) });
      const extraField = await app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload: manualCommand({ auto: true }) });
      expect(invalidVersion.statusCode).toBe(400);
      expect(invalidVersion.json()).toMatchObject({ code: 'INVALID_PLAN_COMMAND' });
      expect(impossibleDate.statusCode).toBe(400);
      expect(extraField.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('keeps deletes as tombstones until revision-matched explicit regeneration', async () => {
    const { app } = makeApp();
    try {
      const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload });
      const deleted = await send({
        version: 2, scope: `account:${userId}`, date, operationId: 'delete-1', deviceId: 'device-manual',
        clientUpdatedAt: '2026-01-03T00:00:00.000Z', action: 'manual_delete',
      });
      expect(deleted.json()).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
      const automatic = await send({
        version: 2, scope: `account:${userId}`, date, operationId: 'auto-after-delete', deviceId: 'device-auto',
        clientUpdatedAt: '2026-01-04T00:00:00.000Z', action: 'auto_create', recipeId: 'late-recipe', baseRevision: null,
      });
      expect(automatic.json()).toMatchObject({ outcome: 'conflict', current: deleted.json().current });
      const regenerated = await send({
        version: 2, scope: `account:${userId}`, date, operationId: 'explicit-regenerate-1', deviceId: 'device-auto',
        clientUpdatedAt: '2026-01-04T00:00:00.000Z', action: 'explicit_regenerate', recipeId: 'confirmed-recipe',
        baseRevision: deleted.json().current.revision,
      });
      expect(regenerated.json()).toMatchObject({ outcome: 'applied', current: { kind: 'automatic', recipeId: 'confirmed-recipe' } });
      const staleManual = await send({
        version: 2, scope: `account:${userId}`, date, operationId: 'manual-stale', deviceId: 'device-manual',
        clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_set', recipeId: 'stale-choice',
      });
      expect(staleManual.json()).toMatchObject({ outcome: 'conflict', current: regenerated.json().current });
      const freshManual = await send({
        version: 2, scope: `account:${userId}`, date, operationId: 'manual-fresh', deviceId: 'device-manual',
        clientUpdatedAt: '2026-01-05T00:00:00.000Z', action: 'manual_set', recipeId: 'fresh-choice',
      });
      expect(freshManual.json()).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'fresh-choice' } });
      const staleRegeneration = await send({
        version: 2, scope: `account:${userId}`, date, operationId: 'explicit-stale', deviceId: 'device-auto',
        clientUpdatedAt: '2026-01-06T00:00:00.000Z', action: 'explicit_regenerate', recipeId: 'stale-regeneration',
        baseRevision: deleted.json().current.revision,
      });
      expect(staleRegeneration.json()).toMatchObject({ outcome: 'conflict', current: freshManual.json().current });
    } finally {
      await app.close();
    }
  });

  it('rejects legacy sync writes before applying any other mutation in that batch', async () => {
    const { app, repository } = makeApp();
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/sync', headers,
        payload: {
          deviceId: 'device-manual', cursor: 0, syncScope: `account:${userId}`,
          mutations: [
            {
              mutationId: 'pantry-before-plan', deviceId: 'device-manual', entityType: 'pantry_item', entityId: 'tomato',
              operation: 'upsert', payload: { id: 'tomato', label: 'Pomodoro', known: true },
              clientUpdatedAt: '2026-01-01T00:00:00.000Z', syncScope: `account:${userId}`,
            },
            {
              mutationId: 'legacy-plan-write', deviceId: 'device-manual', entityType: 'meal_plan_entry', entityId: date,
              operation: 'upsert', payload: { date, recipeId: 'legacy-recipe' },
              clientUpdatedAt: '2026-01-01T00:00:00.000Z', syncScope: `account:${userId}`,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'PLAN_COMMAND_REQUIRED' });
      await expect(repository.readAll(userId)).resolves.toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('advertises v2 and serves meal-plan projections only to a v2 sync reader', async () => {
    const { app } = makeApp();
    try {
      const command = await app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload: {
        version: 2, scope: `account:${userId}`, date, operationId: 'auto-op-1', deviceId: 'device-auto',
        clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'auto_create', recipeId: 'suggested-recipe', baseRevision: null,
      } });
      expect(command.statusCode).toBe(200);
      const capabilities = await app.inject({ method: 'GET', url: '/v1/meal-plan/capabilities', headers });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json()).toEqual({ version: 2, syncReadVersion: 2 });

      const legacyReader = await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: {
        deviceId: 'device-auto', cursor: 0, syncScope: `account:${userId}`, mutations: [],
        supportedEntityTypes: ['meal_plan_entry'],
      } });
      expect(legacyReader.statusCode).toBe(200);
      expect(legacyReader.json().changes).toEqual([]);

      const v2Reader = await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: {
        deviceId: 'device-auto', cursor: 0, syncScope: `account:${userId}`, mutations: [],
        supportedEntityTypes: ['meal_plan_entry'], mealPlanReadVersion: 2,
      } });
      expect(v2Reader.statusCode).toBe(200);
      expect(v2Reader.json().changes).toMatchObject([{
        entityType: 'meal_plan_entry', entityId: date, operation: 'upsert',
        payload: { date, kind: 'automatic', recipeId: 'suggested-recipe', revision: expect.any(String), serverSequence: expect.any(Number) },
      }]);
    } finally {
      await app.close();
    }
  });

  it('requires a verified session, same origin and CSRF for meal-plan reads and writes', async () => {
    const unverified = makeApp(createMemorySyncRepository(), authFor(false));
    const verified = makeApp();
    try {
      const unverifiedWrite = await unverified.app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload: manualCommand() });
      expect(unverifiedWrite.statusCode).toBe(403);
      expect(unverifiedWrite.json()).toMatchObject({ code: 'email_not_verified' });

      const wrongOrigin = await verified.app.inject({
        method: 'POST', url: '/v1/meal-plan/commands', headers: { ...headers, origin: 'https://attacker.example' },
        payload: manualCommand(),
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.json()).toMatchObject({ code: 'csrf_failed' });

      const missingCsrf = await verified.app.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers: { cookie: headers.cookie, origin },
        payload: { version: 2, scope: `account:${userId}`, dates: [date] },
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json()).toMatchObject({ code: 'csrf_failed' });

      const anonymousCapabilities = await verified.app.inject({ method: 'GET', url: '/v1/meal-plan/capabilities' });
      expect(anonymousCapabilities.statusCode).toBe(401);
    } finally {
      await unverified.app.close();
      await verified.app.close();
    }
  });
});
