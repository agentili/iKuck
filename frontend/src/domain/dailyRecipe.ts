import type { DietProfilePayload } from '@ikuck/shared/contracts';
import { isRecipeCompatible } from './dietary';
import type { PantryRecipe } from './types';

export interface DailyRecipeOptions {
  recipes: readonly PantryRecipe[];
  availableIds: readonly string[];
  profile: DietProfilePayload;
  date: string;
  previousIds: readonly string[];
}

export interface DailyRecipeSelection {
  recipe: PantryRecipe;
  missingIngredientIds: string[];
  reasons: string[];
}

export const isDailyResultCurrent = (result: { scope: string; date: string }, scope: string, date: string): boolean => result.scope === scope && result.date === date;

export function selectDailyRecipe(options: DailyRecipeOptions): DailyRecipeSelection | null {
  const available = new Set(options.availableIds);
  const choices = options.recipes.filter((recipe) => isRecipeCompatible(recipe, options.profile)).map((recipe) => {
    const missingIngredientIds = [...new Set(recipe.ingredients.filter((item) => !item.optional && !available.has(item.ingredientId)).map((item) => item.ingredientId))];
    const reasons: string[] = [];
    if (missingIngredientIds.length > 1) reasons.push('missing');
    if (recipe.durationMinutes === null || recipe.durationMinutes > 30) reasons.push('duration');
    return { recipe, missingIngredientIds, reasons };
  });
  choices.sort((a, b) => a.reasons.length - b.reasons.length || Number(options.previousIds.includes(a.recipe.id)) - Number(options.previousIds.includes(b.recipe.id)) || a.missingIngredientIds.length - b.missingIngredientIds.length || a.recipe.id.localeCompare(b.recipe.id));
  return choices[0] ?? null;
}
