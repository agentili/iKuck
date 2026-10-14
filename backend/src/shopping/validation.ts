import { z } from 'zod';
import type { ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';

const shoppingListUnits = ['g', 'kg', 'ml', 'l', 'piece', 'pack'] as const;

export const SHOPPING_LIST_INGREDIENT_ID_MAX_LENGTH = 128;
export const SHOPPING_LIST_LABEL_MAX_LENGTH = 120;
export const SHOPPING_LIST_NOTE_MAX_LENGTH = 120;

const addQuantityUnitIssues = (value: { quantity: number | null; unit: ShoppingListItemPayload['unit'] }, context: z.RefinementCtx): void => {
  if (value.quantity === null && value.unit !== null) {
    context.addIssue({ code: 'custom', path: ['quantity'], message: 'Quantity is required when a unit is supplied' });
  }
  if (value.quantity !== null && value.unit === null) {
    context.addIssue({ code: 'custom', path: ['unit'], message: 'Unit is required when a quantity is supplied' });
  }
};

const detailsObject = z.object({
  ingredientId: z.string().trim().min(1).max(SHOPPING_LIST_INGREDIENT_ID_MAX_LENGTH),
  label: z.string().trim().min(1).max(SHOPPING_LIST_LABEL_MAX_LENGTH),
  quantity: z.number().finite().positive().nullable(),
  unit: z.enum(shoppingListUnits).nullable(),
  note: z.string().trim().max(SHOPPING_LIST_NOTE_MAX_LENGTH).nullable(),
  purchased: z.boolean(),
  sourceRecipeId: z.string().trim().max(160).nullable(),
});

export const shoppingListItemDetailsSchema = detailsObject.superRefine(addQuantityUnitIssues);
export const shoppingListItemPatchSchema = detailsObject.partial();
export const shoppingListItemSchema = z.object({
  id: z.string().trim().min(1).max(160),
  ...detailsObject.shape,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine(addQuantityUnitIssues);

export const parseShoppingListItemDetails = (body: unknown): ShoppingListItemPayload | null => {
  const result = shoppingListItemDetailsSchema.safeParse(body);
  return result.success ? result.data : null;
};

export const parseShoppingListItemPatch = (body: unknown): Partial<ShoppingListItemPayload> | null => {
  const result = shoppingListItemPatchSchema.safeParse(body);
  return result.success ? result.data : null;
};

export const isShoppingListItem = (value: unknown): value is ShoppingListItem => shoppingListItemSchema.safeParse(value).success;
