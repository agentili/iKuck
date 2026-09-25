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
    emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
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
    await app.close();
  });

  it('rejects every profile data route for an unverified session', async () => {
    const unverifiedAuth = {
      authenticate: async () => ({
        id: 'session-unverified',
        userId: 'user-1',
        email: 'user@example.com',
        emailVerifiedAt: null,
        csrfTokenHash: hashOpaqueToken('csrf-token'),
        expiresAt: new Date('2026-10-12T12:00:00.000Z'),
      }),
    } as unknown as AuthService;
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      profile: { repository: createMemoryProfileRepository(), authService: unverifiedAuth, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
    });
    const headers = { cookie: 'ikuck_session=session-token', origin: 'http://127.0.0.1:5173', 'x-csrf-token': 'csrf-token' };

    for (const request of [
      { method: 'GET' as const, url: '/v1/profile' },
      { method: 'PATCH' as const, url: '/v1/profile', payload: { displayName: 'Nope' } },
      { method: 'GET' as const, url: '/v1/profile/export' },
      { method: 'DELETE' as const, url: '/v1/profile' },
    ]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(response.json()).toMatchObject({ code: 'email_not_verified' });
    }
    await app.close();
  });
});
