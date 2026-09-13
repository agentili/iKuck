import { describe, expect, it } from 'vitest';
import type { DietProfilePayload, EuAllergen } from '@ikuck/shared/contracts';
import {
  DIET_TYPES,
  EU_ALLERGENS,
  isRecipeCompatible,
  normalizeDietProfile,
  validateDietProfileDetails,
} from '../dietary';

const profile = (overrides: Partial<DietProfilePayload> = {}): DietProfilePayload => ({
  diet: 'omnivore',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
  ...overrides,
});

describe('dietary domain', () => {
  it('exposes the four supported diets and all 14 EU allergens', () => {
    expect(DIET_TYPES).toEqual(['omnivore', 'vegetarian', 'pescatarian', 'vegan']);
    expect(EU_ALLERGENS).toHaveLength(14);
    expect(EU_ALLERGENS).toEqual(expect.arrayContaining<EuAllergen>([
      'gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk',
      'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs',
    ]));
  });

  it('normalizes malformed profiles to an omnivore safe default', () => {
    expect(normalizeDietProfile({ diet: 'unknown', excludedAllergens: ['fish'], nutrition: { maxCaloriesPerServing: -1 } })).toMatchObject({
      diet: 'omnivore',
      excludedAllergens: [],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    });
  });

  it('rejects unsupported, duplicate and invalid profile values', () => {
    expect(validateDietProfileDetails('unknown', [], { maxCaloriesPerServing: null, minProteinGramsPerServing: null })).toContain('diet_invalid');
    expect(validateDietProfileDetails('omnivore', ['fish', 'fish'], { maxCaloriesPerServing: null, minProteinGramsPerServing: null })).toContain('allergens_duplicate');
    expect(validateDietProfileDetails('omnivore', ['not-an-allergen'], { maxCaloriesPerServing: null, minProteinGramsPerServing: null })).toContain('allergen_invalid');
    expect(validateDietProfileDetails('omnivore', [], { maxCaloriesPerServing: -1, minProteinGramsPerServing: Number.NaN })).toEqual(expect.arrayContaining(['max_calories_invalid', 'min_protein_invalid']));
  });

  it('blocks incompatible diets and allergens without blocking safe recipes', () => {
    expect(isRecipeCompatible('pasta-tonno-pomodoro', profile({ diet: 'vegetarian' }))).toBe(false);
    expect(isRecipeCompatible('frittata-zucchine', profile({ excludedAllergens: ['eggs'] }))).toBe(false);
    expect(isRecipeCompatible('lenticchie-in-umido', profile({ diet: 'vegan' }))).toBe(true);
    expect(isRecipeCompatible('recipe-not-in-catalog', profile())).toBe(false);
  });
});
