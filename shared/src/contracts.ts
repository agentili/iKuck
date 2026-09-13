export type SyncEntityType = 'pantry_item' | 'pantry_lot' | 'staple_preference' | 'shopping_list_item' | 'cook_event' | 'recipe_preference' | 'diet_profile' | 'ai_consent' | 'generated_recipe';

export type SyncOperation = 'upsert' | 'delete';

export interface SyncMutation {
  mutationId: string;
  deviceId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: unknown | null;
  clientUpdatedAt: string;
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
