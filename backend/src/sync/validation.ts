import type { SyncEntityType, SyncMutation } from '@ikuck/shared/contracts';
import { z } from 'zod';
import { aiConsentSchema, generatedRecipeSchema } from '../ai/validation.js';
import { cookEventSchema, recipePreferenceSchema } from '../activity/validation.js';
import { dietProfileSchema } from '../diet/validation.js';
import { pantryLotSchema } from '../pantry/validation.js';
import { shoppingListItemSchema } from '../shopping/validation.js';

const mutationMetadata = {
  mutationId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  entityId: z.string().min(1).max(128),
  clientUpdatedAt: z.string().datetime({ offset: true }),
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
  ai_consent: aiConsentSchema,
  generated_recipe: generatedRecipeSchema,
} satisfies Record<SyncEntityType, z.ZodTypeAny>;

type EntityPayload = {
  [Entity in SyncEntityType]: z.output<typeof payloadSchemas[Entity]>;
};

const buildEntityMutationSchema = <Entity extends SyncEntityType>(
  entityType: Entity,
  payloadSchema: z.ZodType<EntityPayload[Entity]>,
  entityIdMatches: (entityId: string, payload: EntityPayload[Entity]) => boolean = () => true,
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
  if (mutation.operation === 'upsert' && !entityIdMatches(mutation.entityId, mutation.payload)) {
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
  buildEntityMutationSchema('ai_consent', payloadSchemas.ai_consent, (entityId) => entityId === 'profile'),
  buildEntityMutationSchema('generated_recipe', payloadSchemas.generated_recipe, (entityId, payload) => payload.id === entityId),
]);

export class SyncMutationValidationError extends Error {
  readonly code = 'INVALID_SYNC_MUTATION';

  constructor() {
    super('Sync mutation is invalid');
    this.name = 'SyncMutationValidationError';
  }
}

export const parseSyncMutation = (value: unknown): SyncMutation | null => {
  const result = syncMutationSchema.safeParse(value);
  return result.success ? result.data : null;
};

export const assertSyncMutation = (value: unknown): SyncMutation => {
  const mutation = parseSyncMutation(value);
  if (mutation === null) throw new SyncMutationValidationError();
  return mutation;
};
