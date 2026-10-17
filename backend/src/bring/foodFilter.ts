import { INGREDIENTS, normalizeIngredientName, type ParsedIngredient } from '@ikuck/shared/ingredients';

const ingredientsByAlias = new Map<string, ParsedIngredient>();
for (const ingredient of INGREDIENTS) {
  const parsed: ParsedIngredient = { id: ingredient.id, label: ingredient.label, known: true };
  for (const alias of [ingredient.label, ...ingredient.aliases]) {
    ingredientsByAlias.set(normalizeIngredientName(alias), parsed);
  }
}

export const matchFoodIngredient = (label: string): ParsedIngredient | null => {
  const normalized = normalizeIngredientName(label);
  if (normalized.length === 0) return null;
  return ingredientsByAlias.get(normalized) ?? null;
};

export const isFoodItem = (label: string): boolean => matchFoodIngredient(label) !== null;
