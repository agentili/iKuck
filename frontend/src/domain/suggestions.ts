import { getIngredient } from './ingredients';
import { RECIPES } from './recipes';
import type { IngredientDefinition, PantryRecipe, RecipeSuggestion } from './types';

export interface SuggestionOptions {
  recipes?: readonly PantryRecipe[];
  availableIds: string[];
  allowOneMissing: boolean;
  limit?: number;
  random?: () => number;
}

const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }

  return copy;
};

export const findRecipeSuggestions = ({
  recipes = RECIPES,
  availableIds,
  allowOneMissing,
  limit = 6,
  random = Math.random,
}: SuggestionOptions): RecipeSuggestion[] => {
  const available = new Set(availableIds);
  const eligible = recipes.flatMap((recipe): RecipeSuggestion[] => {
    const missingIngredientIds = recipe.ingredients
      .filter((item) => !item.optional && !available.has(item.ingredientId))
      .map((item) => item.ingredientId);

    if (missingIngredientIds.length === 0) {
      return [{ recipe, missingIngredientIds }];
    }

    const missingIngredient = getIngredient(missingIngredientIds[0]);
    if (
      allowOneMissing &&
      missingIngredientIds.length === 1 &&
      missingIngredient?.easyToFind === true
    ) {
      return [{ recipe, missingIngredientIds }];
    }

    return [];
  });

  const complete = shuffle(
    eligible.filter((suggestion) => suggestion.missingIngredientIds.length === 0),
    random,
  );
  const extended = shuffle(
    eligible.filter((suggestion) => suggestion.missingIngredientIds.length === 1),
    random,
  );

  return [...complete, ...extended].slice(0, Math.max(0, limit));
};

export const findHelpfulIngredients = (
  availableIds: string[],
  limit = 3,
): IngredientDefinition[] => {
  const available = new Set(availableIds);
  const frequencies = new Map<string, number>();

  for (const recipe of RECIPES) {
    for (const item of recipe.ingredients) {
      const ingredient = getIngredient(item.ingredientId);
      if (
        !item.optional &&
        !available.has(item.ingredientId) &&
        ingredient?.easyToFind === true
      ) {
        frequencies.set(item.ingredientId, (frequencies.get(item.ingredientId) ?? 0) + 1);
      }
    }
  }

  return [...frequencies.entries()]
    .sort(([leftId, leftCount], [rightId, rightCount]) =>
      rightCount - leftCount || leftId.localeCompare(rightId),
    )
    .map(([id]) => getIngredient(id))
    .filter((ingredient): ingredient is IngredientDefinition => ingredient !== undefined)
    .slice(0, Math.max(0, limit));
};
