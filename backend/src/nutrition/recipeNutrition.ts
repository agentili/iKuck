import type { RecipeNutrition } from '@ikuck/shared/contracts';
import type { NutritionProvider } from '../providers/types.js';

export interface RecipeNutritionLookup {
  query: string;
  grams: number | null;
}

const nutrientFields = [
  { estimate: 'calories', result: 'caloriesPerServing' },
  { estimate: 'proteinGrams', result: 'proteinGramsPerServing' },
  { estimate: 'carbohydrateGrams', result: 'carbohydrateGramsPerServing' },
  { estimate: 'fatGrams', result: 'fatGramsPerServing' },
] as const;

export const estimateRecipeNutrition = async (
  lookups: readonly RecipeNutritionLookup[],
  provider: NutritionProvider,
): Promise<RecipeNutrition> => {
  if (lookups.length === 0 || lookups.length > 30) throw new Error('Ingredient lookup count is invalid');

  const totals: Record<(typeof nutrientFields)[number]['result'], number | null> = {
    caloriesPerServing: null,
    proteinGramsPerServing: null,
    carbohydrateGramsPerServing: null,
    fatGramsPerServing: null,
  };
  const missingNutrients = new Set<string>();
  let everyResponseComplete = true;

  for (const lookup of lookups) {
    const estimate = await provider.lookup({
      query: lookup.query,
      ...(lookup.grams === null ? {} : { quantityGrams: lookup.grams }),
    });
    everyResponseComplete = everyResponseComplete && estimate.isComplete;
    for (const nutrient of estimate.missingNutrients) missingNutrients.add(nutrient);
    for (const field of nutrientFields) {
      const value = estimate[field.estimate];
      if (value === null) {
        missingNutrients.add(field.estimate === 'calories' ? 'calories' : field.estimate === 'proteinGrams' ? 'protein' : field.estimate === 'carbohydrateGrams' ? 'carbohydrate' : 'fat');
        continue;
      }
      totals[field.result] = (totals[field.result] ?? 0) + value;
    }
  }

  return {
    ...totals,
    source: 'usda',
    isComplete: everyResponseComplete && missingNutrients.size === 0,
    missingNutrients: [...missingNutrients],
  };
};
