export type RecipeCategory = 'meat' | 'fish' | 'eggs' | 'legumes' | 'vegetables';

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
}

export interface PantryRecipe {
  id: string;
  title: string;
  description: string;
  category: RecipeCategory;
  durationMinutes: number;
  difficulty: 'easy' | 'medium';
  servings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
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
