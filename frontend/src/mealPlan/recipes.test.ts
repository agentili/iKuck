import { describe, expect, it } from 'vitest';
import { DEFAULT_DIET_PROFILE, isRecipeCompatible } from '../domain/dietary';
import { RECIPES } from '../domain/recipes';
import { selectPlanRecipe } from './recipes';

describe('meal plan recipe proposals', () => {
  it('selects a real compatible catalogue recipe and prefers a duration near 30 minutes', () => {
    const recipe = selectPlanRecipe({ recipes: RECIPES, profile: DEFAULT_DIET_PROFILE, date: '2026-10-29' });

    expect(recipe).toBeDefined();
    expect(RECIPES).toContain(recipe);
    expect(isRecipeCompatible(recipe!, DEFAULT_DIET_PROFILE)).toBe(true);
    expect(recipe!.durationMinutes).not.toBeNull();
    expect(recipe!.durationMinutes).toBeLessThanOrEqual(30);
  });

  it('does not invent a hard 30-minute cutoff when only a 31-minute alternative exists', () => {
    const recipe = { ...RECIPES[0], durationMinutes: 31 };

    expect(selectPlanRecipe({ recipes: [recipe], profile: DEFAULT_DIET_PROFILE, date: '2026-10-29' })).toBe(recipe);
  });

  it('preserves unknown duration when it is the only compatible option', () => {
    const recipe = { ...RECIPES[0], durationMinutes: null };

    expect(selectPlanRecipe({ recipes: [recipe], profile: DEFAULT_DIET_PROFILE, date: '2026-10-29' })).toBe(recipe);
  });

  it('returns no proposal when the compatible catalogue is empty', () => {
    expect(selectPlanRecipe({ recipes: [], profile: DEFAULT_DIET_PROFILE, date: '2026-10-29' })).toBeUndefined();
  });

  it('avoids repeats until every compatible alternative has been used', () => {
    const first = selectPlanRecipe({ recipes: RECIPES, profile: DEFAULT_DIET_PROFILE, date: '2026-10-29' });
    expect(first).toBeDefined();

    const next = selectPlanRecipe({
      recipes: RECIPES,
      profile: DEFAULT_DIET_PROFILE,
      date: '2026-10-30',
      excludedRecipeIds: [first!.id],
    });
    expect(next).toBeDefined();
    expect(next!.id).not.toBe(first!.id);
  });
});
