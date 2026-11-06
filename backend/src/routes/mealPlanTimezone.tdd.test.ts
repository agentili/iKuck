import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemoryHouseRepository } from '../house/repository.js';
import { createHouseService } from '../house/service.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };

describe('house meal-plan timezone', () => {
  it('keeps the first committed timezone when initializations race', async () => {
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
      const initialize = (timeZone: string) => app.inject({
        method: 'POST', url: '/v1/house/time-zone/initialize', headers, payload: { timeZone },
      });
      const [rome, newYork] = await Promise.all([initialize('Europe/Rome'), initialize('America/New_York')]);
      expect(rome.statusCode).toBe(200);
      expect(newYork.statusCode).toBe(200);
      expect(['Europe/Rome', 'America/New_York']).toContain(rome.json().timeZone);
      expect(rome.json().revision).toEqual(expect.any(String));
      expect(newYork.json()).toEqual(rome.json());
      const read = await app.inject({ method: 'GET', url: '/v1/house/time-zone', headers });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(rome.json());
    } finally {
      await app.close();
    }
  });
});
