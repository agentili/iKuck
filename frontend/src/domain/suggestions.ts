import { getIngredient } from './ingredients';
import { isRecipeCompatible } from './dietary';
import { getQuantityWarning, type PantryQuantityAggregate } from './pantryLots';
import { RECIPES } from './recipes';
import type { CookEvent, DietProfilePayload, RecipePreference } from '@ikuck/shared/contracts';
import type { IngredientDefinition, PantryRecipe, RecipeSuggestion } from './types';

export interface SuggestionPersonalization {
  events?: readonly CookEvent[];
  preferences?: readonly RecipePreference[];
  random?: () => number;
}

export interface SuggestionOptions {
  recipes?: readonly PantryRecipe[];
  availableIds: string[];
  allowOneMissing: boolean;
  limit?: number;
  random?: () => number;
  quantitySummaries?: readonly PantryQuantityAggregate[];
  dietProfile?: DietProfilePayload;
  events?: readonly CookEvent[];
  preferences?: readonly RecipePreference[];
}

export interface HelpfulIngredientOptions {
  excludedIds?: readonly string[];
  random?: () => number;
}

export const createSeededRandom = (seed: number): (() => number) => {
  let index = 0;
  return () => {
    const value = Math.sin((Math.trunc(seed) + 1) * 12989.8 + index * 7823.3) * 43758.5453;
    index += 1;
    return value - Math.floor(value);
  };
};

export const rankRecipeSuggestions = (
  suggestions: readonly RecipeSuggestion[],
  { events = [], preferences = [], random = Math.random }: SuggestionPersonalization = {},
): RecipeSuggestion[] => {
  const preferenceByRecipeId = new Map(preferences.map((preference) => [preference.recipeId, preference]));
  const cookedRecipeIds = new Set(events.map((event) => event.recipeId));
  const randomByRecipeId = new Map(suggestions.map((suggestion) => [suggestion.recipe.id, random()]));
  const score = (suggestion: RecipeSuggestion): number => {
    const preference = preferenceByRecipeId.get(suggestion.recipe.id);
    const completeness = suggestion.missingIngredientIds.length === 0 ? 1000 : 0;
    const favorite = preference?.favorite === true ? 300 : 0;
    const rating = preference?.rating !== null && preference?.rating !== undefined && preference.rating >= 4
      ? preference.rating * 20
      : 0;
    const variety = cookedRecipeIds.has(suggestion.recipe.id) ? -10 : 0;
    return completeness + favorite + rating + variety;
  };

  return [...suggestions].sort((left, right) => {
    const scoreDifference = score(right) - score(left);
    if (scoreDifference !== 0) return scoreDifference;
    const randomDifference = (randomByRecipeId.get(right.recipe.id) ?? 0) - (randomByRecipeId.get(left.recipe.id) ?? 0);
    if (randomDifference !== 0) return randomDifference;
    return left.recipe.id.localeCompare(right.recipe.id);
  });
};

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
  quantitySummaries = [],
  dietProfile,
  events = [],
  preferences = [],
}: SuggestionOptions): RecipeSuggestion[] => {
  const available = new Set(availableIds);
  const summariesById = new Map(quantitySummaries.map((summary) => [summary.ingredientId, summary]));
  const eligible = recipes.flatMap((recipe): RecipeSuggestion[] => {
    if (dietProfile !== undefined && !isRecipeCompatible(recipe.id, dietProfile)) return [];
    const missingIngredientIds = recipe.ingredients
      .filter((item) => !item.optional && !available.has(item.ingredientId))
      .map((item) => item.ingredientId);

    if (missingIngredientIds.length === 0) {
      return [{
        recipe,
        missingIngredientIds,
        quantityWarnings: recipe.ingredients
          .filter((item) => !item.optional && available.has(item.ingredientId))
          .filter((item) => getQuantityWarning(item, summariesById.get(item.ingredientId)))
          .map((item) => item.ingredientId),
      }];
    }

    const missingIngredient = getIngredient(missingIngredientIds[0]);
    if (
      allowOneMissing &&
      missingIngredientIds.length === 1 &&
      missingIngredient?.easyToFind === true
    ) {
      return [{
        recipe,
        missingIngredientIds,
        quantityWarnings: [],
      }];
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

  return rankRecipeSuggestions(
    [...complete, ...extended].slice(0, Math.max(0, limit)),
    { events, preferences, random },
  );
};

export const findHelpfulIngredients = (
  availableIds: string[],
  limit = 3,
  { excludedIds = [], random }: HelpfulIngredientOptions = {},
): IngredientDefinition[] => {
  const available = new Set(availableIds);
  const excluded = new Set(excludedIds);
  const frequencies = new Map<string, number>();

  for (const recipe of RECIPES) {
    for (const item of recipe.ingredients) {
      const ingredient = getIngredient(item.ingredientId);
      if (
        !item.optional &&
        !available.has(item.ingredientId) &&
        !excluded.has(item.ingredientId) &&
        ingredient?.easyToFind === true
      ) {
        frequencies.set(item.ingredientId, (frequencies.get(item.ingredientId) ?? 0) + 1);
      }
    }
  }

  const ranked = [...frequencies.entries()]
    .sort(([leftId, leftCount], [rightId, rightCount]) =>
      rightCount - leftCount || leftId.localeCompare(rightId),
    );
  const ordered = random === undefined ? ranked : shuffle(ranked, random);

  return ordered
    .map(([id]) => getIngredient(id))
    .filter((ingredient): ingredient is IngredientDefinition => ingredient !== undefined)
    .slice(0, Math.max(0, limit));
};
