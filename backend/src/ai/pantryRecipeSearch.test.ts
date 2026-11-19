import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_RECIPE_MAX_GENERATION_INGREDIENTS } from '@ikuck/shared/limits';
import type { RecipeReference } from './recipeNovelty.js';

const noveltyHarness = vi.hoisted(() => ({
  calls: [] as string[][],
  allowedSingleton: null as string | null,
}));

vi.mock('./recipeNovelty.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recipeNovelty.js')>();
  return {
    ...actual,
    findRecipeNoveltyConflict: (candidate: RecipeReference) => {
      const names = candidate.ingredients.map(({ name }) => name);
      noveltyHarness.calls.push(names);
      if (names.length === 1 && names[0] === noveltyHarness.allowedSingleton) return null;
      return { reason: 'too_similar' as const, title: 'Ricetta esistente', ingredientDifference: 0 };
    },
  };
});

import { evaluatePantryRecipeDraft } from './pantryRecipe.js';

const pantry = [
  'Acqua', 'Sale', 'Pepe', 'Riso', 'Ceci', 'Lenticchie', 'Piselli', 'Limone', 'Rucola',
  'Pomodoro', 'Pomodorini', 'Olive', 'Zucchine', 'Peperoni', 'Spinaci', 'Melanzane',
  'Carote', 'Sedano', 'Cipolla', 'Aglio', 'Prezzemolo', 'Basilico', 'Patate', 'Pollo',
  'Tacchino', 'Manzo', 'Tonno', 'Merluzzo', 'Salmone', 'Uova', 'Orata',
];

beforeEach(() => {
  noveltyHarness.calls.length = 0;
  noveltyHarness.allowedSingleton = null;
});

describe('bounded pantry recipe search', () => {
  it('tries a late singleton after the multingredient novelty candidates conflict', () => {
    noveltyHarness.allowedSingleton = 'Orata';

    const result = evaluatePantryRecipeDraft(pantry, [], () => 0.999999);

    expect(result.recipe?.ingredients).toEqual([{ name: 'Orata', amount: 'q.b.' }]);
    expect(noveltyHarness.calls).toContainEqual(['Orata']);
  });

  it('tries every eligible singleton exactly once within the finite search budget', () => {
    const fullPantry = Array.from(
      { length: AI_RECIPE_MAX_GENERATION_INGREDIENTS },
      (_value, index) => pantry[index % pantry.length]!,
    );
    const uniqueIngredients = [...new Set(pantry)];
    const result = evaluatePantryRecipeDraft(fullPantry, [], () => 0.999999);
    const singletonCalls = noveltyHarness.calls.filter((names) => names.length === 1).map(([name]) => name);

    expect(result.recipe).toBeNull();
    expect(result.ingredientReview.consideredIngredients).toEqual(fullPantry);
    expect(singletonCalls).toEqual(uniqueIngredients);
    expect(new Set(noveltyHarness.calls.map((names) => JSON.stringify([...names].sort()))).size)
      .toBe(noveltyHarness.calls.length);
    expect(noveltyHarness.calls.length).toBeLessThanOrEqual(64 + uniqueIngredients.length);
  });
});
