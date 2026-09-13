import { describe, expect, it } from 'vitest';
import { RECIPES } from '../recipes';
import { getRecipeMetadata, RECIPE_METADATA } from '../recipeMetadata';

describe('curated recipe metadata', () => {
  it('has compatibility and nutrition metadata for every curated recipe', () => {
    expect(Object.keys(RECIPE_METADATA)).toHaveLength(RECIPES.length);
    for (const recipe of RECIPES) {
      const metadata = getRecipeMetadata(recipe.id);
      expect(metadata).toBeDefined();
      expect(metadata?.diets.length).toBeGreaterThan(0);
      expect(metadata?.nutrition.caloriesPerServing).toBeGreaterThan(0);
      expect(metadata?.nutrition.proteinGramsPerServing).toBeGreaterThanOrEqual(0);
      expect(metadata?.nutrition.source).toBe('catalog_estimate');
      expect(metadata?.nutrition.isComplete).toBe(false);
    }
  });

  it('declares the blocking allergens for representative recipes', () => {
    expect(getRecipeMetadata('pasta-tonno-pomodoro')?.allergens).toEqual(expect.arrayContaining(['gluten', 'fish']));
    expect(getRecipeMetadata('frittata-zucchine')?.allergens).toEqual(expect.arrayContaining(['eggs', 'milk']));
    expect(getRecipeMetadata('lenticchie-in-umido')?.allergens).toEqual(expect.arrayContaining(['celery']));
  });
});
