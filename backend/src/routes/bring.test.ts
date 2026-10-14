import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import type { BringService } from '../bring/service.js';
import { BringError } from '../bring/errors.js';
import { AuthRateLimitError } from '../auth/rateLimit.js';

const appOrigin = 'http://127.0.0.1:5173';
const cookie = 'ikuck_session=session-token';

type BringEndpoint = {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  mutating: boolean;
  payload?: Record<string, unknown>;
};

const bringEndpoints: BringEndpoint[] = [
  { name: 'status', method: 'GET', url: '/v1/integrations/bring', mutating: false },
  { name: 'connect', method: 'POST', url: '/v1/integrations/bring/connection', mutating: true,
    payload: { email: 'a@example.com', password: 'synthetic-password', confirmExternalAccess: true } },
  { name: 'disconnect', method: 'DELETE', url: '/v1/integrations/bring/connection', mutating: true,
    payload: { connectionId: '550e8400-e29b-41d4-a716-446655440000' } },
  { name: 'lists', method: 'GET', url: '/v1/integrations/bring/lists?connectionId=550e8400-e29b-41d4-a716-446655440000', mutating: false },
  { name: 'items read', method: 'GET', url: '/v1/integrations/bring/items?connectionId=550e8400-e29b-41d4-a716-446655440000&listId=550e8400-e29b-41d4-a716-446655440001', mutating: false },
  { name: 'items write', method: 'POST', url: '/v1/integrations/bring/items', mutating: true,
    payload: {
      connectionId: '550e8400-e29b-41d4-a716-446655440000', listId: '550e8400-e29b-41d4-a716-446655440001',
      action: 'add', name: 'Ceci', specification: '2 confezioni',
    } },
  { name: 'items import', method: 'POST', url: '/v1/integrations/bring/import', mutating: true,
    payload: {
      connectionId: '550e8400-e29b-41d4-a716-446655440000', listId: '550e8400-e29b-41d4-a716-446655440001',
    } },
];

const injectBringEndpoint = (
  app: ReturnType<typeof createApp>,
  endpoint: BringEndpoint,
  headers: Record<string, string>,
) => {
  if (endpoint.method === 'GET') return app.inject({ method: 'GET', url: endpoint.url, headers });
  if (endpoint.method === 'POST') {
    return app.inject({ method: 'POST', url: endpoint.url, headers, payload: endpoint.payload });
  }
  return app.inject({ method: 'DELETE', url: endpoint.url, headers, payload: endpoint.payload });
};

const createBringApp = ({
  verified = true,
  authenticated = true,
  service,
  rateLimiterError,
}: {
  verified?: boolean;
  authenticated?: boolean;
  service?: BringService;
  rateLimiterError?: AuthRateLimitError;
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
  const rateLimiter = { enforce: vi.fn().mockImplementation(() => rateLimiterError === undefined ? Promise.resolve() : Promise.reject(rateLimiterError)) };
  const app = createApp({
    database: { ping: async () => undefined },
    cache: { ping: async () => undefined },
    bring: { authService, appOrigin, rateLimiter, ...(service === undefined ? {} : { service }) },
  });
  return { app, authService, rateLimiter };
};

describe('Bring routes', () => {
  it.each(bringEndpoints)('requires a verified session for the $name endpoint', async (endpoint) => {
    for (const mode of ['guest', 'unverified'] as const) {
      const service = {
        status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), lists: vi.fn(), read: vi.fn(), write: vi.fn(), importList: vi.fn(),
      } as unknown as BringService;
      const { app, rateLimiter } = createBringApp({
        authenticated: mode !== 'guest', verified: mode !== 'unverified', service,
      });
      const headers: Record<string, string> = {
        ...(mode === 'guest' ? {} : { cookie }),
        ...(endpoint.mutating ? { origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' } : {}),
      };
      try {
        const response = await injectBringEndpoint(app, endpoint, headers);

        expect(response.statusCode).toBe(mode === 'guest' ? 401 : 403);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(rateLimiter.enforce).not.toHaveBeenCalled();
        expect(service.status).not.toHaveBeenCalled();
        expect(service.connect).not.toHaveBeenCalled();
        expect(service.disconnect).not.toHaveBeenCalled();
        expect(service.lists).not.toHaveBeenCalled();
        expect(service.read).not.toHaveBeenCalled();
        expect(service.write).not.toHaveBeenCalled();
        expect(service.importList).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  it.each(bringEndpoints.filter((endpoint) => endpoint.mutating))('requires same-origin and CSRF on $name mutations', async (endpoint) => {
    const service = {
      connect: vi.fn(), disconnect: vi.fn(), write: vi.fn(), importList: vi.fn(),
    } as unknown as BringService;
    const { app, authService, rateLimiter } = createBringApp({ service });
    const unsafeHeaders: Record<string, string>[] = [
      { cookie, 'x-csrf-token': 'synthetic-csrf' },
      { cookie, origin: 'https://wrong.example', 'x-csrf-token': 'synthetic-csrf' },
      { cookie, origin: appOrigin },
    ];
    try {
      for (const headers of unsafeHeaders) {
        const response = await injectBringEndpoint(app, endpoint, headers);
        expect(response.statusCode).toBe(403);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(rateLimiter.enforce).not.toHaveBeenCalled();
      expect(service.connect).not.toHaveBeenCalled();
      expect(service.disconnect).not.toHaveBeenCalled();
      expect(service.write).not.toHaveBeenCalled();
      expect(service.importList).not.toHaveBeenCalled();
      expect(authService.authenticate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects unexpected query fields on the status endpoint', async () => {
    const { app } = createBringApp();
    try {
      const response = await app.inject({
        method: 'GET', url: '/v1/integrations/bring?userId=attacker', headers: { cookie },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });

  it('reports the disabled integration without contacting upstream', async () => {
    const { app, rateLimiter } = createBringApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/integrations/bring', headers: { cookie } });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ enabled: false, connected: false, connectionId: null });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(rateLimiter.enforce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('disconnects only the current user connection through a strict write-limited request', async () => {
    const connectionId = '550e8400-e29b-41d4-a716-446655440000';
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const { app, rateLimiter } = createBringApp({ service: { disconnect } as unknown as BringService });
    try {
      const response = await app.inject({
        method: 'DELETE', url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload: { connectionId },
      });
      const extra = await app.inject({
        method: 'DELETE', url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload: { connectionId, userId: 'attacker' },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(extra.statusCode).toBe(400);
      expect(extra.headers['cache-control']).toBe('no-store');
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledWith('user-a', connectionId);
      expect(rateLimiter.enforce).toHaveBeenCalledTimes(1);
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringWrite', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
    } finally {
      await app.close();
    }
  });

  it('reads only the requested connection lists and maps authorization failures', async () => {
    const connectionId = '550e8400-e29b-41d4-a716-446655440000';
    const lists = vi.fn()
      .mockResolvedValueOnce({ connectionId, lists: [{ id: 'list-1', name: 'Spesa' }] })
      .mockRejectedValueOnce(new BringError('bring_not_connected', 409));
    const { app, rateLimiter } = createBringApp({ service: { lists } as unknown as BringService });
    try {
      const response = await app.inject({
        method: 'GET', url: `/v1/integrations/bring/lists?connectionId=${connectionId}`, headers: { cookie },
      });
      const foreignConnection = await app.inject({
        method: 'GET', url: `/v1/integrations/bring/lists?connectionId=${connectionId}`, headers: { cookie },
      });
      const extra = await app.inject({
        method: 'GET', url: `/v1/integrations/bring/lists?connectionId=${connectionId}&userId=attacker`, headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ connectionId, lists: [{ id: 'list-1', name: 'Spesa' }] });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(foreignConnection.statusCode).toBe(409);
      expect(foreignConnection.headers['cache-control']).toBe('no-store');
      expect(extra.statusCode).toBe(400);
      expect(extra.headers['cache-control']).toBe('no-store');
      expect(lists).toHaveBeenCalledTimes(2);
      expect(lists).toHaveBeenNthCalledWith(1, 'user-a', connectionId);
      expect(rateLimiter.enforce).toHaveBeenCalledTimes(2);
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringRead', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
    } finally {
      await app.close();
    }
  });

  it('reads authorized items and rejects an unowned list before returning a snapshot', async () => {
    const connectionId = '550e8400-e29b-41d4-a716-446655440000';
    const listId = '550e8400-e29b-41d4-a716-446655440001';
    const snapshot = { connectionId, listId, labelsAvailable: true, items: [] };
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new BringError('bring_list_not_found', 404));
    const { app, rateLimiter } = createBringApp({ service: { read } as unknown as BringService });
    try {
      const response = await app.inject({
        method: 'GET', url: `/v1/integrations/bring/items?connectionId=${connectionId}&listId=${listId}`, headers: { cookie },
      });
      const foreignList = await app.inject({
        method: 'GET', url: `/v1/integrations/bring/items?connectionId=${connectionId}&listId=${listId}`, headers: { cookie },
      });
      const extra = await app.inject({
        method: 'GET', url: `/v1/integrations/bring/items?connectionId=${connectionId}&listId=${listId}&userId=attacker`, headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(snapshot);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(foreignList.statusCode).toBe(404);
      expect(foreignList.headers['cache-control']).toBe('no-store');
      expect(extra.statusCode).toBe(400);
      expect(extra.headers['cache-control']).toBe('no-store');
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenNthCalledWith(1, 'user-a', connectionId, listId);
      expect(rateLimiter.enforce).toHaveBeenCalledTimes(2);
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringRead', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
    } finally {
      await app.close();
    }
  });

  it('writes strict mutations only for the authenticated user and maps foreign-list errors', async () => {
    const connectionId = '550e8400-e29b-41d4-a716-446655440000';
    const listId = '550e8400-e29b-41d4-a716-446655440001';
    const mutation = { connectionId, listId, action: 'add', name: 'Ceci', specification: '2 confezioni' };
    const snapshot = { connectionId, listId, labelsAvailable: true, items: [] };
    const write = vi.fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new BringError('bring_list_not_found', 404));
    const { app, rateLimiter } = createBringApp({ service: { write } as unknown as BringService });
    const headers = { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' };
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/integrations/bring/items', headers, payload: mutation });
      const foreignList = await app.inject({ method: 'POST', url: '/v1/integrations/bring/items', headers, payload: mutation });
      const extra = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/items', headers, payload: { ...mutation, userId: 'attacker' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(snapshot);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(foreignList.statusCode).toBe(404);
      expect(foreignList.headers['cache-control']).toBe('no-store');
      expect(extra.statusCode).toBe(400);
      expect(extra.headers['cache-control']).toBe('no-store');
      expect(write).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenNthCalledWith(1, 'user-a', mutation);
      expect(rateLimiter.enforce).toHaveBeenCalledTimes(2);
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringWrite', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
    } finally {
      await app.close();
    }
  });

  it('imports one shot through a strict write-limited request without echoing extra fields', async () => {
    const connectionId = '550e8400-e29b-41d4-a716-446655440000';
    const listId = '550e8400-e29b-41d4-a716-446655440001';
    const result = { imported: 2, skipped: 1, recently: 3 };
    const importList = vi.fn().mockResolvedValue(result);
    const { app, rateLimiter } = createBringApp({ service: { importList } as unknown as BringService });
    const headers = { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' };
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/import', headers, payload: { connectionId, listId },
      });
      const extra = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/import', headers, payload: { connectionId, listId, userId: 'attacker' },
      });
      const incomplete = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/import', headers, payload: { connectionId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(extra.statusCode).toBe(400);
      expect(extra.json()).toMatchObject({ code: 'bring_invalid_payload' });
      expect(extra.headers['cache-control']).toBe('no-store');
      expect(incomplete.statusCode).toBe(400);
      expect(incomplete.json()).toMatchObject({ code: 'bring_invalid_payload' });
      expect(importList).toHaveBeenCalledTimes(1);
      expect(importList).toHaveBeenCalledWith('user-a', connectionId, listId);
      expect(rateLimiter.enforce).toHaveBeenCalledTimes(1);
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringWrite', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
    } finally {
      await app.close();
    }
  });

  it('protects connection creation and dispatches only a strict, confirmed payload', async () => {
    const connect = vi.fn().mockResolvedValue({ enabled: true, connected: true, connectionId: 'connection-1', lists: [] });
    const { app, rateLimiter } = createBringApp({ service: { connect } as unknown as BringService });
    const payload = { email: 'a@example.com', password: 'synthetic-password', confirmExternalAccess: true };
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload,
      });
      const extra = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload: { ...payload, userId: 'attacker' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ enabled: true, connected: true, connectionId: 'connection-1', lists: [] });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(extra.statusCode).toBe(400);
      expect(extra.headers['cache-control']).toBe('no-store');
      expect(rateLimiter.enforce).toHaveBeenCalledWith('bringConnect', {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
      expect(rateLimiter.enforce).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith('user-a', { email: 'a@example.com', password: 'synthetic-password' });
    } finally {
      await app.close();
    }
  });

  it('rejects extra connection payload fields without rate limiting or dispatch', async () => {
    const connect = vi.fn();
    const { app, rateLimiter } = createBringApp({ service: { connect } as unknown as BringService });
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload: { email: 'a@example.com', password: 'synthetic-password', confirmExternalAccess: true, userId: 'attacker' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(rateLimiter.enforce).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed when connection rate limiting is unavailable', async () => {
    const connect = vi.fn();
    const { app } = createBringApp({
      service: { connect } as unknown as BringService,
      rateLimiterError: new AuthRateLimitError('rate_limit_unavailable', 503, 'Request limiting is temporarily unavailable'),
    });
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload: { email: 'a@example.com', password: 'synthetic-password', confirmExternalAccess: true },
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(bringEndpoints.filter((endpoint) => endpoint.name !== 'status'))('fails closed when the $name endpoint is disabled', async (endpoint) => {
    const { app, rateLimiter } = createBringApp();
    const headers: Record<string, string> = {
      cookie,
      ...(endpoint.mutating ? { origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' } : {}),
    };
    try {
      const response = await injectBringEndpoint(app, endpoint, headers);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'bring_disabled' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(rateLimiter.enforce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(bringEndpoints.filter((endpoint) => endpoint.name !== 'status'))('does not dispatch $name when Redis rate limiting fails', async (endpoint) => {
    const service = {
      status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), lists: vi.fn(), read: vi.fn(), write: vi.fn(), importList: vi.fn(),
    } as unknown as BringService;
    const { app, rateLimiter } = createBringApp({
      service,
      rateLimiterError: new AuthRateLimitError('rate_limit_unavailable', 503, 'Request limiting is temporarily unavailable'),
    });
    const headers: Record<string, string> = {
      cookie,
      ...(endpoint.mutating ? { origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' } : {}),
    };
    try {
      const response = await injectBringEndpoint(app, endpoint, headers);

      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      const expectedAction = endpoint.name === 'connect' ? 'bringConnect' : endpoint.mutating ? 'bringWrite' : 'bringRead';
      expect(rateLimiter.enforce).toHaveBeenCalledWith(expectedAction, {
        ip: expect.any(String), email: 'a@example.com', actorId: 'user-a',
      });
      expect(service.connect).not.toHaveBeenCalled();
      expect(service.disconnect).not.toHaveBeenCalled();
      expect(service.lists).not.toHaveBeenCalled();
      expect(service.read).not.toHaveBeenCalled();
      expect(service.write).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns retry-after for a Bring rate limit rejection', async () => {
    const connect = vi.fn();
    const { app } = createBringApp({
      service: { connect } as unknown as BringService,
      rateLimiterError: new AuthRateLimitError('rate_limited', 429, 'Too many requests', 900),
    });
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload: { email: 'a@example.com', password: 'synthetic-password', confirmExternalAccess: true },
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('900');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns disabled for status and rejects a disabled connection without rate limiting', async () => {
    const { app, rateLimiter } = createBringApp();
    try {
      const status = await app.inject({ method: 'GET', url: '/v1/integrations/bring', headers: { cookie } });
      const connect = await app.inject({
        method: 'POST', url: '/v1/integrations/bring/connection',
        headers: { cookie, origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
        payload: { email: 'a@example.com', password: 'synthetic-password', confirmExternalAccess: true },
      });

      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ enabled: false, connected: false, connectionId: null });
      expect(connect.statusCode).toBe(503);
      expect(connect.json()).toMatchObject({ code: 'bring_disabled' });
      expect(connect.headers['cache-control']).toBe('no-store');
      expect(rateLimiter.enforce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
