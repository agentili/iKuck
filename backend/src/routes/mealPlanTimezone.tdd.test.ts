import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=test-session', origin, 'x-csrf-token': 'csrf-token' };

describe('house meal-plan timezone', () => {
  it('returns the same fixed UTC state for concurrent reads', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const authService = {
      authenticate: async () => ({
        id: 'session-admin-1', userId: 'admin-1', email: 'admin@example.com',
        emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
        csrfTokenHash: hashOpaqueToken('csrf-token'), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      }),
    } as unknown as AuthService;
    const app = createApp({
      database: { ping: async () => undefined }, cache: { ping: async () => undefined },
      house: { service: createHouseService({ repository }), authService, appOrigin: origin,
        rateLimiter: { enforce: async () => undefined } },
    });

    try {
      const created = await app.inject({ method: 'POST', url: '/v1/house', headers, payload: { name: 'Casa' } });
      expect(created.statusCode).toBe(201);
      const readZone = () => app.inject({ method: 'GET', url: '/v1/house/time-zone', headers });
      const [first, second] = await Promise.all([readZone(), readZone()]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ timeZone: 'UTC', revision: expect.any(String) });
      expect(second.json()).toEqual(first.json());
      const read = await app.inject({ method: 'GET', url: '/v1/house/time-zone', headers });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(first.json());
    } finally {
      await app.close();
    }
  });
});
