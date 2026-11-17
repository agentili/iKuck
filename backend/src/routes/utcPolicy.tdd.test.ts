import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=test-session', origin, 'x-csrf-token': 'csrf-token' };

const setup = async () => {
  const repository = createMemoryHouseRepository([
    { id: 'admin', email: 'admin@example.test', displayName: 'Admin', emailVerifiedAt: new Date() },
  ]);
  const authService = {
    authenticate: async () => ({
      id: 'session-admin', userId: 'admin', email: 'admin@example.test', emailVerifiedAt: new Date(),
      csrfTokenHash: hashOpaqueToken('csrf-token'), expiresAt: new Date('2099-01-01T00:00:00Z'),
    }),
  } as unknown as AuthService;
  const app = createApp({
    database: { ping: async () => undefined }, cache: { ping: async () => undefined },
    house: { service: createHouseService({ repository }), authService, appOrigin: origin,
      rateLimiter: { enforce: async () => undefined } },
  });
  const created = await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
  expect(created.statusCode).toBe(201);
  return { app, repository };
};

describe('fixed UTC policy', () => {
  it('creates a house in UTC without any client initialization', async () => {
    const { app, repository } = await setup();
    try {
      const read = await app.inject({ method: 'GET', url: '/v1/house/time-zone', headers });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ timeZone: 'UTC', revision: expect.any(String) });
      expect(await repository.getTimeZoneForUser('admin')).toMatchObject({ state: read.json() });
    } finally { await app.close(); }
  });

  it.each(['Europe/Rome', 'America/New_York', 'UTC', null])('does not expose timezone mutations for %s, even to admins', async (timeZone) => {
    const { app } = await setup();
    try {
      const before = (await app.inject({ method: 'GET', url: '/v1/house/time-zone', headers })).json();
      const initialized = await app.inject({
        method: 'POST', url: '/v1/house/time-zone/initialize', headers, payload: { timeZone },
      });
      expect(initialized.statusCode).toBe(404);
      const updated = await app.inject({
        method: 'PUT', url: '/v1/house/time-zone', headers, payload: { timeZone, expectedRevision: before.revision },
      });
      expect(updated.statusCode).toBe(404);
      const after = await app.inject({ method: 'GET', url: '/v1/house/time-zone', headers });
      expect(after.json()).toEqual(before);
    } finally { await app.close(); }
  });
});
