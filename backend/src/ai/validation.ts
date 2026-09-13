import type { AiConsent, DietProfilePayload, GeneratedRecipe, GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { z } from 'zod';

const dietTypes = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'] as const;
const euAllergens = [
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
] as const;

const unique = <T>(items: T[]): boolean => new Set(items).size === items.length;

export const generatedRecipeDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  ingredients: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    amount: z.string().trim().min(1).max(80),
  }).strict()).min(1).max(30),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  diets: z.array(z.enum(dietTypes)).min(1).max(dietTypes.length).refine(unique, 'Diets must be unique'),
  allergens: z.array(z.enum(euAllergens)).max(euAllergens.length).refine(unique, 'Allergens must be unique'),
}).strict();

export const generatedRecipeSchema = generatedRecipeDraftSchema.extend({
  id: z.string().min(1).max(128),
  source: z.literal('ai'),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const aiConsentSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const parseGeneratedRecipeDraft = (value: unknown): GeneratedRecipeDraft | null => {
  const result = generatedRecipeDraftSchema.safeParse(value);
  return result.success ? result.data : null;
};

export const isGeneratedRecipe = (value: unknown): value is GeneratedRecipe => generatedRecipeSchema.safeParse(value).success;

export const isAiConsent = (value: unknown): value is AiConsent => aiConsentSchema.safeParse(value).success;

export const isGeneratedRecipeCompatible = (
  recipe: Pick<GeneratedRecipeDraft, 'diets' | 'allergens'>,
  profile: DietProfilePayload,
): boolean => recipe.diets.includes(profile.diet)
  && !recipe.allergens.some((allergen) => profile.excludedAllergens.includes(allergen));
