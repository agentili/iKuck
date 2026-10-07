import { afterEach, describe, expect, it } from 'vitest';
import { hashOpaqueToken } from './auth/tokens.js';
import type { AuthService } from './auth/service.js';
import type { BringService } from './bring/service.js';
import { createApp } from './app.js';
import { createServerLoggerOptions } from './serverLogging.js';

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('server request logging', () => {
  it('redacts Bring credentials and ciphertext and omits query strings and headers', async () => {
    const logs: string[] = [];
    const app = createApp(
      { database: { ping: async () => undefined }, cache: { ping: async () => undefined } },
      { logger: createServerLoggerOptions('info', { write: (message: string) => logs.push(message) }) },
    );
    apps.push(app);
    app.post('/v1/integrations/bring/connection', async (request) => {
      app.log.info({
        req: request,
        body: request.body,
        bring: { encryptedSession: 'synthetic-bring-ciphertext-log-test' },
      }, 'Synthetic Bring request');
      return { connected: true };
    });

    const secrets = [
      'synthetic-bring-email-log-test@example.invalid',
      'synthetic-bring-password-log-test',
      'synthetic-bring-access-token-log-test',
      'synthetic-bring-refresh-token-log-test',
      'synthetic-bring-ciphertext-log-test',
      'synthetic-bring-query-token-log-test',
      'synthetic-bring-header-token-log-test',
      'synthetic-bring-cookie-log-test',
      'synthetic-bring-authorization-log-test',
    ];
    const response = await app.inject({
      method: 'POST',
      url: `/v1/integrations/bring/connection?token=${secrets[5]}`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secrets[8]}`,
        cookie: `bring_session=${secrets[7]}`,
        'x-bring-access-token': secrets[6]!,
      },
      payload: {
        email: secrets[0],
        password: secrets[1],
        accessToken: secrets[2],
        refreshToken: secrets[3],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(logs.join('')).toContain('/v1/integrations/bring/connection');
    for (const secret of secrets) expect(logs.join('')).not.toContain(secret);
  });

  it('does not log a failed Bring request body or upstream error cause', async () => {
    const logs: string[] = [];
    const email = 'synthetic-bring-failure@example.invalid';
    const password = 'synthetic-bring-failure-password';
    const errorMessage = 'synthetic-bring-upstream-error-message';
    const errorCause = 'synthetic-bring-upstream-error-cause';
    const errorBody = 'synthetic-bring-upstream-error-body';
    const authService = {
      authenticate: async () => ({
        id: 'session-a',
        userId: 'user-a',
        email: 'user@example.invalid',
        emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
        csrfTokenHash: hashOpaqueToken('synthetic-csrf'),
        expiresAt: new Date('2026-10-12T12:00:00.000Z'),
      }),
    } as unknown as AuthService;
    const upstreamFailure = Object.assign(new Error(errorMessage), {
      cause: new Error(errorCause),
      body: errorBody,
    });
    const service = { connect: async () => { throw upstreamFailure; } } as unknown as BringService;
    const appOrigin = 'http://127.0.0.1:5173';
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      bring: { service, authService, appOrigin, rateLimiter: { enforce: async () => undefined } },
    }, { logger: createServerLoggerOptions('info', { write: (message: string) => logs.push(message) }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/integrations/bring/connection',
      headers: { cookie: 'ikuck_session=synthetic-session', origin: appOrigin, 'x-csrf-token': 'synthetic-csrf' },
      payload: { email, password, confirmExternalAccess: true },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'internal_error', message: 'Internal server error' });
    for (const secret of [email, password, errorMessage, errorCause, errorBody]) {
      expect(logs.join('')).not.toContain(secret);
    }
  });
});
