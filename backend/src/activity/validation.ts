import { z } from 'zod';
import type { CookEvent, CookEventPayload, RecipePreference, RecipePreferencePayload } from '@ikuck/shared/contracts';

const eventDetailsObject = z.object({
  recipeId: z.string().trim().min(1).max(160),
  recipeTitle: z.string().trim().min(1).max(160),
  servings: z.number().int().positive(),
  cookedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(500).nullable(),
});

const preferenceDetailsObject = z.object({
  recipeId: z.string().trim().min(1).max(160),
  favorite: z.boolean(),
  rating: z.number().int().min(1).max(5).nullable(),
  note: z.string().trim().max(500).nullable(),
});

export const cookEventDetailsSchema = eventDetailsObject;
export const cookEventSchema = z.object({
  id: z.string().trim().min(1).max(160),
  ...eventDetailsObject.shape,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export const recipePreferenceDetailsSchema = preferenceDetailsObject;
export const recipePreferenceSchema = z.object({
  ...preferenceDetailsObject.shape,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export const parseCookEventDetails = (body: unknown): CookEventPayload | null => {
  const result = cookEventDetailsSchema.safeParse(body);
  return result.success ? result.data : null;
};

export const parseRecipePreferenceDetails = (body: unknown): RecipePreferencePayload | null => {
  const result = recipePreferenceDetailsSchema.safeParse(body);
  return result.success ? result.data : null;
};

export const isEmptyRecipePreference = (preference: Pick<RecipePreferencePayload, 'favorite' | 'rating' | 'note'>): boolean => (
  !preference.favorite
  && preference.rating === null
  && (preference.note === null || preference.note.trim().length === 0)
);

export const isCookEvent = (value: unknown): value is CookEvent => cookEventSchema.safeParse(value).success;
export const isRecipePreference = (value: unknown): value is RecipePreference => recipePreferenceSchema.safeParse(value).success;
