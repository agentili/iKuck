import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const appOrigin = 'http://127.0.0.1:5173';

const createSessionService = (userId: string) => ({
  authenticate: async () => ({
    id: `session-${userId}`,
    userId,
    email: `${userId}@example.com`,
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService);

const probes = {
  database: { ping: async () => undefined },
  cache: { ping: async () => undefined },
};

const headers = { cookie: 'ikuck_session=session-token', origin: appOrigin };

describe('activity routes', () => {
  it('creates, reads, deletes and clears cooking events', async () => {
    const authService = createSessionService('user-1');
    const app = createApp({
      ...probes,
      auth: { service: authService, appOrigin, secureCookies: false },
      activity: { repository: createMemorySyncRepository(), authService, appOrigin },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/activity',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: {
        recipeId: 'recipe-1',
        recipeTitle: 'Pasta al pomodoro',
        servings: 2,
        cookedAt: '2026-09-13T12:00:00.000Z',
        note: 'Con poco sale',
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ event: { id: string } }>().event;

    const read = await app.inject({ method: 'GET', url: '/v1/activity', headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ events: [expect.objectContaining({
      id: created.id,
      recipeId: 'recipe-1',
      note: 'Con poco sale',
    })] });

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/activity/${encodeURIComponent(created.id)}`,
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
    });
    expect(remove.statusCode).toBe(204);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/activity',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: {
        recipeId: 'recipe-2',
        recipeTitle: 'Frittata',
        servings: 1,
        cookedAt: '2026-09-13T13:00:00.000Z',
        note: null,
      },
    });
    expect(second.statusCode).toBe(201);
    const clear = await app.inject({
      method: 'DELETE',
      url: '/v1/activity',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
    });
    expect(clear.statusCode).toBe(204);
    await expect(app.inject({ method: 'GET', url: '/v1/activity', headers })).resolves.toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ events: [] }),
    });
    await app.close();
  });

  it('rejects invalid events and state changes without CSRF', async () => {
    const authService = createSessionService('user-1');
    const app = createApp({
      ...probes,
      auth: { service: authService, appOrigin, secureCookies: false },
      activity: { repository: createMemorySyncRepository(), authService, appOrigin },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/activity',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: {
        recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 0,
        cookedAt: '2026-09-13T12:00:00.000Z', note: null,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/v1/activity',
      headers,
      payload: {
        recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 1,
        cookedAt: '2026-09-13T12:00:00.000Z', note: null,
      },
    });
    expect(missingCsrf.statusCode).toBe(403);
    await app.close();
  });

  it('does not expose events from another account', async () => {
    const repository = createMemorySyncRepository();
    const firstAuth = createSessionService('user-1');
    const firstApp = createApp({
      ...probes,
      auth: { service: firstAuth, appOrigin, secureCookies: false },
      activity: { repository, authService: firstAuth, appOrigin },
    });
    const create = await firstApp.inject({
      method: 'POST',
      url: '/v1/activity',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: {
        recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 1,
        cookedAt: '2026-09-13T12:00:00.000Z', note: null,
      },
    });
    expect(create.statusCode).toBe(201);
    await firstApp.close();

    const secondAuth = createSessionService('user-2');
    const secondApp = createApp({
      ...probes,
      auth: { service: secondAuth, appOrigin, secureCookies: false },
      activity: { repository, authService: secondAuth, appOrigin },
    });
    const read = await secondApp.inject({ method: 'GET', url: '/v1/activity', headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ events: [] });
    await secondApp.close();
  });
});
