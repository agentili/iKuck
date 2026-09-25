import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import type { NutritionProvider } from '../providers/types.js';

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

const nutritionProvider: NutritionProvider = {
  lookup: vi.fn(async ({ query }) => ({
    source: 'usda' as const,
    calories: query === 'pasta' ? 250 : 40,
    proteinGrams: query === 'pasta' ? 9 : 2,
    carbohydrateGrams: query === 'pasta' ? 50 : 8,
    fatGrams: query === 'pasta' ? 2 : 0,
    matchedFood: query,
    isComplete: true,
    missingNutrients: [],
  })),
};

const createNutritionApp = (provider: NutritionProvider = nutritionProvider) => createApp({
  database: { ping: async () => undefined },
  cache: { ping: async () => undefined },
  auth: { service: sessionService, appOrigin: 'http://127.0.0.1:5173', secureCookies: false },
  recipeNutrition: {
    provider,
    authService: sessionService,
    appOrigin: 'http://127.0.0.1:5173',
  },
});

const headers = {
  cookie: 'ikuck_session=session-token',
  origin: 'http://127.0.0.1:5173',
  'x-csrf-token': 'csrf-token',
};

describe('recipe nutrition route', () => {
  it('requires a verified session and returns an aggregated USDA estimate', async () => {
    const app = createNutritionApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/recipes/nutrition',
      headers,
      payload: { ingredients: [{ query: 'pasta', grams: 100 }, { query: 'tomato', grams: 100 }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ nutrition: {
      caloriesPerServing: 290,
      proteinGramsPerServing: 11,
      source: 'usda',
      isComplete: true,
    } });
    expect(nutritionProvider.lookup).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('rejects invalid payloads and missing CSRF', async () => {
    const app = createNutritionApp();
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/recipes/nutrition',
      headers,
      payload: { ingredients: [{ query: 'pasta', grams: 0 }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/v1/recipes/nutrition',
      headers: { cookie: headers.cookie, origin: headers.origin },
      payload: { ingredients: [{ query: 'pasta', grams: 100 }] },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ code: 'csrf_failed' });
    await app.close();
  });

  it('maps provider failures to a stable 503 response', async () => {
    const app = createNutritionApp({ lookup: vi.fn().mockRejectedValue(new Error('provider down')) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recipes/nutrition',
      headers,
      payload: { ingredients: [{ query: 'pasta', grams: 100 }] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'provider_unavailable' });
    await app.close();
  });
});
