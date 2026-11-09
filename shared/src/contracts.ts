export const SYNC_ENTITY_TYPES = [
  'pantry_item',
  'pantry_lot',
  'staple_preference',
  'shopping_list_item',
  'cook_event',
  'recipe_preference',
  'diet_profile',
  'ai_consent',
  'generated_recipe',
  'dinner_entry',
  'saved_recipe',
  'meal_plan_entry',
] as const;

export type SyncEntityType = typeof SYNC_ENTITY_TYPES[number];

export const HOUSE_SYNC_ENTITY_TYPES = [
  'pantry_item',
  'pantry_lot',
  'staple_preference',
  'shopping_list_item',
  'cook_event',
  'recipe_preference',
  'diet_profile',
  'generated_recipe',
  'dinner_entry',
  'saved_recipe',
  'meal_plan_entry',
] as const satisfies readonly SyncEntityType[];

export const PERSONAL_SYNC_ENTITY_TYPES = [
  'ai_consent',
] as const satisfies readonly SyncEntityType[];

export type SyncOperation = 'upsert' | 'delete';

export type SyncMutationScope = `account:${string}` | `house:${string}`;

export type PlanVersion = 2;

export type PlanState = { date: string; revision: string; serverSequence: number } & (
  | { kind: 'automatic' | 'manual'; recipeId: string }
  | { kind: 'deleted'; recipeId: null }
);

export type PlanCommandBase = {
  version: PlanVersion;
  scope: SyncMutationScope;
  date: string;
  operationId: string;
  deviceId: string;
  clientUpdatedAt: string;
};

export type PlanCommand = PlanCommandBase & (
  | { action: 'manual_set'; recipeId: string }
  | { action: 'manual_delete' }
  | { action: 'auto_create'; recipeId: string; baseRevision: null }
  | { action: 'explicit_regenerate'; recipeId: string; baseRevision: string }
);

export interface PlanResult {
  version: PlanVersion;
  operationId: string;
  outcome: 'applied' | 'conflict';
  current: PlanState | null;
}

export interface MealPlanCapabilities {
  version: PlanVersion;
  syncReadVersion: 2;
}

export interface HouseTimeZoneState {
  timeZone: string | null;
  revision: string | null;
}

export interface SyncMutation {
  mutationId: string;
  deviceId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: unknown | null;
  clientUpdatedAt: string;
  syncScope?: SyncMutationScope;
}

export interface SyncChange extends SyncMutation {
  serverSequence: number;
}

export interface SyncChangeSet {
  changes: SyncChange[];
  nextCursor: number;
}

export interface AccountSummary {
  id: string;
  email: string;
  emailVerifiedAt: string;
}

export type HouseRole = 'admin' | 'member';

export interface HouseSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface HouseMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: HouseRole;
  joinedAt: string;
}

export interface HouseState {
  house: HouseSummary | null;
  membership: { role: HouseRole; joinedAt: string } | null;
  members: HouseMember[];
}

export type DietType = 'omnivore' | 'vegetarian' | 'pescatarian' | 'vegan';

export type EuAllergen =
  | 'gluten'
  | 'crustaceans'
  | 'eggs'
  | 'fish'
  | 'peanuts'
  | 'soybeans'
  | 'milk'
  | 'nuts'
  | 'celery'
  | 'mustard'
  | 'sesame'
  | 'sulphites'
  | 'lupin'
  | 'molluscs';

export interface NutritionFilter {
  maxCaloriesPerServing: number | null;
  minProteinGramsPerServing: number | null;
}

export interface DietProfilePayload {
  diet: DietType;
  excludedAllergens: EuAllergen[];
  nutrition: NutritionFilter;
}

export interface DietProfile extends DietProfilePayload {
  updatedAt: string;
}

export interface AiConsent {
  enabled: boolean;
  updatedAt: string;
  homeProvider?: AiRecipeProvider;
  dinnerProvider?: AiRecipeProvider;
  chatProvider?: AiRecipeProvider;
  chatPolicyVersion?: 'chef-chat-v1';
}

export type AiRecipeProvider = 'openai' | 'gemini';

export interface ChefChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChefChatRequest {
  message: string;
  history: ChefChatTurn[];
}

export interface ChefChatResponse {
  reply: string;
}

export interface GeneratedRecipeIngredient {
  name: string;
  amount: string;
}

export interface GeneratedRecipeDraft {
  title: string;
  description: string;
  ingredients: GeneratedRecipeIngredient[];
  steps: string[];
  diets: DietType[];
  allergens: EuAllergen[];
}

export interface GeneratedRecipe extends GeneratedRecipeDraft {
  id: string;
  source: 'ai';
  createdAt: string;
  updatedAt: string;
}

export interface RecipeNutrition {
  caloriesPerServing: number | null;
  proteinGramsPerServing: number | null;
  carbohydrateGramsPerServing: number | null;
  fatGramsPerServing: number | null;
  source: 'catalog_estimate' | 'usda';
  isComplete: boolean;
  missingNutrients: string[];
}

export type PantryUnit = 'g' | 'kg' | 'ml' | 'l' | 'piece' | 'pack';

export interface PantryLotPayload {
  ingredientId: string;
  label: string;
  known: boolean;
  quantity: number | null;
  unit: PantryUnit | null;
  expiresAt: string | null;
}

export interface PantryLot extends PantryLotPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingListItemPayload {
  ingredientId: string;
  label: string;
  quantity: number | null;
  unit: PantryUnit | null;
  note: string | null;
  purchased: boolean;
  sourceRecipeId: string | null;
}

export interface ShoppingListItem extends ShoppingListItemPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface CookEventPayload {
  recipeId: string;
  recipeTitle: string;
  servings: number;
  cookedAt: string;
  note: string | null;
}

export interface CookEvent extends CookEventPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecipePreferencePayload {
  recipeId: string;
  favorite: boolean;
  rating: number | null;
  note: string | null;
}

export interface RecipePreference extends RecipePreferencePayload {
  createdAt: string;
  updatedAt: string;
}

// Push preferences are account-wide; subscriptions belong to a single browser/session.
export interface PushPreferences {
  enabled: boolean;
  fridayTime: string;
  timeZone: string;
}
export interface PushStatus {
  preferencesConfigured: boolean;
  enabled: boolean;
  publicKey: string | null;
  preferences: PushPreferences;
  effectiveTimeZone: string;
}
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface WeeklyPushPayload {
  accountId: string;
  title: string;
  body: string;
  url: string;
  tag: string;
  expiresAt: string;
}
