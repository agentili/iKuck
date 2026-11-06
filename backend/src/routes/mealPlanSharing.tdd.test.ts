import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };
const verifiedUser = (id: string) => ({
  id, email: `${id}@example.com`, displayName: id, emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
});
const authFor = (userId: string) => ({
  authenticate: async () => ({
    id: `session-${userId}`, userId, email: `${userId}@example.com`,
    emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
    csrfTokenHash: hashOpaqueToken('csrf-token'), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  }),
}) as unknown as AuthService;

describe('meal plan household persistence', () => {
  it('makes a saved household choice visible to a member who joins later', async () => {
    const houseRepository = createMemoryHouseRepository([verifiedUser('admin'), verifiedUser('new-member')]);
    const syncRepository = createMemorySyncRepository({
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership ? { kind: 'house', id: membership.houseId } : null;
      },
    });
    const houseService = createHouseService({ repository: houseRepository });
    const makeApp = (userId: string) => {
      const authService = authFor(userId);
      return createApp({
        database: { ping: async () => undefined }, cache: { ping: async () => undefined },
        auth: { service: authService, appOrigin: origin, secureCookies: false },
        house: { service: houseService, authService, appOrigin: origin, rateLimiter: { enforce: async () => undefined } },
        sync: { repository: syncRepository, authService, appOrigin: origin },
      });
    };
    const adminApp = makeApp('admin');
    const memberApp = makeApp('new-member');
    try {
      const house = await adminApp.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
      expect(house.statusCode).toBe(201);
      const scope = `house:${house.json().house.id}`;
      const selection = await adminApp.inject({
        method: 'POST', url: '/v1/meal-plan/commands', headers,
        payload: {
          version: 2, scope, date: '2026-10-30', operationId: 'manual-choice-1', deviceId: 'admin-device',
          clientUpdatedAt: '2026-10-28T12:00:00.000Z', action: 'manual_set', recipeId: 'pollo-al-limone',
        },
      });
      expect(selection.statusCode).toBe(200);
      expect(selection.json()).toMatchObject({ version: 2, operationId: 'manual-choice-1', outcome: 'applied' });
      const added = await adminApp.inject({
        method: 'POST', url: '/v1/house/members', headers, payload: { email: 'new-member@example.com' },
      });
      expect(added.statusCode).toBe(201);
      const read = await memberApp.inject({
        method: 'POST', url: '/v1/meal-plan/read', headers,
        payload: { version: 2, scope, dates: ['2026-10-30'] },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        version: 2,
        states: [{ date: '2026-10-30', state: { date: '2026-10-30', kind: 'manual', recipeId: 'pollo-al-limone' } }],
      });
    } finally {
      await adminApp.close();
      await memberApp.close();
    }
  });

  it('preserves manual ordering when an account choice is migrated into a house', async () => {
    const houseRepository = createMemoryHouseRepository([verifiedUser('admin'), verifiedUser('new-member')]);
    const syncRepository = createMemorySyncRepository({
      scopeResolver: async (userId) => {
        const membership = await houseRepository.getMembershipForUser(userId);
        return membership ? { kind: 'house', id: membership.houseId } : null;
      },
    });
    const houseService = createHouseService({ repository: houseRepository, syncRepository });
    const makeApp = (userId: string) => {
      const authService = authFor(userId);
      return createApp({
        database: { ping: async () => undefined }, cache: { ping: async () => undefined },
        auth: { service: authService, appOrigin: origin, secureCookies: false },
        house: { service: houseService, authService, appOrigin: origin, rateLimiter: { enforce: async () => undefined } },
        sync: { repository: syncRepository, authService, appOrigin: origin },
      });
    };
    const adminApp = makeApp('admin');
    const memberApp = makeApp('new-member');
    try {
      const accountChoice = await memberApp.inject({
        method: 'POST', url: '/v1/meal-plan/commands', headers,
        payload: {
          version: 2, scope: 'account:new-member', date: '2026-10-31', operationId: 'account-choice',
          deviceId: 'member-device', clientUpdatedAt: '2026-10-10T12:00:00.000Z',
          action: 'manual_set', recipeId: 'pre-house-choice',
        },
      });
      expect(accountChoice.statusCode).toBe(200);
      expect(accountChoice.json()).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'pre-house-choice' } });

      const house = await adminApp.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
      expect(house.statusCode).toBe(201);
      const scope = `house:${house.json().house.id}`;
      const added = await adminApp.inject({
        method: 'POST', url: '/v1/house/members', headers, payload: { email: 'new-member@example.com' },
      });
      expect(added.statusCode).toBe(201);

      const olderChoice = await memberApp.inject({
        method: 'POST', url: '/v1/meal-plan/commands', headers,
        payload: {
          version: 2, scope, date: '2026-10-31', operationId: 'older-house-choice',
          deviceId: 'member-device', clientUpdatedAt: '2026-10-09T12:00:00.000Z',
          action: 'manual_set', recipeId: 'older-choice',
        },
      });
      expect(olderChoice.statusCode).toBe(200);
      expect(olderChoice.json()).toMatchObject({
        outcome: 'conflict', current: { kind: 'manual', recipeId: 'pre-house-choice' },
      });
    } finally {
      await adminApp.close();
      await memberApp.close();
    }
  });
});
