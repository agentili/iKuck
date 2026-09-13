import { describe, expect, it, vi } from 'vitest';
import { createUsdaNutritionProvider } from './usda.js';

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('USDA nutrition provider', () => {
  it('searches one food and scales nutrient values to the requested grams', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      foods: [{
        description: 'Tomato, red, ripe',
        foodNutrients: [
          { nutrientId: 1008, value: 18 },
          { nutrientId: 1003, value: 0.9 },
          { nutrientId: 1005, value: 3.9 },
          { nutrientId: 1004, value: 0.2 },
        ],
      }],
    }));
    const provider = createUsdaNutritionProvider({ apiKey: 'test-key', fetch });

    await expect(provider.lookup({ query: 'tomato', quantityGrams: 200 })).resolves.toEqual({
      source: 'usda',
      calories: 36,
      proteinGrams: 1.8,
      carbohydrateGrams: 7.8,
      fatGrams: 0.4,
      matchedFood: 'Tomato, red, ripe',
      isComplete: true,
      missingNutrients: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/foods/search');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('pageSize=1');
  });

  it('marks absent required nutrients as incomplete', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      foods: [{ description: 'Rice', foodNutrients: [{ nutrientId: 1008, value: 130 }] }],
    }));
    const provider = createUsdaNutritionProvider({ apiKey: 'test-key', fetch });

    await expect(provider.lookup({ query: 'rice' })).resolves.toMatchObject({
      calories: 130,
      proteinGrams: null,
      carbohydrateGrams: null,
      fatGrams: null,
      isComplete: false,
      missingNutrients: ['protein', 'carbohydrate', 'fat'],
    });
  });

  it('raises a typed provider error for non-success and malformed responses', async () => {
    const failedFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}, 503));
    const provider = createUsdaNutritionProvider({ apiKey: 'test-key', fetch: failedFetch });
    await expect(provider.lookup({ query: 'rice' })).rejects.toMatchObject({ code: 'provider_error', provider: 'nutrition' });

    const malformedFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ foods: [] }));
    const malformedProvider = createUsdaNutritionProvider({ apiKey: 'test-key', fetch: malformedFetch });
    await expect(malformedProvider.lookup({ query: 'rice' })).rejects.toMatchObject({ code: 'provider_error', provider: 'nutrition' });
  });
});
