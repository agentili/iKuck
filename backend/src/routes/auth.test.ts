import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';

const probes = {
  database: { ping: async () => undefined },
  cache: { ping: async () => undefined },
};

const service = {
  login: vi.fn().mockResolvedValue({
    user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-12T12:00:00.000Z' },
    sessionToken: 'session-token',
    csrfToken: 'csrf-token',
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService;

describe('authentication routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets an HttpOnly session cookie after a verified login', async () => {
    const app = createApp({
      ...probes,
      auth: { service, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'user@example.com', password: 'password' },
      headers: { origin: 'http://127.0.0.1:5173' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(response.headers['set-cookie']).not.toContain('Secure');
    expect(response.json()).toMatchObject({ authenticated: true, csrfToken: 'csrf-token' });
  });

  it('rejects a state-changing request from an unexpected origin', async () => {
    const app = createApp({
      ...probes,
      auth: { service, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'user@example.com', password: 'password' },
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'csrf_failed', message: 'Request origin is not allowed' });
    expect(service.login).not.toHaveBeenCalled();
  });
});
