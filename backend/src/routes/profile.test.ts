import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemoryProfileRepository } from '../profile/repository.js';

const sessionService = {
  authenticate: async () => ({
    id: 'session-1',
    userId: 'user-1',
    email: 'user@example.com',
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService;

describe('profile routes', () => {
  it('exports account data without credential material and deletes it with CSRF', async () => {
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
      profile: { repository: createMemoryProfileRepository(), authService: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
    });
    const headers = {
      cookie: 'ikuck_session=session-token',
      origin: 'http://127.0.0.1:5173',
    };

    const exportResponse = await app.inject({ method: 'GET', url: '/v1/profile/export', headers });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json()).not.toHaveProperty('passwordHash');

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/v1/profile',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
    });
    expect(deleteResponse.statusCode).toBe(204);
  });
});
