import type { DietType, EuAllergen } from '@ikuck/shared/contracts';
import type { DiarySuggestedField } from '@ikuck/shared/dinnerDiary';
import type { SyncScope } from '../sync/scopeContext';

export type RecipeCategory = 'meat' | 'fish' | 'eggs' | 'legumes' | 'vegetables' | 'diary';

export type IngredientCategory =
  | 'staple'
  | 'grain'
  | 'meat'
  | 'fish'
  | 'egg'
  | 'legume'
  | 'vegetable'
  | 'dairy';

export interface IngredientDefinition {
  id: string;
  label: string;
  aliases: string[];
  category: IngredientCategory;
  easyToFind: boolean;
  staple: boolean;
}

export interface ParsedIngredient {
  id: string;
  label: string;
  known: boolean;
}

export interface RecipeIngredient {
  ingredientId: string;
  amount: string;
  optional?: boolean;
  name?: string;
}

export interface DiaryRecipeMetadata {
  scope: SyncScope;
  savedRecipeId: string;
  diets: DietType[] | null;
  allergens: EuAllergen[] | null;
  suggestedFields: readonly DiarySuggestedField[];
}

export interface PantryRecipe {
  id: string;
  title: string;
  description: string;
  category: RecipeCategory;
  durationMinutes: number | null;
  difficulty: 'easy' | 'medium' | 'unknown';
  servings: number | null;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
  source?: 'diary';
  diary?: DiaryRecipeMetadata;
}

export interface RecipeSuggestion {
  recipe: PantryRecipe;
  missingIngredientIds: string[];
  quantityWarnings: string[];
}

export interface AiRecipeGenerationState {
  consentEnabled: boolean;
  recipes: import('@ikuck/shared/contracts').GeneratedRecipe[];
}
