import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';

export type CookEventValidationError =
  | 'recipe_id_required'
  | 'recipe_title_required'
  | 'servings_integer'
  | 'servings_positive'
  | 'cooked_at_invalid'
  | 'note_too_long';

export type RecipePreferenceValidationError =
  | 'recipe_id_required'
  | 'rating_integer'
  | 'rating_range'
  | 'note_too_long';

export const validateCookEventDetails = (
  recipeId: string,
  recipeTitle: string,
  servings: number,
  cookedAt: string,
  note: string | null,
): CookEventValidationError[] => {
  const errors: CookEventValidationError[] = [];
  if (recipeId.trim().length === 0) errors.push('recipe_id_required');
  if (recipeTitle.trim().length === 0) errors.push('recipe_title_required');
  if (!Number.isInteger(servings)) errors.push('servings_integer');
  else if (servings <= 0) errors.push('servings_positive');
  if (Number.isNaN(new Date(cookedAt).getTime())) errors.push('cooked_at_invalid');
  if (note !== null && note.trim().length > 500) errors.push('note_too_long');
  return errors;
};

export const validateRecipePreferenceDetails = (
  recipeId: string,
  favorite: boolean,
  rating: number | null,
  note: string | null,
): RecipePreferenceValidationError[] => {
  const errors: RecipePreferenceValidationError[] = [];
  if (recipeId.trim().length === 0) errors.push('recipe_id_required');
  if (rating !== null && !Number.isInteger(rating)) errors.push('rating_integer');
  if (rating !== null && (rating < 1 || rating > 5)) errors.push('rating_range');
  if (note !== null && note.trim().length > 500) errors.push('note_too_long');
  void favorite;
  return errors;
};

export const isEmptyRecipePreference = (preference: Pick<RecipePreference, 'favorite' | 'rating' | 'note'>): boolean => (
  !preference.favorite && preference.rating === null && (preference.note === null || preference.note.trim().length === 0)
);

export const isCookEvent = (value: unknown): value is CookEvent => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CookEvent>;
  return typeof candidate.id === 'string'
    && typeof candidate.recipeId === 'string'
    && typeof candidate.recipeTitle === 'string'
    && typeof candidate.servings === 'number'
    && typeof candidate.cookedAt === 'string'
    && !Number.isNaN(new Date(candidate.cookedAt).getTime())
    && (candidate.note === null || typeof candidate.note === 'string')
    && typeof candidate.createdAt === 'string'
    && !Number.isNaN(new Date(candidate.createdAt).getTime())
    && typeof candidate.updatedAt === 'string'
    && !Number.isNaN(new Date(candidate.updatedAt).getTime())
    && validateCookEventDetails(candidate.recipeId, candidate.recipeTitle, candidate.servings, candidate.cookedAt, candidate.note).length === 0;
};

export const isRecipePreference = (value: unknown): value is RecipePreference => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RecipePreference>;
  return typeof candidate.recipeId === 'string'
    && typeof candidate.favorite === 'boolean'
    && (candidate.rating === null || typeof candidate.rating === 'number')
    && (candidate.note === null || typeof candidate.note === 'string')
    && typeof candidate.createdAt === 'string'
    && !Number.isNaN(new Date(candidate.createdAt).getTime())
    && typeof candidate.updatedAt === 'string'
    && !Number.isNaN(new Date(candidate.updatedAt).getTime())
    && validateRecipePreferenceDetails(candidate.recipeId, candidate.favorite, candidate.rating, candidate.note).length === 0;
};
