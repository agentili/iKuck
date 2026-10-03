import type { SyncEntityType, SyncMutation } from '@ikuck/shared/contracts';
import { z } from 'zod';
import { aiConsentSchema, aiConsentSyncSchema, generatedRecipeSchema } from '../ai/validation.js';
import { cookEventSchema, recipePreferenceSchema } from '../activity/validation.js';
import { dietProfileSchema } from '../diet/validation.js';
import { pantryLotSchema } from '../pantry/validation.js';
import { shoppingListItemSchema } from '../shopping/validation.js';
import { isDinnerEntry, isSavedRecipe } from '@ikuck/shared/dinnerDiary';

const mutationMetadata = {
  mutationId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  entityId: z.string().min(1).max(128),
  clientUpdatedAt: z.string().datetime({ offset: true }),
  syncScope: z.string().regex(/^(account|house):[^:]+$/).optional(),
};

const exactKeys = (value: unknown, keys: readonly string[]): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
};

const exactPayload = <T>(schema: z.ZodType<T>, keys: readonly string[]): z.ZodType<T> => z.custom<unknown>(
  (value) => exactKeys(value, keys),
  { message: 'Payload contains unexpected fields' },
).and(schema);

const pantryItemSchema = z.object({
  id: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(160),
  known: z.boolean(),
}).strict();

const staplePreferenceSchema = z.object({ enabled: z.boolean() }).strict();

const payloadSchemas = {
  pantry_item: pantryItemSchema,
  pantry_lot: exactPayload(pantryLotSchema, [
    'id', 'ingredientId', 'label', 'known', 'quantity', 'unit', 'expiresAt', 'createdAt', 'updatedAt',
  ]),
  staple_preference: staplePreferenceSchema,
  shopping_list_item: exactPayload(shoppingListItemSchema, [
    'id', 'ingredientId', 'label', 'quantity', 'unit', 'note', 'purchased', 'sourceRecipeId', 'createdAt', 'updatedAt',
  ]),
  cook_event: exactPayload(cookEventSchema, [
    'id', 'recipeId', 'recipeTitle', 'servings', 'cookedAt', 'note', 'createdAt', 'updatedAt',
  ]),
  recipe_preference: exactPayload(recipePreferenceSchema, [
    'recipeId', 'favorite', 'rating', 'note', 'createdAt', 'updatedAt',
  ]),
  diet_profile: dietProfileSchema,
  ai_consent: aiConsentSyncSchema,
  generated_recipe: generatedRecipeSchema,
  dinner_entry: z.custom<unknown>(isDinnerEntry),
  saved_recipe: z.custom<unknown>(isSavedRecipe),
} satisfies Record<SyncEntityType, z.ZodTypeAny>;

type EntityPayload = {
  [Entity in SyncEntityType]: z.output<typeof payloadSchemas[Entity]>;
};

const buildEntityMutationSchema = <Entity extends SyncEntityType>(
  entityType: Entity,
  payloadSchema: z.ZodType<EntityPayload[Entity]>,
  entityIdMatches: (entityId: string, payload: EntityPayload[Entity]) => boolean = () => true,
  entityIdIsValid: (entityId: string) => boolean = () => true,
) => z.union([
  z.object({
    ...mutationMetadata,
    entityType: z.literal(entityType),
    operation: z.literal('upsert'),
    payload: payloadSchema,
  }),
  z.object({
    ...mutationMetadata,
    entityType: z.literal(entityType),
    operation: z.literal('delete'),
    payload: z.null(),
  }),
]).superRefine((mutation, context) => {
  if (!entityIdIsValid(mutation.entityId)
    || (mutation.operation === 'upsert' && !entityIdMatches(mutation.entityId, mutation.payload))) {
    context.addIssue({ code: 'custom', path: ['entityId'], message: 'Entity ID does not match payload' });
  }
});

export const syncMutationSchema = z.union([
  buildEntityMutationSchema('pantry_item', payloadSchemas.pantry_item, (entityId, payload) => payload.id === entityId),
  buildEntityMutationSchema('pantry_lot', payloadSchemas.pantry_lot, (entityId, payload) => payload.id === entityId),
  buildEntityMutationSchema('staple_preference', payloadSchemas.staple_preference),
  buildEntityMutationSchema('shopping_list_item', payloadSchemas.shopping_list_item, (entityId, payload) => payload.id === entityId),
  buildEntityMutationSchema('cook_event', payloadSchemas.cook_event, (entityId, payload) => payload.id === entityId),
  buildEntityMutationSchema('recipe_preference', payloadSchemas.recipe_preference, (entityId, payload) => payload.recipeId === entityId),
  buildEntityMutationSchema('diet_profile', payloadSchemas.diet_profile, (entityId) => entityId === 'profile'),
  buildEntityMutationSchema('ai_consent', payloadSchemas.ai_consent, () => true, (entityId) => entityId === 'profile'),
  buildEntityMutationSchema('generated_recipe', payloadSchemas.generated_recipe, (entityId, payload) => payload.id === entityId),
  buildEntityMutationSchema('dinner_entry', payloadSchemas.dinner_entry, (entityId, payload) => typeof payload === 'object' && payload !== null && 'id' in payload && payload.id === entityId),
  buildEntityMutationSchema('saved_recipe', payloadSchemas.saved_recipe, (entityId, payload) => typeof payload === 'object' && payload !== null && 'id' in payload && payload.id === entityId),
]);

const storedAiConsentMutationSchema = z.union([
  z.object({
    ...mutationMetadata,
    entityType: z.literal('ai_consent'),
    operation: z.literal('upsert'),
    payload: aiConsentSchema,
  }),
  z.object({
    ...mutationMetadata,
    entityType: z.literal('ai_consent'),
    operation: z.literal('delete'),
    payload: z.null(),
  }),
]).superRefine((mutation, context) => {
  if (mutation.entityId !== 'profile') {
    context.addIssue({ code: 'custom', path: ['entityId'], message: 'Entity ID does not match payload' });
  }
});

const storedMutationSchema = z.union([syncMutationSchema, storedAiConsentMutationSchema]);

export class SyncMutationValidationError extends Error {
  readonly code = 'INVALID_SYNC_MUTATION';

  constructor() {
    super('Sync mutation is invalid');
    this.name = 'SyncMutationValidationError';
  }
}

export const parseSyncMutation = (value: unknown): SyncMutation | null => {
  const result = syncMutationSchema.safeParse(value);
  return result.success ? result.data as SyncMutation : null;
};

export const assertSyncMutation = (value: unknown): SyncMutation => {
  const mutation = parseSyncMutation(value);
  if (mutation === null) throw new SyncMutationValidationError();
  return mutation;
};

export const assertStoredSyncMutation = (value: unknown): SyncMutation => {
  const result = storedMutationSchema.safeParse(value);
  if (!result.success) throw new SyncMutationValidationError();
  return result.data as SyncMutation;
};
