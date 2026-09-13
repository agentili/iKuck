import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const sessionService = {
  authenticate: async () => ({
    id: 'session-1',
    userId: 'user-1',
    email: 'user@example.com',
    csrfTokenHash: hashOpaqueToken('csrf-token'),
    expiresAt: new Date('2026-10-12T12:00:00.000Z'),
  }),
} as unknown as AuthService;

const createDietProfileApp = () => {
  const repository = createMemorySyncRepository();
  const app = createApp({
    database: { ping: async () => undefined },
    cache: { ping: async () => undefined },
    auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
    dietProfile: { repository, authService: sessionService, appOrigin: 'http://127.0.0.1:5173' },
  });
  return { app, repository };
};

const headers = {
  cookie: 'ikuck_session=session-token',
  origin: 'http://127.0.0.1:5173',
  'x-csrf-token': 'csrf-token',
};

describe('diet profile routes', () => {
  it('returns a default profile and stores the authenticated account profile', async () => {
    const { app, repository } = createDietProfileApp();

    const initial = await app.inject({ method: 'GET', url: '/v1/profile/preferences', headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      profile: {
        diet: 'omnivore',
        excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      },
    });

    const update = await app.inject({
      method: 'PUT',
      url: '/v1/profile/preferences',
      headers,
      payload: {
        diet: 'vegan',
        excludedAllergens: ['fish', 'milk'],
        nutrition: { maxCaloriesPerServing: 700, minProteinGramsPerServing: 20 },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ profile: {
      diet: 'vegan',
      excludedAllergens: ['fish', 'milk'],
      nutrition: { maxCaloriesPerServing: 700, minProteinGramsPerServing: 20 },
    } });

    const stored = await repository.readEntity('user-1', 'diet_profile', 'profile');
    expect(stored).toMatchObject({ entityId: 'profile', deleted: false, payload: expect.objectContaining({ diet: 'vegan' }) });
    await expect(repository.readEntity('user-2', 'diet_profile', 'profile')).resolves.toBeNull();

    const current = await app.inject({ method: 'GET', url: '/v1/profile/preferences', headers });
    expect(current.json()).toMatchObject({ profile: { diet: 'vegan' } });
    await app.close();
  });

  it('rejects invalid data, foreign origins and invalid CSRF tokens', async () => {
    const { app } = createDietProfileApp();

    const invalid = await app.inject({
      method: 'PUT',
      url: '/v1/profile/preferences',
      headers,
      payload: {
        diet: 'vegan',
        excludedAllergens: ['fish', 'fish'],
        nutrition: { maxCaloriesPerServing: -1, minProteinGramsPerServing: null },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });

    const foreignOrigin = await app.inject({
      method: 'PUT',
      url: '/v1/profile/preferences',
      headers: { ...headers, origin: 'https://attacker.example' },
      payload: { diet: 'vegan', excludedAllergens: [], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null } },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({ code: 'csrf_failed' });

    const invalidCsrf = await app.inject({
      method: 'PUT',
      url: '/v1/profile/preferences',
      headers: { ...headers, 'x-csrf-token': 'wrong-token' },
      payload: { diet: 'vegan', excludedAllergens: [], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null } },
    });
    expect(invalidCsrf.statusCode).toBe(403);
    expect(invalidCsrf.json()).toMatchObject({ code: 'csrf_failed' });
    await app.close();
  });
});
