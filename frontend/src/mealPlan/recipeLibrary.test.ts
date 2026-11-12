import * as diaryStorage from '../storage/dinnerDiaryStorage';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import { RECIPES } from '../domain/recipes';
import { availablePlanRecipes, generatedToSavedRecipe, planRecipeLibrary } from './recipeLibrary';
import { savePlanRecipe, useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { setActiveDataScope } from '../sync/scopeContext';
import { useAuthStore } from '../auth/authStore';
import { toDiaryPantryRecipe } from '../domain/diaryRecipes';

const recipe = generatedToSavedRecipe({ id: 'created-recipe', source: 'ai', title: 'Riso', description: '', ingredients: [{ name: 'Riso', amount: '100 g' }], steps: ['Cuoci.'], diets: ['omnivore'], allergens: [], createdAt: '2026-11-12T12:00:00Z', updatedAt: '2026-11-12T12:00:00Z' }, null);

describe('plan recipe library', () => {
  it('requires every mandatory ingredient, respects diet and omits the current recipe', () => {
    const available = RECIPES[0].ingredients.map(ingredient => ingredient.ingredientId);
    expect(availablePlanRecipes(RECIPES, DEFAULT_DIET_PROFILE, available, null)).toContain(RECIPES[0]);
    expect(availablePlanRecipes([RECIPES[0]], DEFAULT_DIET_PROFILE, available.slice(1), null)).toEqual([]);
    expect(availablePlanRecipes([RECIPES[0]], { ...DEFAULT_DIET_PROFILE, diet: 'vegan' }, available, null)).toEqual([]);
    expect(availablePlanRecipes([RECIPES[0]], DEFAULT_DIET_PROFILE, available, RECIPES[0].id)).toEqual([]);
    expect(availablePlanRecipes([{ ...RECIPES[0], ingredients: [{ ingredientId: 'salt', amount: '', optional: true }] }], DEFAULT_DIET_PROFILE, [], null)).toHaveLength(1);
  });

  it('persists a scoped recipe before resolving and retries without duplicates', async () => {
    useAuthStore.setState({ user: null, csrfToken: null });
    setActiveDataScope('guest');
    useDinnerDiaryStore.setState({ recipes: [], hasHydrated: true });
    await savePlanRecipe('guest', recipe, () => undefined);
    await savePlanRecipe('guest', recipe, () => undefined);
    expect(await readSavedRecipes('guest')).toEqual([recipe]);
    const library = planRecipeLibrary('guest', useDinnerDiaryStore.getState().recipes);
    expect(library.find(item => item.title === recipe.title)?.id).toBe(toDiaryPantryRecipe({ scope: 'guest', value: recipe }).id);
    expect(planRecipeLibrary('house:other', useDinnerDiaryStore.getState().recipes).find(item => item.title === recipe.title)).toBeUndefined();
  });

  it('does not persist when the captured context is stale', async () => {
    await expect(savePlanRecipe('guest', recipe, () => { throw new Error('Scope changed'); })).rejects.toThrow('Scope changed');
    expect(await readSavedRecipes('guest')).toEqual([]);
  });
  it('propagates persistence errors and allows a clean retry', async () => {
    setActiveDataScope('guest');
    useDinnerDiaryStore.setState({ recipes: [], hasHydrated: true });
    const write = vi.spyOn(diaryStorage, 'writeSavedRecipes').mockRejectedValueOnce(new Error('Storage full'));
    try {
      await expect(savePlanRecipe('guest', recipe, () => undefined)).rejects.toThrow('Storage full');
      expect(useDinnerDiaryStore.getState().recipes).toEqual([]);
      await savePlanRecipe('guest', recipe, () => undefined);
      expect(await readSavedRecipes('guest')).toEqual([recipe]);
    } finally { write.mockRestore(); }
  });

  it('resolves imported guest and account references without duplicate alternatives', () => {
    const value = { ...recipe, authorId: 'original-user' };
    const library = planRecipeLibrary('house:shared', [{ scope: 'house:shared', value }]);
    const guestId = toDiaryPantryRecipe({ scope: 'guest', value }).id;
    const accountId = toDiaryPantryRecipe({ scope: 'account:original-user', value }).id;
    expect(library.find(item => item.id === guestId)?.title).toBe(value.title);
    expect(library.find(item => item.id === accountId)?.diary?.scope).toBe('house:shared');
    expect(availablePlanRecipes(library, DEFAULT_DIET_PROFILE, ['rice'], null).filter(item => item.title === value.title)).toHaveLength(1);
    expect(availablePlanRecipes(library, DEFAULT_DIET_PROFILE, ['rice'], guestId).filter(item => item.title === value.title)).toEqual([]);
  });

});
