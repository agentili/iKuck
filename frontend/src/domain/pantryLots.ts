import type { PantryLot, PantryUnit } from '@ikuck/shared/contracts';
import {
  basePantryUnit,
  getPantryQuantityFamily,
  parsePantryQuantity,
  toBasePantryQuantity,
  type PantryQuantity,
} from '@ikuck/shared/pantryConsumption';
import type { RecipeIngredient } from './types';

export type { PantryQuantity } from '@ikuck/shared/pantryConsumption';

export type ExpiryStatus = 'unknown' | 'expired' | 'expiring_soon' | 'okay';

export interface PantryQuantityAggregate {
  ingredientId: string;
  label: string;
  lotCount: number;
  quantities: PantryQuantity[];
  totalQuantity: number | null;
  totalUnit: PantryUnit | null;
  earliestExpiresAt: string | null;
}

const isValidCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const validatePantryLotDetails = (
  quantity: number | null,
  unit: PantryUnit | null,
  expiresAt: string | null,
): string[] => {
  const errors: string[] = [];

  if (quantity !== null && !Number.isFinite(quantity)) errors.push('quantity_finite');
  if (quantity !== null && Number.isFinite(quantity) && quantity <= 0) errors.push('quantity_positive');
  if (quantity !== null && unit === null) errors.push('unit_required');
  if (quantity === null && unit !== null) errors.push('quantity_required');
  if (expiresAt !== null && !isValidCalendarDate(expiresAt)) errors.push('expiry_invalid');

  return errors;
};

const aggregateQuantities = (quantities: PantryQuantity[]): { totalQuantity: number | null; totalUnit: PantryUnit | null } => {
  if (quantities.length === 0) return { totalQuantity: null, totalUnit: null };
  const families = new Set(quantities.map(({ unit }) => getPantryQuantityFamily(unit)));
  if (families.size !== 1) return { totalQuantity: null, totalUnit: null };

  const [first] = quantities;
  return {
    totalQuantity: quantities.reduce((total, quantity) => total + toBasePantryQuantity(quantity.quantity, quantity.unit), 0),
    totalUnit: basePantryUnit(first.unit),
  };
};

export const aggregatePantryLots = (lots: readonly PantryLot[]): PantryQuantityAggregate[] => {
  const grouped = new Map<string, PantryLot[]>();
  for (const lot of lots) {
    const group = grouped.get(lot.ingredientId) ?? [];
    group.push(lot);
    grouped.set(lot.ingredientId, group);
  }

  return [...grouped.values()].map((ingredientLots) => {
    const [first] = ingredientLots;
    const quantities = ingredientLots
      .filter((lot): lot is PantryLot & { quantity: number; unit: PantryUnit } => lot.quantity !== null && lot.unit !== null)
      .map(({ quantity, unit }) => ({ quantity, unit }));
    const totals = aggregateQuantities(quantities);
    const expiryDates = ingredientLots
      .map((lot) => lot.expiresAt)
      .filter((date): date is string => date !== null)
      .sort();

    return {
      ingredientId: first.ingredientId,
      label: first.label,
      lotCount: ingredientLots.length,
      quantities,
      ...totals,
      earliestExpiresAt: expiryDates[0] ?? null,
    };
  });
};

const calendarDayIndex = (year: number, month: number, day: number): number => Date.UTC(year, month, day) / (24 * 60 * 60 * 1000);

const localCalendarDayIndex = (date: Date): number => calendarDayIndex(date.getFullYear(), date.getMonth(), date.getDate());

const expiryCalendarDayIndex = (value: string): number => {
  const [year, month, day] = value.split('-').map(Number);
  return calendarDayIndex(year, month - 1, day);
};

export const getExpiryStatus = (expiresAt: string | null, now = new Date()): ExpiryStatus => {
  if (expiresAt === null || !isValidCalendarDate(expiresAt)) return 'unknown';

  const differenceInDays = expiryCalendarDayIndex(expiresAt) - localCalendarDayIndex(now);
  if (differenceInDays < 0) return 'expired';
  if (differenceInDays <= 3) return 'expiring_soon';
  return 'okay';
};

export const getQuantityWarning = (
  recipeIngredient: Pick<RecipeIngredient, 'ingredientId' | 'amount'>,
  aggregate: PantryQuantityAggregate | undefined,
): boolean => {
  if (aggregate === undefined || aggregate.totalQuantity === null || aggregate.totalUnit === null) return false;
  const required = parsePantryQuantity(recipeIngredient.amount, 'prefix');
  if (required === null || getPantryQuantityFamily(required.unit) !== getPantryQuantityFamily(aggregate.totalUnit)) return false;

  return toBasePantryQuantity(required.quantity, required.unit) > toBasePantryQuantity(aggregate.totalQuantity, aggregate.totalUnit);
};
