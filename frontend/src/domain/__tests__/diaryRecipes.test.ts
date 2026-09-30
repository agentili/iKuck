import { describe, expect, it } from 'vitest';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { DEFAULT_DIET_PROFILE } from '../dietary';
import { findRecipeSuggestions } from '../suggestions';
import { toDiaryPantryRecipe } from '../diaryRecipes';

const saved: SavedRecipe = {
  id: 'saved-recipe-1', title: 'Pasta con zucchine', description: 'Una cena semplice.',
  ingredients: [
    { name: 'spaghetti', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' },
    { name: 'zucchine novelle', amount: '2', ingredientId: null, optional: false, provenance: 'suggested' },
  ],
  steps: ['Cuoci la pasta.'], servings: 2, durationMinutes: 20, diets: null, allergens: null,
  suggestedFields: ['ingredients', 'steps', 'diets', 'allergens'], source: 'diary', authorId: 'user-1',
  createdAt: '2026-09-29T18:00:00.000Z', updatedAt: '2026-09-29T18:01:00.000Z',
};

describe('diary recipe suggestions', () => {
  it('maps known names to canonical pantry IDs and keeps unknown ingredients unavailable', () => {
    const recipe = toDiaryPantryRecipe({ scope: 'house:home-1', value: saved });

    expect(recipe).toMatchObject({ source: 'diary', category: 'diary', servings: 2, durationMinutes: 20, diary: { scope: 'house:home-1', savedRecipeId: saved.id } });
    expect(recipe.ingredients[0]).toMatchObject({ ingredientId: 'pasta', name: 'spaghetti' });
    expect(recipe.ingredients[1].ingredientId).toMatch(/^custom:/);
    expect(findRecipeSuggestions({ recipes: [recipe], availableIds: ['pasta'], allowOneMissing: true, dietProfile: DEFAULT_DIET_PROFILE })).toEqual([]);
  });

  it('makes a confirmed recipe eligible when every required ingredient is present', () => {
    const recipe = toDiaryPantryRecipe({
      scope: 'account:user-1',
      value: { ...saved, ingredients: [saved.ingredients[0], { name: 'zucchina', amount: '2', ingredientId: null, optional: false, provenance: 'provided' }] },
    });

    const suggestions = findRecipeSuggestions({ recipes: [recipe], availableIds: ['pasta', 'zucchini'], allowOneMissing: false, dietProfile: DEFAULT_DIET_PROFILE });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].recipe.id).toBe(recipe.id);
    expect(suggestions[0].missingIngredientIds).toEqual([]);
  });

  it('does not claim unknown AI dietary metadata is compatible with restrictive filters', () => {
    const recipe = toDiaryPantryRecipe({ scope: 'account:user-1', value: saved });
    const veganProfile = { ...DEFAULT_DIET_PROFILE, diet: 'vegan' as const };

    expect(findRecipeSuggestions({ recipes: [recipe], availableIds: ['pasta'], allowOneMissing: false, dietProfile: veganProfile })).toEqual([]);
  });
});
