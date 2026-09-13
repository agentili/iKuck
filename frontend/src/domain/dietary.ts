import type {
  DietProfile,
  DietProfilePayload,
  DietType,
  EuAllergen,
  NutritionFilter,
} from '@ikuck/shared/contracts';
import { getRecipeMetadata } from './recipeMetadata';

export const DIET_TYPES: readonly DietType[] = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'];
export const EU_ALLERGENS: readonly EuAllergen[] = [
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'peanuts',
  'soybeans',
  'milk',
  'nuts',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
  'molluscs',
];

export const DEFAULT_DIET_PROFILE: DietProfilePayload = {
  diet: 'omnivore',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

export type DietProfileValidationError =
  | 'diet_invalid'
  | 'allergen_invalid'
  | 'allergens_duplicate'
  | 'max_calories_invalid'
  | 'min_protein_invalid';

const isDietType = (value: unknown): value is DietType => typeof value === 'string' && DIET_TYPES.includes(value as DietType);
const isAllergen = (value: unknown): value is EuAllergen => typeof value === 'string' && EU_ALLERGENS.includes(value as EuAllergen);
const isValidThreshold = (value: unknown): value is number | null => value === null
  || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

export const isDietProfile = (value: unknown): value is DietProfile => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DietProfile>;
  if (!Array.isArray(candidate.excludedAllergens)
    || typeof candidate.nutrition !== 'object'
    || candidate.nutrition === null
    || typeof candidate.updatedAt !== 'string') return false;
  return validateDietProfileDetails(candidate.diet, candidate.excludedAllergens, candidate.nutrition).length === 0
    && !Number.isNaN(new Date(candidate.updatedAt).getTime());
};

export const validateDietProfileDetails = (
  diet: unknown,
  excludedAllergens: readonly unknown[],
  nutrition: Partial<Record<keyof NutritionFilter, unknown>>,
): DietProfileValidationError[] => {
  const errors: DietProfileValidationError[] = [];
  if (!isDietType(diet)) errors.push('diet_invalid');
  if (excludedAllergens.some((allergen) => !isAllergen(allergen))) errors.push('allergen_invalid');
  if (new Set(excludedAllergens).size !== excludedAllergens.length) errors.push('allergens_duplicate');
  if (!isValidThreshold(nutrition.maxCaloriesPerServing)) errors.push('max_calories_invalid');
  if (!isValidThreshold(nutrition.minProteinGramsPerServing)) errors.push('min_protein_invalid');
  return errors;
};

const now = (): string => new Date().toISOString();

export const normalizeDietProfile = (value: unknown): DietProfile => {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_DIET_PROFILE, updatedAt: now() };
  const candidate = value as Partial<DietProfile>;
  const nutrition = candidate.nutrition;
  const errors = validateDietProfileDetails(candidate.diet, candidate.excludedAllergens ?? [], nutrition ?? {});
  if (errors.length > 0 || typeof candidate.updatedAt !== 'string' || Number.isNaN(new Date(candidate.updatedAt).getTime())) {
    return { ...DEFAULT_DIET_PROFILE, updatedAt: now() };
  }
  return {
    diet: candidate.diet!,
    excludedAllergens: [...new Set(candidate.excludedAllergens)].sort() as EuAllergen[],
    nutrition: {
      maxCaloriesPerServing: nutrition!.maxCaloriesPerServing as number | null,
      minProteinGramsPerServing: nutrition!.minProteinGramsPerServing as number | null,
    },
    updatedAt: candidate.updatedAt,
  };
};

export const isRecipeCompatible = (recipeId: string, profile: DietProfilePayload): boolean => {
  const recipe = getRecipeMetadata(recipeId);
  if (recipe === undefined) return false;
  if (!recipe.diets.includes(profile.diet)) return false;
  const excluded = new Set(profile.excludedAllergens);
  if (recipe.allergens.some((allergen) => excluded.has(allergen))) return false;
  const { nutrition } = recipe;
  if (profile.nutrition.maxCaloriesPerServing !== null
    && (nutrition.caloriesPerServing === null || nutrition.caloriesPerServing > profile.nutrition.maxCaloriesPerServing)) return false;
  if (profile.nutrition.minProteinGramsPerServing !== null
    && (nutrition.proteinGramsPerServing === null || nutrition.proteinGramsPerServing < profile.nutrition.minProteinGramsPerServing)) return false;
  return true;
};
