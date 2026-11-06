import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import { RECIPES } from '../domain/recipes';
import { deleteLocalDatabase } from './indexedDb';
import { clearDataScope } from '../sync/syncQueue';
import { clearDailyRecipes, getDailyRecipe, localDateKey } from './dailyRecipeStorage';

const availableIds = RECIPES.flatMap((recipe) => recipe.ingredients.map((item) => item.ingredientId));
const options = { recipes: RECIPES, availableIds, profile: DEFAULT_DIET_PROFILE };

beforeEach(async () => { await deleteLocalDatabase(); });

describe('daily recipes', () => {
  it('persists the selection per local date and scope even when the pantry changes', async () => {
    const first = await getDailyRecipe({ ...options, date: '2026-10-28', scope: 'guest' });
    const again = await getDailyRecipe({ ...options, availableIds: [], date: '2026-10-28', scope: 'guest' });
    expect(again?.recipe.id).toBe(first?.recipe.id);
    expect(again?.missingIngredientIds.length).toBeGreaterThan(1);
    const other = await getDailyRecipe({ ...options, recipes: [RECIPES[1]], date: '2026-10-28', scope: 'account:other' });
    expect(other?.recipe.id).toBe(RECIPES[1].id);
  });

  it('avoids the previous two actual selections when possible', async () => {
    const results = [];
    for (const date of ['2026-10-28', '2026-10-29', '2026-10-30']) {
      results.push((await getDailyRecipe({ ...options, date, scope: 'guest' }))?.recipe.id);
    }
    expect(new Set(results).size).toBe(3);
  });

  it('rechecks dietary compatibility when the profile changes during the same day', async () => {
    const initial = await getDailyRecipe({ ...options, recipes: [RECIPES[0]], date: '2026-10-28', scope: 'guest' });
    expect(initial?.recipe.id).toBe(RECIPES[0].id);
    const next = await getDailyRecipe({ ...options, date: '2026-10-28', scope: 'guest', profile: { ...DEFAULT_DIET_PROFILE, diet: 'vegan' } });
    expect(next?.recipe.id).not.toBe(RECIPES[0].id);
  });

  it('clears only the requested scope', async () => {
    await getDailyRecipe({ ...options, recipes: [RECIPES[0]], date: '2026-10-28', scope: 'guest' });
    await getDailyRecipe({ ...options, recipes: [RECIPES[1]], date: '2026-10-28', scope: 'account:other' });
    await clearDailyRecipes('guest');
    const cleared = await getDailyRecipe({ ...options, recipes: [RECIPES[1]], date: '2026-10-28', scope: 'guest' });
    const retained = await getDailyRecipe({ ...options, date: '2026-10-28', scope: 'account:other' });
    expect(cleared?.recipe.id).toBe(RECIPES[1].id);
    expect(retained?.recipe.id).toBe(RECIPES[1].id);
  });

  it('removes daily history on a scope reset', async () => {
    await getDailyRecipe({ ...options, recipes: [RECIPES[1]], date: '2026-10-28', scope: 'guest' });
    await clearDataScope('guest');
    const next = await getDailyRecipe({ ...options, recipes: [RECIPES[1], RECIPES[0]], date: '2026-10-28', scope: 'guest' });
    expect(next?.recipe.id).toBe(RECIPES[0].id);
  });

  it('uses the browser local date instead of UTC', () => {
    const date = new Date(2026, 9, 28, 0, 5);
    expect(localDateKey(date)).toBe('2026-10-28');
  });
});
