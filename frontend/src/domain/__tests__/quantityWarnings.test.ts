import { describe, expect, it } from 'vitest';
import { aggregatePantryLots } from '../pantryLots';
import { findRecipeSuggestions } from '../suggestions';
import type { PantryLot } from '@ikuck/shared/contracts';
import type { PantryRecipe as LocalPantryRecipe } from '../types';

const lot: PantryLot = {
  id: 'lot-pasta', ingredientId: 'pasta', label: 'Pasta', known: true,
  quantity: 100, unit: 'g', expiresAt: null,
  createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
};

const recipe = (amount: string): LocalPantryRecipe => ({
  id: 'test-recipe', title: 'Test recipe', description: 'Test', category: 'vegetables',
  durationMinutes: 10, difficulty: 'easy', servings: 2,
  ingredients: [{ ingredientId: 'pasta', amount }], steps: ['Cook.'], tags: [],
});

describe('recipe quantity warnings', () => {
  it('warns for insufficient compatible quantity without excluding the recipe', () => {
    const result = findRecipeSuggestions({
      recipes: [recipe('200 g')],
      availableIds: ['pasta'],
      allowOneMissing: false,
      quantitySummaries: aggregatePantryLots([lot]),
    });

    expect(result).toHaveLength(1);
    expect(result[0].quantityWarnings).toEqual(['pasta']);
  });

  it('does not warn when quantity is enough, unknown or incompatible', () => {
    const summaries = aggregatePantryLots([lot]);
    expect(findRecipeSuggestions({ recipes: [recipe('80 g')], availableIds: ['pasta'], allowOneMissing: false, quantitySummaries: summaries })[0].quantityWarnings).toEqual([]);
    expect(findRecipeSuggestions({ recipes: [recipe('q.b.')], availableIds: ['pasta'], allowOneMissing: false, quantitySummaries: summaries })[0].quantityWarnings).toEqual([]);
    expect(findRecipeSuggestions({ recipes: [recipe('2 pezzi')], availableIds: ['pasta'], allowOneMissing: false, quantitySummaries: summaries })[0].quantityWarnings).toEqual([]);
  });

  it('keeps the warning list empty when no quantity summary exists', () => {
    expect(findRecipeSuggestions({ recipes: [recipe('200 g')], availableIds: ['pasta'], allowOneMissing: false })[0].quantityWarnings).toEqual([]);
  });
});
