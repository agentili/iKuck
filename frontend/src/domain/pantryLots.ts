import type { PantryLot, PantryUnit } from '@ikuck/shared/contracts';
import type { RecipeIngredient } from './types';

export type ExpiryStatus = 'unknown' | 'expired' | 'expiring_soon' | 'okay';

export interface PantryQuantity {
  quantity: number;
  unit: PantryUnit;
}

export interface PantryQuantityAggregate {
  ingredientId: string;
  label: string;
  lotCount: number;
  quantities: PantryQuantity[];
  totalQuantity: number | null;
  totalUnit: PantryUnit | null;
  earliestExpiresAt: string | null;
}

const MASS_UNITS: Record<'g' | 'kg', number> = { g: 1, kg: 1000 };
const VOLUME_UNITS: Record<'ml' | 'l', number> = { ml: 1, l: 1000 };

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

const quantityFamily = (unit: PantryUnit): 'mass' | 'volume' | 'count' => {
  if (unit in MASS_UNITS) return 'mass';
  if (unit in VOLUME_UNITS) return 'volume';
  return 'count';
};

const toBaseQuantity = ({ quantity, unit }: PantryQuantity): number => {
  if (unit in MASS_UNITS) return quantity * MASS_UNITS[unit as 'g' | 'kg'];
  if (unit in VOLUME_UNITS) return quantity * VOLUME_UNITS[unit as 'ml' | 'l'];
  return quantity;
};

const baseUnit = (unit: PantryUnit): PantryUnit => {
  if (quantityFamily(unit) === 'mass') return 'g';
  if (quantityFamily(unit) === 'volume') return 'ml';
  return unit;
};

const aggregateQuantities = (quantities: PantryQuantity[]): { totalQuantity: number | null; totalUnit: PantryUnit | null } => {
  if (quantities.length === 0) return { totalQuantity: null, totalUnit: null };
  const families = new Set(quantities.map(({ unit }) => quantityFamily(unit)));
  if (families.size !== 1) return { totalQuantity: null, totalUnit: null };

  const [first] = quantities;
  return {
    totalQuantity: quantities.reduce((total, quantity) => total + toBaseQuantity(quantity), 0),
    totalUnit: baseUnit(first.unit),
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

const parseRecipeAmount = (amount: string): PantryQuantity | null => {
  const match = amount.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|piece|pieces|pezzo|pezzi|pack|confezione|confezioni)?\b/);
  if (match === null) return null;

  const quantity = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const rawUnit = match[2];
  if (rawUnit === undefined) return null;
  const unit: PantryUnit | null = rawUnit === 'g' || rawUnit === 'kg' || rawUnit === 'ml' || rawUnit === 'l'
    ? rawUnit
    : rawUnit === 'piece' || rawUnit === 'pieces' || rawUnit === 'pezzo' || rawUnit === 'pezzi' ? 'piece'
      : rawUnit === 'pack' || rawUnit === 'confezione' || rawUnit === 'confezioni' ? 'pack'
        : null;
  if (unit === null) return null;
  return { quantity, unit };
};

export const getQuantityWarning = (
  recipeIngredient: Pick<RecipeIngredient, 'ingredientId' | 'amount'>,
  aggregate: PantryQuantityAggregate | undefined,
): boolean => {
  if (aggregate === undefined || aggregate.totalQuantity === null || aggregate.totalUnit === null) return false;
  const required = parseRecipeAmount(recipeIngredient.amount);
  if (required === null || quantityFamily(required.unit) !== quantityFamily(aggregate.totalUnit)) return false;

  return toBaseQuantity(required) > toBaseQuantity({ quantity: aggregate.totalQuantity, unit: aggregate.totalUnit });
};
