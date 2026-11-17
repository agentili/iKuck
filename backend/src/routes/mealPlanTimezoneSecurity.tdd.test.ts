import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };
const user = (id: string) => ({ id, email: `${id}@example.com`, displayName: id, emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z') });
const authFor = (userId: string): AuthService => ({
  authenticate: async () => ({
    id: `session-${userId}`, userId, email: `${userId}@example.com`,
    emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'), csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  }),
}) as unknown as AuthService;

const makeApp = (repository: ReturnType<typeof createMemoryHouseRepository>, userId: string) => {
  const authService = authFor(userId);
  return createApp({
    database: { ping: async () => undefined }, cache: { ping: async () => undefined },
    house: { service: createHouseService({ repository }), authService, appOrigin: origin, rateLimiter: { enforce: async () => undefined } },
  });
};

describe('read-only house UTC authorization', () => {
  it('lets house members read UTC without an initialization or editing permission', async () => {
    const repository = createMemoryHouseRepository([user('admin'), user('member')]);
    const adminApp = makeApp(repository, 'admin');
    const memberApp = makeApp(repository, 'member');
    try {
      await adminApp.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
      await createHouseService({ repository }).addMember('admin', 'member@example.com');
      const response = await memberApp.inject({ method: 'GET', url: '/v1/house/time-zone', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ timeZone: 'UTC', revision: expect.any(String) });
    } finally {
      await adminApp.close();
      await memberApp.close();
    }
  });

  it('rejects timezone access for an account outside the current house', async () => {
    const repository = createMemoryHouseRepository([user('admin'), user('outsider')]);
    const adminApp = makeApp(repository, 'admin');
    const outsiderApp = makeApp(repository, 'outsider');
    try {
      await adminApp.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
      const response = await outsiderApp.inject({ method: 'GET', url: '/v1/house/time-zone', headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'house_membership_required' });
    } finally {
      await adminApp.close();
      await outsiderApp.close();
    }
  });
});
