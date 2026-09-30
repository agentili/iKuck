import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { parseIngredientInput } from './ingredients';
import type { PantryRecipe } from './types';
import type { SyncScope } from '../sync/scopeContext';

export interface ScopedSavedRecipe { scope: SyncScope; value: SavedRecipe }

const scopeToken = (scope: SyncScope): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of scope) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
};

const pantryIngredientId = (name: string, explicitId: string | null): string => {
  const parsed = parseIngredientInput(name)[0];
  if (parsed?.known) return parsed.id;
  if (explicitId !== null && parseIngredientInput(explicitId)[0]?.known) return explicitId;
  return parsed?.id ?? `custom:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
};

export const toDiaryPantryRecipe = ({ scope, value }: ScopedSavedRecipe): PantryRecipe => ({
  id: `diary-${scopeToken(scope)}-${value.id}`,
  title: value.title,
  description: value.description,
  category: 'diary',
  durationMinutes: value.durationMinutes,
  difficulty: 'unknown',
  servings: value.servings,
  ingredients: value.ingredients.map((ingredient) => ({
    ingredientId: pantryIngredientId(ingredient.name, ingredient.ingredientId),
    amount: ingredient.amount,
    optional: ingredient.optional,
    name: ingredient.name,
  })),
  steps: [...value.steps],
  tags: ['diario'],
  source: 'diary',
  diary: {
    scope,
    savedRecipeId: value.id,
    diets: value.diets === null ? null : [...value.diets],
    allergens: value.allergens === null ? null : [...value.allergens],
    suggestedFields: [...value.suggestedFields],
  },
});
