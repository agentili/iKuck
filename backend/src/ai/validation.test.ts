import { describe, expect, it } from 'vitest';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import { isGeneratedRecipeCompatible, parseGeneratedRecipeDraft } from './validation.js';

const profile: DietProfilePayload = {
  diet: 'vegan',
  excludedAllergens: ['fish', 'milk'],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

const draft = {
  title: 'Ceci croccanti',
  description: 'Una ricetta semplice.',
  ingredients: [{ name: 'Ceci', amount: '240 g' }],
  steps: ['Scola i ceci.', 'Cuocili in padella.'],
  diets: ['vegan'],
  allergens: [],
};

describe('AI recipe validation', () => {
  it('accepts a complete private recipe draft and preserves its metadata', () => {
    expect(parseGeneratedRecipeDraft(draft)).toEqual(draft);
    expect(isGeneratedRecipeCompatible(draft, profile)).toBe(true);
  });

  it('rejects malformed recipes and duplicate allergens', () => {
    expect(parseGeneratedRecipeDraft({ ...draft, title: '' })).toBeNull();
    expect(parseGeneratedRecipeDraft({ ...draft, allergens: ['fish', 'fish'] })).toBeNull();
    expect(parseGeneratedRecipeDraft({ ...draft, steps: [] })).toBeNull();
  });

  it('blocks a fish recipe for a vegan profile with fish excluded', () => {
    expect(isGeneratedRecipeCompatible({ ...draft, diets: ['omnivore', 'pescatarian'], allergens: ['fish'] }, profile)).toBe(false);
  });

  it('supports every EU allergen code in the validation schema', () => {
    const allergens = ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'];
    expect(parseGeneratedRecipeDraft({ ...draft, allergens })).toMatchObject({ allergens });
  });
});
