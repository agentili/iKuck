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
    emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService);

const probes = {
  database: { ping: async () => undefined },
  cache: { ping: async () => undefined },
};

const headers = { cookie: 'ikuck_session=session-token', origin: appOrigin };

describe('recipe preference routes', () => {
  it('creates, replaces, reads and deletes a private preference', async () => {
    const authService = createSessionService('user-1');
    const app = createApp({
      ...probes,
      auth: { service: authService, appOrigin, secureCookies: false },
      recipePreferences: { repository: createMemorySyncRepository(), authService, appOrigin },
    });

    const save = await app.inject({
      method: 'PUT',
      url: '/v1/recipes/preferences/recipe-1',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: { recipeId: 'recipe-1', favorite: true, rating: 5, note: 'Da rifare' },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ preference: {
      recipeId: 'recipe-1', favorite: true, rating: 5, note: 'Da rifare',
    } });

    const replace = await app.inject({
      method: 'PUT',
      url: '/v1/recipes/preferences/recipe-1',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: { recipeId: 'recipe-1', favorite: false, rating: 4, note: null },
    });
    expect(replace.statusCode).toBe(200);
    expect(replace.json()).toMatchObject({ preference: { favorite: false, rating: 4, note: null } });

    const read = await app.inject({ method: 'GET', url: '/v1/recipes/preferences', headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ preferences: [expect.objectContaining({ recipeId: 'recipe-1', rating: 4 })] });

    const remove = await app.inject({
      method: 'DELETE',
      url: '/v1/recipes/preferences/recipe-1',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
    });
    expect(remove.statusCode).toBe(204);
    await expect(app.inject({ method: 'GET', url: '/v1/recipes/preferences', headers })).resolves.toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ preferences: [] }),
    });
    await app.close();
  });

  it('rejects invalid preferences, mismatched ids and missing CSRF', async () => {
    const authService = createSessionService('user-1');
    const app = createApp({
      ...probes,
      auth: { service: authService, appOrigin, secureCookies: false },
      recipePreferences: { repository: createMemorySyncRepository(), authService, appOrigin },
    });

    const invalid = await app.inject({
      method: 'PUT',
      url: '/v1/recipes/preferences/recipe-1',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: { recipeId: 'recipe-1', favorite: false, rating: 6, note: null },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });

    const mismatch = await app.inject({
      method: 'PUT',
      url: '/v1/recipes/preferences/recipe-1',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: { recipeId: 'recipe-2', favorite: true, rating: null, note: null },
    });
    expect(mismatch.statusCode).toBe(400);

    const missingCsrf = await app.inject({
      method: 'PUT',
      url: '/v1/recipes/preferences/recipe-1',
      headers,
      payload: { recipeId: 'recipe-1', favorite: true, rating: null, note: null },
    });
    expect(missingCsrf.statusCode).toBe(403);
    await app.close();
  });

  it('removes an empty preference instead of storing a meaningless record', async () => {
    const authService = createSessionService('user-1');
    const app = createApp({
      ...probes,
      auth: { service: authService, appOrigin, secureCookies: false },
      recipePreferences: { repository: createMemorySyncRepository(), authService, appOrigin },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/recipes/preferences/recipe-1',
      headers: { ...headers, 'x-csrf-token': 'csrf-token' },
      payload: { recipeId: 'recipe-1', favorite: false, rating: null, note: null },
    });
    expect(response.statusCode).toBe(204);
    await app.close();
  });
});
