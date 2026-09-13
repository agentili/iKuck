import type { PantryUnit, ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';
import { getIngredient } from './ingredients';
import type { PantryRecipe, RecipeIngredient } from './types';

export const SHOPPING_LIST_UNITS: readonly PantryUnit[] = ['g', 'kg', 'ml', 'l', 'piece', 'pack'];

export type ShoppingListValidationError =
  | 'label_required'
  | 'label_too_long'
  | 'quantity_finite'
  | 'quantity_positive'
  | 'unit_required'
  | 'quantity_required'
  | 'unit_invalid'
  | 'note_too_long';

export interface ParsedRecipeAmount {
  quantity: number | null;
  unit: PantryUnit | null;
  note: string | null;
}

export const validateShoppingListItemDetails = (
  label: string,
  quantity: number | null,
  unit: PantryUnit | null,
  note: string | null,
): ShoppingListValidationError[] => {
  const errors: ShoppingListValidationError[] = [];
  const normalizedLabel = label.trim();
  if (normalizedLabel.length === 0) errors.push('label_required');
  if (normalizedLabel.length > 120) errors.push('label_too_long');

  if (quantity === null) {
    if (unit !== null) errors.push('quantity_required');
  } else if (!Number.isFinite(quantity)) {
    errors.push('quantity_finite');
  } else if (quantity <= 0) {
    errors.push('quantity_positive');
  }

  if (quantity !== null && unit === null) errors.push('unit_required');
  if (unit !== null && !SHOPPING_LIST_UNITS.includes(unit)) errors.push('unit_invalid');
  if (note !== null && note.trim().length > 120) errors.push('note_too_long');
  return errors;
};

const numericAmount = /^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i;
const bareAmount = /^(\d+(?:[.,]\d+)?)$/;

export const parseRecipeAmount = (amount: string): ParsedRecipeAmount => {
  const normalized = amount.trim();
  const measured = normalized.match(numericAmount);
  if (measured !== null) {
    return {
      quantity: Number.parseFloat(measured[1].replace(',', '.')),
      unit: measured[2].toLowerCase() as PantryUnit,
      note: null,
    };
  }

  const bare = normalized.match(bareAmount);
  if (bare !== null) {
    return { quantity: Number.parseFloat(bare[1].replace(',', '.')), unit: 'piece', note: null };
  }

  return { quantity: null, unit: null, note: normalized.length > 0 ? normalized : null };
};

export const createShoppingListItemFromRecipe = (
  recipe: PantryRecipe,
  ingredient: RecipeIngredient,
  label = getIngredient(ingredient.ingredientId)?.label ?? ingredient.ingredientId,
): ShoppingListItemPayload => ({
  ingredientId: ingredient.ingredientId,
  label,
  ...parseRecipeAmount(ingredient.amount),
  purchased: false,
  sourceRecipeId: recipe.id,
});

export const isShoppingListItem = (value: unknown): value is ShoppingListItem => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ShoppingListItem>;
  return typeof candidate.id === 'string'
    && typeof candidate.ingredientId === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.purchased === 'boolean'
    && (candidate.quantity === null || (typeof candidate.quantity === 'number' && Number.isFinite(candidate.quantity) && candidate.quantity > 0))
    && (candidate.unit === null || (typeof candidate.unit === 'string' && SHOPPING_LIST_UNITS.includes(candidate.unit as PantryUnit)))
    && (candidate.quantity === null ? candidate.unit === null : candidate.unit !== null)
    && (candidate.note === null || typeof candidate.note === 'string')
    && (candidate.sourceRecipeId === null || typeof candidate.sourceRecipeId === 'string')
    && typeof candidate.createdAt === 'string'
    && !Number.isNaN(new Date(candidate.createdAt).getTime())
    && typeof candidate.updatedAt === 'string'
    && !Number.isNaN(new Date(candidate.updatedAt).getTime())
    && validateShoppingListItemDetails(candidate.label, candidate.quantity, candidate.unit, candidate.note).length === 0;
};
