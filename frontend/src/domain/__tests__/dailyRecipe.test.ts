import { describe, expect, it } from 'vitest';
import { DEFAULT_DIET_PROFILE } from '../dietary';
import { RECIPES } from '../recipes';
import { selectDailyRecipe, isDailyResultCurrent } from '../dailyRecipe';

describe('daily recipe selection', () => {
  it('never displays a result from another scope or date', () => {
    expect(isDailyResultCurrent({ scope: 'house:a', date: '2026-10-28' }, 'house:b', '2026-10-28')).toBe(false);
    expect(isDailyResultCurrent({ scope: 'house:a', date: '2026-10-28' }, 'house:a', '2026-10-29')).toBe(false);
    expect(isDailyResultCurrent({ scope: 'house:a', date: '2026-10-28' }, 'house:a', '2026-10-28')).toBe(true);
  });

  it('prefers a compatible recipe within 30 minutes with at most one missing ingredient', () => {
    const recipe = RECIPES[0];
    const result = selectDailyRecipe({ recipes: [recipe], availableIds: recipe.ingredients.map((item) => item.ingredientId), profile: DEFAULT_DIET_PROFILE, date: '2026-10-28', previousIds: [] });
    expect(result?.recipe.id).toBe(recipe.id);
    expect(result?.missingIngredientIds).toEqual([]);
    expect(result?.reasons).toEqual([]);
  });

  it('avoids either of the two prior choices when an equally eligible alternative exists', () => {
    const recipes = RECIPES.filter((r) => r.durationMinutes !== null && r.durationMinutes <= 30).slice(0, 3);
    const availableIds = recipes.flatMap((r) => r.ingredients.map((i) => i.ingredientId));
    const result = selectDailyRecipe({ recipes, availableIds, profile: DEFAULT_DIET_PROFILE, date: '2026-10-28', previousIds: recipes.slice(0, 2).map((r) => r.id) });
    expect(result?.recipe.id).toBe(recipes[2].id);
  });

  it('chooses a new eligible recipe even when yesterday had all ingredients', () => {
    const first = RECIPES[0];
    const second = RECIPES[1];
    const missing = second.ingredients.find((item) => !item.optional && !first.ingredients.some((other) => other.ingredientId === item.ingredientId))!;
    const availableIds = [...first.ingredients, ...second.ingredients].map((i) => i.ingredientId).filter((id) => id !== missing.ingredientId);
    const result = selectDailyRecipe({ recipes: [first, second], availableIds, profile: DEFAULT_DIET_PROFILE, date: '2026-10-28', previousIds: [first.id] });
    expect(result?.recipe.id).toBe(second.id);
    expect(result?.missingIngredientIds).toEqual([missing.ingredientId]);
  });

  it('distinguishes one missing ingredient from two and the 30-minute boundary', () => {
    const recipe = RECIPES[0];
    const required = recipe.ingredients.filter((i) => !i.optional).map((i) => i.ingredientId);
    const select = (n: number, durationMinutes: number | null) => selectDailyRecipe({ recipes: [{ ...recipe, durationMinutes }], availableIds: required.slice(n), profile: DEFAULT_DIET_PROFILE, date: '2026-10-28', previousIds: [] });
    expect(select(1, 30)?.reasons).toEqual([]);
    expect(select(1, 30)?.missingIngredientIds).toHaveLength(1);
    expect(select(2, 30)?.reasons).toEqual(['missing']);
    expect(select(0, 31)?.reasons).toEqual(['duration']);
    expect(select(0, null)?.reasons).toEqual(['duration']);
  });

  it('excludes recipes with a forbidden declared allergen', () => {
    const recipe = RECIPES.find((r) => r.id === 'pasta-tonno-pomodoro')!;
    expect(selectDailyRecipe({ recipes: [recipe], availableIds: [], profile: { ...DEFAULT_DIET_PROFILE, excludedAllergens: ['fish'] }, date: '2026-10-28', previousIds: [] })).toBeNull();
  });

  it('reports fallback constraints and never falls back to an incompatible recipe', () => {
    const recipe = RECIPES[0];
    const fallback = selectDailyRecipe({ recipes: [{ ...recipe, durationMinutes: 45 }], availableIds: [], profile: DEFAULT_DIET_PROFILE, date: '2026-10-28', previousIds: [] });
    expect(fallback?.reasons).toEqual(['missing', 'duration']);
    expect(selectDailyRecipe({ recipes: [recipe], availableIds: [], profile: { ...DEFAULT_DIET_PROFILE, diet: 'vegan' }, date: '2026-10-28', previousIds: [] })).toBeNull();
    expect(selectDailyRecipe({ recipes: [], availableIds: [], profile: DEFAULT_DIET_PROFILE, date: '2026-10-28', previousIds: [] })).toBeNull();
  });
});
