import type { SyncEntityType, SyncMutation } from '@ikuck/shared/contracts';
import type { PantryUnit } from '@ikuck/shared/contracts';

const PANTRY_UNITS: readonly PantryUnit[] = ['g', 'kg', 'ml', 'l', 'piece', 'pack'];
const DIET_TYPES = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'] as const;
const EU_ALLERGENS = [
  'gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts',
  'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs',
] as const;
const SYNC_ENTITY_TYPES: readonly SyncEntityType[] = [
  'pantry_item', 'pantry_lot', 'staple_preference', 'shopping_list_item', 'cook_event',
  'recipe_preference', 'diet_profile', 'ai_consent', 'generated_recipe',
];

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object'
  && value !== null && !Array.isArray(value);

const hasExactKeys = (value: unknown, keys: readonly string[]): value is RecordValue => {
  if (!isRecord(value)) return false;
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
};

const isBoundedString = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= max;

const isOptionalString = (value: unknown, max: number): value is string | null => value === null
  || (typeof value === 'string' && value.length <= max);

const isSyncEntityType = (value: unknown): value is SyncEntityType => typeof value === 'string'
  && SYNC_ENTITY_TYPES.includes(value as SyncEntityType);

const isDateTime = (value: unknown): value is string => typeof value === 'string'
  && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && !Number.isNaN(new Date(value).getTime());

const isCalendarDate = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const isQuantityAndUnitValid = (quantity: unknown, unit: unknown): boolean => {
  const validQuantity = quantity === null
    || (typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0);
  const validUnit = unit === null || (typeof unit === 'string' && PANTRY_UNITS.includes(unit as PantryUnit));
  return validQuantity && validUnit && (quantity === null ? unit === null : unit !== null);
};

export const isPantryItemPayload = (value: unknown): value is { id: string; label: string; known: boolean } => (
  hasExactKeys(value, ['id', 'label', 'known'])
    && isBoundedString(value.id, 160)
    && isBoundedString(value.label, 160)
    && typeof value.known === 'boolean'
);

const isPantryLotPayload = (value: unknown): boolean => hasExactKeys(value, [
  'id', 'ingredientId', 'label', 'known', 'quantity', 'unit', 'expiresAt', 'createdAt', 'updatedAt',
]) && isBoundedString(value.id, 160)
  && isBoundedString(value.ingredientId, 128)
  && isBoundedString(value.label, 160)
  && typeof value.known === 'boolean'
  && isQuantityAndUnitValid(value.quantity, value.unit)
  && (value.expiresAt === null || isCalendarDate(value.expiresAt))
  && isDateTime(value.createdAt)
  && isDateTime(value.updatedAt);

const isShoppingListItemPayload = (value: unknown): boolean => hasExactKeys(value, [
  'id', 'ingredientId', 'label', 'quantity', 'unit', 'note', 'purchased', 'sourceRecipeId', 'createdAt', 'updatedAt',
]) && isBoundedString(value.id, 160)
  && isBoundedString(value.ingredientId, 128)
  && isBoundedString(value.label, 120)
  && isQuantityAndUnitValid(value.quantity, value.unit)
  && isOptionalString(value.note, 120)
  && typeof value.purchased === 'boolean'
  && isOptionalString(value.sourceRecipeId, 160)
  && isDateTime(value.createdAt)
  && isDateTime(value.updatedAt);

const isCookEventPayload = (value: unknown): boolean => hasExactKeys(value, [
  'id', 'recipeId', 'recipeTitle', 'servings', 'cookedAt', 'note', 'createdAt', 'updatedAt',
]) && isBoundedString(value.id, 160)
  && isBoundedString(value.recipeId, 160)
  && isBoundedString(value.recipeTitle, 160)
  && typeof value.servings === 'number'
  && Number.isInteger(value.servings)
  && value.servings > 0
  && isDateTime(value.cookedAt)
  && isOptionalString(value.note, 500)
  && isDateTime(value.createdAt)
  && isDateTime(value.updatedAt);

const isRecipePreferencePayload = (value: unknown): boolean => hasExactKeys(value, [
  'recipeId', 'favorite', 'rating', 'note', 'createdAt', 'updatedAt',
]) && isBoundedString(value.recipeId, 160)
  && typeof value.favorite === 'boolean'
  && (value.rating === null || (typeof value.rating === 'number' && Number.isInteger(value.rating) && value.rating >= 1 && value.rating <= 5))
  && isOptionalString(value.note, 500)
  && isDateTime(value.createdAt)
  && isDateTime(value.updatedAt);

const isDietProfilePayload = (value: unknown): boolean => hasExactKeys(value, [
  'diet', 'excludedAllergens', 'nutrition', 'updatedAt',
]) && typeof value.diet === 'string'
  && DIET_TYPES.includes(value.diet as typeof DIET_TYPES[number])
  && Array.isArray(value.excludedAllergens)
  && value.excludedAllergens.length <= EU_ALLERGENS.length
  && new Set(value.excludedAllergens).size === value.excludedAllergens.length
  && value.excludedAllergens.every((allergen) => typeof allergen === 'string'
    && EU_ALLERGENS.includes(allergen as typeof EU_ALLERGENS[number]))
  && hasExactKeys(value.nutrition, ['maxCaloriesPerServing', 'minProteinGramsPerServing'])
  && (value.nutrition.maxCaloriesPerServing === null
    || (typeof value.nutrition.maxCaloriesPerServing === 'number'
      && Number.isFinite(value.nutrition.maxCaloriesPerServing) && value.nutrition.maxCaloriesPerServing >= 0))
  && (value.nutrition.minProteinGramsPerServing === null
    || (typeof value.nutrition.minProteinGramsPerServing === 'number'
      && Number.isFinite(value.nutrition.minProteinGramsPerServing) && value.nutrition.minProteinGramsPerServing >= 0))
  && isDateTime(value.updatedAt);

const isAiConsentPayload = (value: unknown): boolean => hasExactKeys(value, ['enabled', 'updatedAt'])
  && typeof value.enabled === 'boolean'
  && isDateTime(value.updatedAt);

const isGeneratedRecipePayload = (value: unknown): boolean => hasExactKeys(value, [
  'id', 'source', 'title', 'description', 'ingredients', 'steps', 'diets', 'allergens', 'createdAt', 'updatedAt',
]) && isBoundedString(value.id, 128)
  && value.source === 'ai'
  && isBoundedString(value.title, 120)
  && isBoundedString(value.description, 500)
  && Array.isArray(value.ingredients)
  && value.ingredients.length >= 1
  && value.ingredients.length <= 30
  && value.ingredients.every((ingredient) => hasExactKeys(ingredient, ['name', 'amount'])
    && isBoundedString(ingredient.name, 120) && isBoundedString(ingredient.amount, 80))
  && Array.isArray(value.steps)
  && value.steps.length >= 1
  && value.steps.length <= 20
  && value.steps.every((step) => isBoundedString(step, 500))
  && Array.isArray(value.diets)
  && value.diets.length >= 1
  && value.diets.length <= DIET_TYPES.length
  && new Set(value.diets).size === value.diets.length
  && value.diets.every((diet) => typeof diet === 'string' && DIET_TYPES.includes(diet as typeof DIET_TYPES[number]))
  && Array.isArray(value.allergens)
  && value.allergens.length <= EU_ALLERGENS.length
  && new Set(value.allergens).size === value.allergens.length
  && value.allergens.every((allergen) => typeof allergen === 'string'
    && EU_ALLERGENS.includes(allergen as typeof EU_ALLERGENS[number]))
  && isDateTime(value.createdAt)
  && isDateTime(value.updatedAt);

const isSyncMutationRecord = (value: unknown): value is SyncMutation => {
  if (!isRecord(value)) return false;
  return isBoundedString(value.mutationId, 128)
    && isBoundedString(value.deviceId, 128)
    && isBoundedString(value.entityId, 128)
    && isSyncEntityType(value.entityType)
    && (value.operation === 'upsert' || value.operation === 'delete')
    && isDateTime(value.clientUpdatedAt);
};

export const isStaplePreferencePayload = (value: unknown): value is { enabled: boolean } => (
  hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
);

const isEntityPayloadValid = (entityType: SyncEntityType, entityId: string, payload: unknown): boolean => {
  switch (entityType) {
    case 'pantry_item': return isPantryItemPayload(payload) && payload.id === entityId;
    case 'pantry_lot': return isPantryLotPayload(payload) && isRecord(payload) && payload.id === entityId;
    case 'staple_preference': return isStaplePreferencePayload(payload);
    case 'shopping_list_item': return isShoppingListItemPayload(payload) && isRecord(payload) && payload.id === entityId;
    case 'cook_event': return isCookEventPayload(payload) && isRecord(payload) && payload.id === entityId;
    case 'recipe_preference': return isRecipePreferencePayload(payload) && isRecord(payload) && payload.recipeId === entityId;
    case 'diet_profile': return entityId === 'profile' && isDietProfilePayload(payload);
    case 'ai_consent': return entityId === 'profile' && isAiConsentPayload(payload);
    case 'generated_recipe': return isGeneratedRecipePayload(payload) && isRecord(payload) && payload.id === entityId;
  }
};

export class SyncMutationValidationError extends Error {
  readonly code = 'INVALID_SYNC_MUTATION';

  constructor() {
    super('Sync mutation is invalid');
    this.name = 'SyncMutationValidationError';
  }
}

export const parseSyncMutation = (value: unknown): SyncMutation | null => {
  if (!isRecord(value) || !isSyncMutationRecord(value)) return null;

  if (value.operation === 'delete') {
    if (value.payload !== null || (value.entityType === 'diet_profile' && value.entityId !== 'profile')
      || (value.entityType === 'ai_consent' && value.entityId !== 'profile')) return null;
  } else if (!isEntityPayloadValid(value.entityType, value.entityId, value.payload)) {
    return null;
  }

  return value;
};

export const assertSyncMutation = (value: unknown): SyncMutation => {
  const mutation = parseSyncMutation(value);
  if (mutation === null) throw new SyncMutationValidationError();
  return mutation;
};
