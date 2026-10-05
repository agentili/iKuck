import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnection } from 'node:net';
import { createApp } from '../app.js';
import { createServerLoggerOptions } from '../serverLogging.js';
import { createS2sDinnerContextService, type DinnerContextSource, type ServiceGrant } from '../s2s/dinnerContext.js';

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));
const firstCredential = 'key_0123456789abcdef.' + 'a'.repeat(43);
const rotatedCredential = 'key_0123456789abcdef.' + 'b'.repeat(43);
const grant: ServiceGrant = { keyId: 'key_0123456789abcdef', digest: '', enabled: true, expiresAt: '2099-01-01T00:00:00.000Z', scope: 'dinner-context:read' };
const source: DinnerContextSource = { readAuthorizedSnapshot: async (credential) => {
  const [, secret] = credential.split('.');
  const authorized = [firstCredential, rotatedCredential].some((token) => createHash('sha256').update(token.split('.')[1]).digest('hex') === createHash('sha256').update(secret ?? '').digest('hex'));
  if (!authorized) return null;
  return { grant, pantryLots: [{ ingredientId: 'beans', label: 'Fagioli', known: true, quantity: 2, unit: 'pack', expiresAt: null, id: 'secret-lot', createdAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-04T10:00:00.000Z' }], dietProfile: null };
} };
const setup = (overrides: { enabled?: boolean; rateLimiter?: { allow(key: string): Promise<boolean> } } = {}) => {
  const service = createS2sDinnerContextService({ enabled: overrides.enabled ?? true, source, clock: () => new Date('2026-10-04T10:00:00.000Z'), rateLimiter: overrides.rateLimiter ?? { allow: async () => true } });
  const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app); return app;
};

describe('S2S unmatched routes', () => {
  it('returns a minimal no-store 404 for unmatched paths with or without the feature wired', async () => {
    const absent = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined } }); apps.push(absent);
    const enabled = setup();
    const disabled = setup({ enabled: false });
    const sentinel = 's2s-url-reflection-sentinel';

    for (const app of [absent, enabled, disabled]) {
      const url = `/v1/s2s/unmatched/${sentinel}?token=${sentinel}`;
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(404);
      expect(response.body).toBe('{"code":"not_found"}');
      expect(response.body).not.toContain(url);
      expect(response.body).not.toContain(sentinel);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('preserves the default response for unrelated unmatched routes', async () => {
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined } }); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/unmatched-elsewhere' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      message: 'Route GET:/unmatched-elsewhere not found',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(response.headers['cache-control']).toBeUndefined();
  });
});

describe('GET /v1/s2s/dinner-context', () => {
  it('is unavailable unless explicitly wired and enabled', async () => {
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context' })).statusCode).toBe(404);
    const disabled = setup({ enabled: false });
    expect((await disabled.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: 'Bearer key_0123456789abcdef.' + 'a'.repeat(43) } })).statusCode).toBe(404);
  });
  it('charges the IP once, then limits the presented token and authenticated credential separately', async () => {
    const calls: Array<{ key: string | null; includeIp?: boolean; bucket?: string }> = [];
    const service = createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async (key, _ip, options) => { calls.push({ key, includeIp: options?.includeIp, bucket: options?.bucket }); return true; } } });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: 'Bearer ' + firstCredential } });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      { key: null, includeIp: undefined, bucket: undefined },
      { key: firstCredential, includeIp: false, bucket: 'presented' },
      { key: 'key_0123456789abcdef', includeIp: false, bucket: 'credential' },
    ]);
  });

  it('starts the request deadline before waiting for the request body', async () => {
    const service = createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async () => true }, requestTimeoutMs: 30 });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    const lineEnding = String.fromCharCode(13, 10);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const chunks: string[] = [];
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('request deadline did not return a response')); }, 1000);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(['POST /v1/s2s/dinner-context HTTP/1.1', 'Host: 127.0.0.1', `Authorization: Bearer ${firstCredential}`, 'Content-Type: application/json', 'Content-Length: 4', 'Connection: close', '', ''].join(lineEnding)));
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('end', () => { clearTimeout(timeout); resolve(chunks.join('')); });
      socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
      socket.on('close', () => clearTimeout(timeout));
    });
    expect(response.split(lineEnding, 1)[0], response).toMatch(/ 503 /);
  });
  it('aborts active source work when a completed GET client disconnects', async () => {
    let markSourceStarted!: () => void;
    let markSourceAborted!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { markSourceStarted = resolve; });
    const sourceAborted = new Promise<void>((resolve) => { markSourceAborted = resolve; });
    const pendingSource: DinnerContextSource = {
      readAuthorizedSnapshot: async (_credential, options) => {
        markSourceStarted();
        return new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          const abort = () => { markSourceAborted(); reject(new Error('client disconnected')); };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      },
    };
    const service = createS2sDinnerContextService({ enabled: true, source: pendingSource, rateLimiter: { allow: async () => true }, requestTimeoutMs: 5000 });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    const lineEnding = String.fromCharCode(13, 10);
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          socket.write(['GET /v1/s2s/dinner-context HTTP/1.1', 'Host: 127.0.0.1', `Authorization: Bearer ${firstCredential}`, 'Connection: close', '', ''].join(lineEnding));
          resolve();
        });
        socket.once('error', reject);
      });
      await Promise.race([sourceStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('source did not start')), 1000))]);
      socket.destroy();
      await Promise.race([sourceAborted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('source was not aborted after disconnect')), 1000))]);
    } finally {
      socket.destroy();
    }
  });

  it('does not abort source work after a normal response finishes and closes', async () => {
    let sourceSignal: AbortSignal | undefined;
    const completedResponseSource: DinnerContextSource = {
      readAuthorizedSnapshot: async (_credential, options) => {
        sourceSignal = options?.signal;
        return { grant, pantryLots: [], dietProfile: null };
      },
    };
    const service = createS2sDinnerContextService({ enabled: true, source: completedResponseSource, rateLimiter: { allow: async () => true }, requestTimeoutMs: 5000 });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    const lineEnding = String.fromCharCode(13, 10);
    const socket = createConnection({ host: '127.0.0.1', port });
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const chunks: string[] = [];
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error('completed response did not close')); }, 1000);
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write([
          'GET /v1/s2s/dinner-context HTTP/1.1',
          'Host: 127.0.0.1',
          `Authorization: Bearer ${firstCredential}`,
          'Connection: close',
          '',
          '',
        ].join(lineEnding)));
        socket.on('data', (chunk: string) => chunks.push(chunk));
        socket.on('close', () => { clearTimeout(timeout); resolve(chunks.join('')); });
        socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
      });
      expect(response.split(lineEnding, 1)[0], response).toMatch(/ 200 /);
      expect(sourceSignal).toBeDefined();
      expect(sourceSignal?.aborted).toBe(false);
    } finally {
      socket.destroy();
    }
  });

  it('cancels a pending IP preflight when the client disconnects', async () => {
    let markLimiterStarted!: () => void;
    let markPreflightReturned!: () => void;
    const limiterStarted = new Promise<void>((resolve) => { markLimiterStarted = resolve; });
    const preflightReturned = new Promise<void>((resolve) => { markPreflightReturned = resolve; });
    const service = createS2sDinnerContextService({
      enabled: true,
      source,
      rateLimiter: { allow: async () => { markLimiterStarted(); return new Promise<boolean>(() => undefined); } },
      requestTimeoutMs: 2000,
    });
    const originalBeginRequest = service.beginRequest.bind(service);
    service.beginRequest = async (...args) => {
      try { return await originalBeginRequest(...args); }
      finally { markPreflightReturned(); }
    };
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    const lineEnding = String.fromCharCode(13, 10);
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          socket.write(['GET /v1/s2s/dinner-context HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close', '', ''].join(lineEnding));
          resolve();
        });
        socket.once('error', reject);
      });
      await limiterStarted;
      socket.destroy();
      let completedPromptly = false;
      await Promise.race([preflightReturned.then(() => { completedPromptly = true; }), new Promise<void>((resolve) => setTimeout(resolve, 250))]);
      expect(completedPromptly).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it('rejects duplicate Authorization fields over HTTP after charging only the IP limit', async () => {
    let rateLimitChecks = 0;
    const rateLimitKeys: Array<string | null> = [];
    const service = createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async (key) => { rateLimitChecks += 1; rateLimitKeys.push(key); return true; } } });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    const lineEnding = String.fromCharCode(13, 10);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const chunks: string[] = [];
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write([
        'GET /v1/s2s/dinner-context HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${firstCredential}`,
        `Authorization: Bearer ${rotatedCredential}`,
        'Connection: close',
        '',
        '',
      ].join(lineEnding)));
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('end', () => resolve(chunks.join('')));
      socket.on('error', reject);
    });
    expect(response.split(lineEnding, 1)[0]).toMatch(/ 400 /);
    expect(response).toContain('{"code":"invalid_request"}');
    expect(rateLimitChecks).toBe(1);
    expect(rateLimitKeys).toEqual([null]);
  });

  it('does not log rejected S2S query-string credentials', async () => {
    const logs: string[] = [];
    const app = createApp(
      { database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async () => true } }) },
      { logger: createServerLoggerOptions('info', { write: (message: string) => logs.push(message) }) },
    );
    apps.push(app);
    const querySecret = 's2s-query-secret-for-log-test';
    const hostSecret = 's2s-query-host-secret-for-log-test.example';
    const response = await app.inject({ method: 'GET', url: `/v1/s2s/dinner-context?token=${querySecret}`, headers: { host: hostSecret } });
    expect(response.statusCode).toBe(400);
    expect(logs.join('')).toContain('/v1/s2s/dinner-context');
    expect(logs.join('')).not.toContain(querySecret);
    expect(logs.join('')).not.toContain(hostSecret);
  });

  it('logs successful authenticated S2S access using the route template without credentials or untrusted Host', async () => {
    const logs: string[] = [];
    const app = createApp(
      { database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async () => true } }) },
      { logger: createServerLoggerOptions('info', { write: (message: string) => logs.push(message) }) },
    );
    apps.push(app);
    const hostSecret = 'untrusted-s2s-host-for-log-test.example';
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    const lineEnding = String.fromCharCode(13, 10);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const chunks: string[] = [];
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write([
        'GET /v1/s2s/dinner-context HTTP/1.1',
        `Host: ${hostSecret}`,
        `Authorization: Bearer ${firstCredential}`,
        'Connection: close',
        '',
        '',
      ].join(lineEnding)));
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('end', () => resolve(chunks.join('')));
      socket.on('error', reject);
    });
    expect(response.split(lineEnding, 1)[0]).toMatch(/ 200 /);

    const entries = logs.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { reqId?: string; req?: { method?: string; url?: string; remoteAddress?: string; remotePort?: number }; res?: { statusCode?: number } });
    const requestEntry = entries.find((entry) => entry.req?.url === '/v1/s2s/dinner-context');
    expect(requestEntry).toBeDefined();
    expect(requestEntry?.req).toMatchObject({ method: 'GET', url: '/v1/s2s/dinner-context' });
    expect(requestEntry?.req).not.toHaveProperty('remoteAddress');
    expect(requestEntry?.req).not.toHaveProperty('remotePort');
    expect(entries.some((entry) => entry.reqId === requestEntry?.reqId && entry.res?.statusCode === 200)).toBe(true);
    expect(logs.join('')).not.toContain(firstCredential);
    expect(logs.join('')).not.toContain(hostSecret);
  });

  it('does not log untrusted Host values or raw S2S-like paths', async () => {
    const logs: string[] = [];
    const app = createApp(
      { database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async () => true } }) },
      { logger: createServerLoggerOptions('info', { write: (message: string) => logs.push(message) }) },
    );
    apps.push(app);
    const pathSecret = 's2s-path-secret-for-log-test';
    const hostSecret = 's2s-host-secret-for-log-test.example';
    await app.inject({
      method: 'GET',
      url: `/v1/s2s/dinner-context/${pathSecret}`,
      headers: { host: hostSecret },
    });
    expect(logs.join('')).not.toContain(pathSecret);
    expect(logs.join('')).not.toContain(hostSecret);
  });

  it('rejects malformed credentials before consulting the source', async () => {
    let reads = 0;
    const service = createS2sDinnerContextService({ enabled: true, source: { readAuthorizedSnapshot: async () => { reads += 1; return null; } }, rateLimiter: { allow: async () => true } });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: 'Bearer malformed' } });
    expect(response.statusCode).toBe(401);
    expect(reads).toBe(0);
  });
  it('returns an allowlisted, minimized snapshot from the authorized reader', async () => {
    const app = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: 'Bearer key_0123456789abcdef.' + 'a'.repeat(43) } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, retrievedAt: '2026-10-04T10:00:00.000Z', pantry: { lots: [{ ingredientId: 'beans', label: 'Fagioli', known: true, quantity: 2, unit: 'pack', expiresAt: null }] }, dietaryConstraints: { status: 'not_configured' } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toContain('Authorization');
  });
  it.each([undefined, 'Basic abc', 'Bearer bad', 'Bearer key_0123456789abcdef.' + 'A'.repeat(43)])('denies absent or invalid service credentials: %s', async (authorization) => {
    const app = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', ...(authorization ? { headers: { authorization } } : {}) });
    expect(response.statusCode).toBe(401); expect(response.json()).toEqual({ code: 'service_auth_required' });
  });
  it('rejects GET bodies from HTTP framing even when Fastify does not expose a parsed body', async () => {
    const app = setup();
    const headers = { authorization: 'Bearer ' + firstCredential, 'content-type': 'application/json' };
    for (const payload of ['{}', '{bad']) {
      const response = await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: 'invalid_request' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('charges the IP bucket before malformed bodies reach the parser', async () => {
    let checks = 0;
    const app = setup({ rateLimiter: { allow: async () => { checks += 1; return true; } } });
    const response = await app.inject({ method: 'POST', url: '/v1/s2s/dinner-context', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'invalid_request' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(checks).toBe(1);
  });

  it('normalizes unsupported media-type parser errors to a minimal S2S response', async () => {
    const app = setup();
    const response = await app.inject({ method: 'POST', url: '/v1/s2s/dinner-context', headers: { 'content-type': 'application/xml' }, payload: '<token />' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'invalid_request' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('normalizes oversized S2S payload errors without exposing parser details', async () => {
    const app = setup();
    const response = await app.inject({ method: 'POST', url: '/v1/s2s/dinner-context', headers: { 'content-type': 'application/json' }, payload: `"${'x'.repeat(1024 * 1024 + 1)}"` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'invalid_request' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects duplicate authorization, browser credentials, selectors, query, body and non-GET methods', async () => {
    const app = setup(); const bearer = 'Bearer key_0123456789abcdef.' + 'a'.repeat(43);
    for (const headers of [{ authorization: [bearer, bearer] }, { authorization: bearer, cookie: 'ikuck_session=anything' }, { authorization: bearer, 'x-house-id': 'other' }, { authorization: bearer, 'x-user-id': 'other' }]) {
      expect((await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: headers as never })).statusCode).not.toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context?houseId=other', headers: { authorization: bearer } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/s2s/dinner-context', headers: { authorization: bearer }, payload: {} })).statusCode).toBe(405);
  });
  it('fails closed when rate limiting is unavailable or denies, with Retry-After on 429', async () => {
    const denied = setup({ rateLimiter: { allow: async () => false } });
    const response = await denied.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: 'Bearer key_0123456789abcdef.' + 'a'.repeat(43) } });
    expect(response.statusCode).toBe(429); expect(response.headers['retry-after']).toBe('60');
    const unavailable = setup({ rateLimiter: { allow: async () => { throw new Error('offline'); } } });
    expect((await unavailable.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: 'Bearer key_0123456789abcdef.' + 'a'.repeat(43) } })).statusCode).toBe(503);
  });

  it('returns unavailable for corrupted repository data instead of not_configured', async () => {
    const corruptedSource: DinnerContextSource = { readAuthorizedSnapshot: async () => { throw Object.assign(new Error('corrupt diet profile'), { code: 'service_integrity_error' }); } };
    const service = createS2sDinnerContextService({ enabled: true, source: corruptedSource, rateLimiter: { allow: async () => true } });
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context', headers: { authorization: 'Bearer ' + firstCredential } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'service_unavailable' });
  });

  it('maps unexpected S2S failures to a minimal unavailable response', async () => {
    const service = createS2sDinnerContextService({ enabled: true, source, rateLimiter: { allow: async () => true } });
    service.beginRequest = async () => { throw new Error('sensitive backend failure detail'); };
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, s2sDinnerContext: service }); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/v1/s2s/dinner-context' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'service_unavailable' });
    expect(response.body).not.toContain('sensitive backend failure detail');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('fails closed on source timeout and malformed snapshot rows', async () => {
    const token = 'Bearer key_0123456789abcdef.' + 'a'.repeat(43);
    const timed = createS2sDinnerContextService({ enabled: true, source: { readAuthorizedSnapshot: () => new Promise(() => undefined) }, rateLimiter: { allow: async () => true }, requestTimeoutMs: 1 });
    expect((await timed.read(token, false, false, false, false, '127.0.0.1')).status).toBe(503);
    const invalid = createS2sDinnerContextService({ enabled: true, source: { readAuthorizedSnapshot: async () => ({ grant, pantryLots: [{ ingredientId: 'bad', label: '', known: true, quantity: 1, unit: 'g', expiresAt: null, id: 'row', createdAt: 'bad', updatedAt: 'bad' } as never], dietProfile: null }) }, rateLimiter: { allow: async () => true } });
    expect((await invalid.read(token, false, false, false, false, '127.0.0.1')).status).toBe(503);
  });
});
