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

describe('shopping list routes', () => {
  it('creates, reads, updates and deletes an authenticated item', async () => {
    const authService = createSessionService('user-1');
    const app = createApp({
      ...probes,
      auth: { service: authService, appOrigin, secureCookies: false },
      shoppingList: { repository: createMemorySyncRepository(), authService, appOrigin },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/shopping-list',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: {
        ingredientId: 'pasta',
        label: 'Pasta',
        quantity: null,
        unit: null,
        note: null,
        purchased: false,
        sourceRecipeId: null,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ item: { id: string } }>().item;

    const read = await app.inject({ method: 'GET', url: '/v1/shopping-list', headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ items: [expect.objectContaining({ id: created.id, purchased: false })] });

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/shopping-list/${encodeURIComponent(created.id)}`,
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: { quantity: 2, unit: 'piece', purchased: true },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ item: { id: created.id, quantity: 2, unit: 'piece', purchased: true } });

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/shopping-list/${encodeURIComponent(created.id)}`,
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
    });
    expect(remove.statusCode).toBe(204);
    await app.close();
  });

  it('rejects invalid details and state-changing requests without CSRF', async () => {
    const authService = createSessionService('user-1');
    const app = createApp({
      ...probes,
      auth: { service: authService, appOrigin, secureCookies: false },
      shoppingList: { repository: createMemorySyncRepository(), authService, appOrigin },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/shopping-list',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: {
        ingredientId: 'pasta', label: 'Pasta', quantity: 10, unit: null, note: null, purchased: false, sourceRecipeId: null,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/v1/shopping-list',
      headers,
      payload: {
        ingredientId: 'pasta', label: 'Pasta', quantity: null, unit: null, note: null, purchased: false, sourceRecipeId: null,
      },
    });
    expect(missingCsrf.statusCode).toBe(403);
    await app.close();
  });

  it('scopes items to the authenticated account', async () => {
    const repository = createMemorySyncRepository();
    const firstAuth = createSessionService('user-1');
    const firstApp = createApp({
      ...probes,
      auth: { service: firstAuth, appOrigin, secureCookies: false },
      shoppingList: { repository, authService: firstAuth, appOrigin },
    });
    const create = await firstApp.inject({
      method: 'POST',
      url: '/v1/shopping-list',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: {
        ingredientId: 'pasta', label: 'Pasta', quantity: null, unit: null, note: null, purchased: false, sourceRecipeId: null,
      },
    });
    expect(create.statusCode).toBe(201);
    await firstApp.close();

    const secondAuth = createSessionService('user-2');
    const secondApp = createApp({
      ...probes,
      auth: { service: secondAuth, appOrigin, secureCookies: false },
      shoppingList: { repository, authService: secondAuth, appOrigin },
    });
    const read = await secondApp.inject({ method: 'GET', url: '/v1/shopping-list', headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ items: [] });
    await secondApp.close();
  });
});
