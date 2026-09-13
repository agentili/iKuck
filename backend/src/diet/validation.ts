import type { DietProfile, DietProfilePayload, DietType, EuAllergen } from '@ikuck/shared/contracts';
import { z } from 'zod';

export const DIET_TYPES = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'] as const satisfies readonly DietType[];
export const EU_ALLERGENS = [
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
] as const satisfies readonly EuAllergen[];

const nonNegativeNumber = z.number().finite().nonnegative().nullable();

export const dietProfilePayloadSchema = z.object({
  diet: z.enum(DIET_TYPES),
  excludedAllergens: z.array(z.enum(EU_ALLERGENS)).max(EU_ALLERGENS.length)
    .refine((allergens) => new Set(allergens).size === allergens.length, 'Allergens must be unique'),
  nutrition: z.object({
    maxCaloriesPerServing: nonNegativeNumber,
    minProteinGramsPerServing: nonNegativeNumber,
  }).strict(),
}).strict();

export const dietProfileSchema = dietProfilePayloadSchema.extend({
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const DEFAULT_DIET_PROFILE: DietProfilePayload = {
  diet: 'omnivore',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

export const isDietProfile = (value: unknown): value is DietProfile => {
  return dietProfileSchema.safeParse(value).success;
};

export const parseDietProfilePayload = (value: unknown): DietProfilePayload | null => {
  const result = dietProfilePayloadSchema.safeParse(value);
  return result.success ? result.data : null;
};
