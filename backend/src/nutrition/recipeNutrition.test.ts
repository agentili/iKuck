import { describe, expect, it, vi } from 'vitest';
import type { NutritionProvider } from '../providers/types.js';
import { estimateRecipeNutrition } from './recipeNutrition.js';

const createProvider = (responses: Record<string, unknown>): NutritionProvider => ({
  lookup: vi.fn(async ({ query }) => responses[query] as Awaited<ReturnType<NutritionProvider['lookup']>>),
});

describe('recipe nutrition aggregation', () => {
  it('calls the provider once per ingredient and sums the nutrient values', async () => {
    const provider = createProvider({
      pasta: {
        source: 'usda', calories: 250, proteinGrams: 9, carbohydrateGrams: 50, fatGrams: 2,
        matchedFood: 'Pasta', isComplete: true, missingNutrients: [],
      },
      tomato: {
        source: 'usda', calories: 40, proteinGrams: 2, carbohydrateGrams: 8, fatGrams: 0,
        matchedFood: 'Tomato', isComplete: true, missingNutrients: [],
      },
    });

    await expect(estimateRecipeNutrition([
      { query: 'pasta', grams: 100 },
      { query: 'tomato', grams: 100 },
    ], provider)).resolves.toEqual({
      caloriesPerServing: 290,
      proteinGramsPerServing: 11,
      carbohydrateGramsPerServing: 58,
      fatGramsPerServing: 2,
      source: 'usda',
      isComplete: true,
      missingNutrients: [],
    });
    expect(provider.lookup).toHaveBeenCalledTimes(2);
  });

  it('keeps available totals and the union of missing nutrients when one response is incomplete', async () => {
    const provider = createProvider({
      beans: {
        source: 'usda', calories: 120, proteinGrams: 8, carbohydrateGrams: null, fatGrams: 1,
        matchedFood: 'Beans', isComplete: false, missingNutrients: ['carbohydrate'],
      },
      oil: {
        source: 'usda', calories: 90, proteinGrams: null, carbohydrateGrams: null, fatGrams: 10,
        matchedFood: 'Oil', isComplete: false, missingNutrients: ['protein', 'carbohydrate'],
      },
    });

    await expect(estimateRecipeNutrition([
      { query: 'beans', grams: 100 },
      { query: 'oil', grams: 10 },
    ], provider)).resolves.toEqual(expect.objectContaining({
      caloriesPerServing: 210,
      proteinGramsPerServing: 8,
      carbohydrateGramsPerServing: null,
      fatGramsPerServing: 11,
      source: 'usda',
      isComplete: false,
      missingNutrients: ['carbohydrate', 'protein'],
    }));
  });

  it('propagates provider failures without masking them as nutrition data', async () => {
    const provider: NutritionProvider = { lookup: vi.fn().mockRejectedValue(new Error('provider down')) };

    await expect(estimateRecipeNutrition([{ query: 'rice', grams: 100 }], provider)).rejects.toThrow('provider down');
  });
});
