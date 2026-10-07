import type { PantryLot, PantryUnit, SyncMutationScope } from './contracts.js';

export type DinnerConsumptionScope = 'guest' | SyncMutationScope;

export interface DinnerConsumptionIngredient {
  ingredientId: string | null;
  name: string;
  amount: string;
  optional: boolean;
  used: boolean;
}

export interface DinnerConsumptionCommand {
  readonly operationId: string;
  readonly entryId: string;
  readonly scope: DinnerConsumptionScope;
  readonly servings: number;
  readonly ingredients: readonly DinnerConsumptionIngredient[];
}

export interface PantryQuantity {
  quantity: number;
  unit: PantryUnit;
}

export type PantryConsumptionLineStatus = 'unused' | 'consumed' | 'partial' | 'presence_consumed' | 'missing' | 'unresolved';

export interface PantryConsumptionLineSummary {
  ingredientId: string | null;
  name: string;
  status: PantryConsumptionLineStatus;
  requiredQuantity: number | null;
  consumedQuantity: number | null;
  unit: PantryUnit | null;
  deficit: number | null;
  lotIds: string[];
}

export interface MissingPantryIngredient {
  ingredientId: string;
  name: string;
  requiredQuantity: number | null;
  unit: PantryUnit | null;
  deficit: number | null;
}

export interface UnresolvedPantryIngredient {
  ingredientId: string | null;
  name: string;
  reason: 'ingredient_unidentified' | 'amount_ambiguous' | 'unit_incompatible' | 'invalid_servings';
}

export interface PantryConsumptionPlan {
  upsertLots: PantryLot[];
  deleteLotIds: string[];
  missingIngredients: MissingPantryIngredient[];
  unresolvedIngredients: UnresolvedPantryIngredient[];
  summary: {
    lines: PantryConsumptionLineSummary[];
    consumedIngredientCount: number;
    exhaustedLotCount: number;
    deficitCount: number;
  };
}

export type PantryQuantityParseMode = 'strict' | 'prefix';
export type PantryQuantityFamily = 'mass' | 'volume' | 'piece' | 'pack';

const STRICT_QUANTITY_PATTERN = /^(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|piece|pieces|pezzo|pezzi|pack|confezione|confezioni)\s*$/i;
const PREFIX_QUANTITY_PATTERN = /^(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|piece|pieces|pezzo|pezzi|pack|confezione|confezioni)?\b/i;
const MASS_UNITS: Record<'g' | 'kg', number> = { g: 1, kg: 1000 };
const VOLUME_UNITS: Record<'ml' | 'l', number> = { ml: 1, l: 1000 };

export const getPantryQuantityFamily = (unit: PantryUnit): PantryQuantityFamily => {
  if (unit in MASS_UNITS) return 'mass';
  if (unit in VOLUME_UNITS) return 'volume';
  if (unit === 'piece') return 'piece';
  return 'pack';
};

export const toBasePantryQuantity = (quantity: number, unit: PantryUnit): number => {
  if (unit in MASS_UNITS) return quantity * MASS_UNITS[unit as 'g' | 'kg'];
  if (unit in VOLUME_UNITS) return quantity * VOLUME_UNITS[unit as 'ml' | 'l'];
  return quantity;
};

export const fromBasePantryQuantity = (quantity: number, unit: PantryUnit): number => {
  if (unit in MASS_UNITS) return quantity / MASS_UNITS[unit as 'g' | 'kg'];
  if (unit in VOLUME_UNITS) return quantity / VOLUME_UNITS[unit as 'ml' | 'l'];
  return quantity;
};

export const basePantryUnit = (unit: PantryUnit): PantryUnit => {
  const family = getPantryQuantityFamily(unit);
  if (family === 'mass') return 'g';
  if (family === 'volume') return 'ml';
  return unit;
};

export const parsePantryQuantity = (amount: string, mode: PantryQuantityParseMode = 'strict'): PantryQuantity | null => {
  const match = amount.trim().match(mode === 'strict' ? STRICT_QUANTITY_PATTERN : PREFIX_QUANTITY_PATTERN);
  if (match === null) return null;
  const quantity = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const rawUnit = match[2]?.toLowerCase();
  const unit: PantryUnit | null = rawUnit === 'g' || rawUnit === 'kg' || rawUnit === 'ml' || rawUnit === 'l'
    ? rawUnit
    : rawUnit === 'piece' || rawUnit === 'pieces' || rawUnit === 'pezzo' || rawUnit === 'pezzi' ? 'piece'
      : rawUnit === 'pack' || rawUnit === 'confezione' || rawUnit === 'confezioni' ? 'pack'
        : null;
  return unit === null ? null : { quantity, unit };
};

const roundQuantity = (quantity: number): number => Number(quantity.toPrecision(15));

const compareDateValues = (left: string | null, right: string | null): number => {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.localeCompare(right);
};

const compareLotsByConsumptionOrder = (left: PantryLot, right: PantryLot): number => (
  compareDateValues(left.expiresAt, right.expiresAt)
    || compareDateValues(left.createdAt, right.createdAt)
    || left.id.localeCompare(right.id)
);

const removeWorkingLot = (id: string, workingLots: Map<string, PantryLot>, upsertLots: Map<string, PantryLot>, deletedIds: Set<string>): void => {
  workingLots.delete(id);
  upsertLots.delete(id);
  deletedIds.add(id);
};

export const planPantryConsumption = ({
  lots,
  command,
  updatedAt,
}: {
  lots: readonly PantryLot[];
  command: DinnerConsumptionCommand;
  updatedAt: string;
}): PantryConsumptionPlan => {
  const workingLots = new Map(lots.map((lot) => [lot.id, lot]));
  const upsertLots = new Map<string, PantryLot>();
  const deleteLotIds = new Set<string>();
  const missingIngredients: MissingPantryIngredient[] = [];
  const unresolvedIngredients: UnresolvedPantryIngredient[] = [];
  const lines: PantryConsumptionLineSummary[] = [];
  const validServings = Number.isSafeInteger(command.servings) && command.servings > 0;

  for (const ingredient of command.ingredients) {
    if (!ingredient.used) {
      lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'unused', requiredQuantity: null, consumedQuantity: null, unit: null, deficit: null, lotIds: [] });
      continue;
    }

    const required = parsePantryQuantity(ingredient.amount);
    const requiredQuantity = required === null || !validServings ? null : required.quantity * command.servings;
    if (ingredient.ingredientId === null || ingredient.ingredientId.trim() === '') {
      unresolvedIngredients.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, reason: 'ingredient_unidentified' });
      lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'unresolved', requiredQuantity, consumedQuantity: 0, unit: required?.unit ?? null, deficit: requiredQuantity, lotIds: [] });
      continue;
    }

    if (!validServings) {
      unresolvedIngredients.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, reason: 'invalid_servings' });
      lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'unresolved', requiredQuantity: null, consumedQuantity: 0, unit: required?.unit ?? null, deficit: null, lotIds: [] });
      continue;
    }

    const matchingLots = [...workingLots.values()].filter((lot) => lot.ingredientId === ingredient.ingredientId);
    const hasQuantifiedLot = matchingLots.some((lot) => lot.quantity !== null || lot.unit !== null);
    const presenceLots = matchingLots.filter((lot) => lot.quantity === null && lot.unit === null).sort(compareLotsByConsumptionOrder);

    if (required === null) {
      if (!hasQuantifiedLot && presenceLots.length > 0) {
        const [presenceLot] = presenceLots;
        removeWorkingLot(presenceLot.id, workingLots, upsertLots, deleteLotIds);
        lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'presence_consumed', requiredQuantity: null, consumedQuantity: null, unit: null, deficit: null, lotIds: [presenceLot.id] });
      } else {
        unresolvedIngredients.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, reason: 'amount_ambiguous' });
        lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'unresolved', requiredQuantity: null, consumedQuantity: 0, unit: null, deficit: null, lotIds: [] });
      }
      continue;
    }

    const scaledQuantity = required.quantity * command.servings;
    if (matchingLots.length === 0) {
      missingIngredients.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, requiredQuantity: scaledQuantity, unit: required.unit, deficit: scaledQuantity });
      lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'missing', requiredQuantity: scaledQuantity, consumedQuantity: 0, unit: required.unit, deficit: scaledQuantity, lotIds: [] });
      continue;
    }

    const quantifiedLots = matchingLots.filter((lot): lot is PantryLot & { quantity: number; unit: PantryUnit } => (
      lot.quantity !== null && Number.isFinite(lot.quantity) && lot.quantity > 0 && lot.unit !== null
    ));
    const requiredFamily = getPantryQuantityFamily(required.unit);
    const compatibleLots = quantifiedLots
      .filter((lot) => getPantryQuantityFamily(lot.unit) === requiredFamily)
      .sort(compareLotsByConsumptionOrder);

    if (compatibleLots.length === 0 && !hasQuantifiedLot && presenceLots.length > 0) {
      const [presenceLot] = presenceLots;
      removeWorkingLot(presenceLot.id, workingLots, upsertLots, deleteLotIds);
      lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'presence_consumed', requiredQuantity: scaledQuantity, consumedQuantity: null, unit: required.unit, deficit: null, lotIds: [presenceLot.id] });
      continue;
    }

    if (compatibleLots.length === 0) {
      unresolvedIngredients.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, reason: 'unit_incompatible' });
      lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: 'unresolved', requiredQuantity: scaledQuantity, consumedQuantity: 0, unit: required.unit, deficit: scaledQuantity, lotIds: [] });
      continue;
    }

    let remainingBase = toBasePantryQuantity(scaledQuantity, required.unit);
    let consumedBase = 0;
    const lotIds: string[] = [];

    for (const lot of compatibleLots) {
      if (remainingBase <= 0) break;
      const availableBase = toBasePantryQuantity(lot.quantity, lot.unit);
      const takenBase = Math.min(availableBase, remainingBase);
      const leftoverBase = Math.max(0, availableBase - takenBase);
      remainingBase = roundQuantity(Math.max(0, remainingBase - takenBase));
      consumedBase = roundQuantity(consumedBase + takenBase);
      lotIds.push(lot.id);

      const tolerance = Number.EPSILON * Math.max(1, availableBase, takenBase) * 8;
      if (leftoverBase <= tolerance) removeWorkingLot(lot.id, workingLots, upsertLots, deleteLotIds);
      else {
        const updatedLot = { ...lot, quantity: roundQuantity(fromBasePantryQuantity(leftoverBase, lot.unit)), updatedAt };
        workingLots.set(lot.id, updatedLot);
        upsertLots.set(lot.id, updatedLot);
      }
    }

    const consumedQuantity = roundQuantity(fromBasePantryQuantity(consumedBase, required.unit));
    const deficit = roundQuantity(fromBasePantryQuantity(remainingBase, required.unit));
    if (deficit > 0) missingIngredients.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, requiredQuantity: scaledQuantity, unit: required.unit, deficit });
    lines.push({ ingredientId: ingredient.ingredientId, name: ingredient.name, status: deficit > 0 ? 'partial' : 'consumed', requiredQuantity: scaledQuantity, consumedQuantity, unit: required.unit, deficit, lotIds });
  }

  const deletedLotIds = [...deleteLotIds];
  const lineSummaries = lines;
  return {
    upsertLots: [...upsertLots.values()],
    deleteLotIds: deletedLotIds,
    missingIngredients,
    unresolvedIngredients,
    summary: {
      lines: lineSummaries,
      consumedIngredientCount: lineSummaries.filter((line) => line.status === 'consumed' || line.status === 'partial' || line.status === 'presence_consumed').length,
      exhaustedLotCount: deletedLotIds.length,
      deficitCount: lineSummaries.filter((line) => line.deficit !== null && line.deficit > 0).length,
    },
  };
};
