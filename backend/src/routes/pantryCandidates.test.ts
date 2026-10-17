import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { PantryCandidateService } from '../pantry/candidatesService.js';

const appOrigin = 'http://127.0.0.1:5173';
const cookie = 'ikuck_session=session-token';

const createCandidatesApp = ({
  service,
  verified = true,
  authenticated = true,
}: {
  service?: PantryCandidateService;
  verified?: boolean;
  authenticated?: boolean;
} = {}) => {
  const authService = {
    authenticate: vi.fn().mockResolvedValue(!authenticated ? null : {
      id: 'session-user-a',
      userId: 'user-a',
      email: 'a@example.com',
      emailVerifiedAt: verified ? new Date('2026-09-24T00:00:00.000Z') : null,
      csrfTokenHash: hashOpaqueToken('synthetic-csrf'),
      expiresAt: new Date('2026-10-12T12:00:00.000Z'),
    }),
  } as unknown as AuthService;
  const rateLimiter = { enforce: vi.fn().mockResolvedValue(undefined) };
  const app = createApp({
    database: { ping: async () => undefined },
    cache: { ping: async () => undefined },
    pantryCandidates: { service: service as PantryCandidateService, authService, rateLimiter, appOrigin },
  });
  return { app, authService, rateLimiter };
};

const csrfHeaders = { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' };

describe('pantry candidate routes', () => {
  it('requires a verified session before returning the house inbox', async () => {
    const service = { list: vi.fn(), accept: vi.fn(), ignore: vi.fn() } as unknown as PantryCandidateService;
    const { app, rateLimiter } = createCandidatesApp({ service, verified: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/pantry/candidates', headers: { cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(service.list).not.toHaveBeenCalled();
      expect(rateLimiter.enforce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns only the authenticated member candidate service response', async () => {
    const result = { candidates: [{ id: 'candidate-1', label: 'Latte', rawLabel: 'Milch', normalizedLabel: 'latte' }] };
    const service = { list: vi.fn().mockResolvedValue(result) } as unknown as PantryCandidateService;
    const { app, rateLimiter } = createCandidatesApp({ service });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/pantry/candidates', headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(service.list).toHaveBeenCalledWith('user-a');
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringRead', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['accept', 'accept'],
    ['ignore', 'ignore'],
  ] as const)('protects %s with same-origin CSRF and dispatches a batch of ids', async (path, action) => {
    const result = { results: [{ id: 'candidate-1', ok: true, code: action === 'accept' ? 'accepted' : 'ignored' }] };
    const service = { accept: vi.fn().mockResolvedValue(result), ignore: vi.fn().mockResolvedValue(result) } as unknown as PantryCandidateService;
    const { app, rateLimiter } = createCandidatesApp({ service });
    try {
      const unsafe = await app.inject({
        method: 'POST', url: `/v1/pantry/candidates/${path}`,
        headers: { cookie, origin: 'https://wrong.example', 'x-csrf-token': 'synthetic-csrf' },
        payload: { ids: ['candidate-1'] },
      });
      const response = await app.inject({
        method: 'POST', url: `/v1/pantry/candidates/${path}`,
        headers: csrfHeaders,
        payload: { ids: ['candidate-1'] },
      });
      const extra = await app.inject({
        method: 'POST', url: `/v1/pantry/candidates/${path}`,
        headers: csrfHeaders,
        payload: { ids: ['candidate-1'], houseId: 'attacker-house' },
      });

      expect(unsafe.statusCode).toBe(403);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      expect(extra.statusCode).toBe(400);
      expect(action === 'accept' ? service.accept : service.ignore).toHaveBeenCalledWith('user-a', ['candidate-1']);
      expect(rateLimiter.enforce).toHaveBeenCalledTimes(1);
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringWrite', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects batches larger than one hundred without service dispatch', async () => {
    const service = { accept: vi.fn(), ignore: vi.fn(), list: vi.fn() } as unknown as PantryCandidateService;
    const { app } = createCandidatesApp({ service });
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/pantry/candidates/accept', headers: csrfHeaders,
        payload: { ids: Array.from({ length: 101 }, (_, index) => `candidate-${index}`) },
      });
      expect(response.statusCode).toBe(400);
      expect(service.accept).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('maps a missing house membership without exposing internal details', async () => {
    const service = { list: vi.fn().mockRejectedValue(new AuthServiceError('house_membership_required', 403, 'House membership required')) } as unknown as PantryCandidateService;
    const { app } = createCandidatesApp({ service });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/pantry/candidates', headers: { cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'house_membership_required' });
    } finally {
      await app.close();
    }
  });
});
