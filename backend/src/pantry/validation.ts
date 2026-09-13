import { z } from 'zod';
import type { PantryLot, PantryLotPayload, PantryUnit } from '@ikuck/shared/contracts';

export const pantryUnits = ['g', 'kg', 'ml', 'l', 'piece', 'pack'] as const;
const calendarDate = /^\d{4}-\d{2}-\d{2}$/;

const isValidCalendarDate = (value: string): boolean => {
  if (!calendarDate.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const addQuantityUnitIssues = (value: { quantity: number | null; unit: PantryUnit | null }, context: z.RefinementCtx): void => {
  if (value.quantity === null && value.unit !== null) {
    context.addIssue({ code: 'custom', path: ['quantity'], message: 'Quantity is required when a unit is supplied' });
  }
  if (value.quantity !== null && value.unit === null) {
    context.addIssue({ code: 'custom', path: ['unit'], message: 'Unit is required when a quantity is supplied' });
  }
};

const lotDetailsObject = z.object({
  ingredientId: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(160),
  known: z.boolean(),
  quantity: z.number().finite().positive().nullable(),
  unit: z.enum(pantryUnits).nullable(),
  expiresAt: z.string().refine(isValidCalendarDate).nullable(),
});

export const pantryLotDetailsSchema = lotDetailsObject.superRefine(addQuantityUnitIssues);
export const pantryLotPatchSchema = lotDetailsObject.partial();
export const pantryLotSchema = z.object({
  id: z.string().trim().min(1).max(160),
  ...lotDetailsObject.shape,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine(addQuantityUnitIssues);

export const parsePantryLotDetails = (body: unknown): PantryLotPayload | null => {
  const result = pantryLotDetailsSchema.safeParse(body);
  return result.success ? result.data : null;
};

export const parsePantryLotPatch = (body: unknown): Partial<PantryLotPayload> | null => {
  const result = pantryLotPatchSchema.safeParse(body);
  return result.success ? result.data : null;
};

export const isPantryLot = (value: unknown): value is PantryLot => pantryLotSchema.safeParse(value).success;
