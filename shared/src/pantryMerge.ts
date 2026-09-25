import type { PantryLot, PantryUnit } from './contracts.js';

export interface PantryMergeSnapshot {
  lots: PantryLot[];
  stapleIds: string[];
}

export interface PantryMergeSummary {
  addedLots: number;
  mergedLots: number;
  mergedGroups: number;
  importedStaples: number;
}

export interface PantryMergeResult extends PantryMergeSnapshot {
  summary: PantryMergeSummary;
}

const MASS_UNITS: Record<'g' | 'kg', number> = { g: 1, kg: 1000 };
const VOLUME_UNITS: Record<'ml' | 'l', number> = { ml: 1, l: 1000 };

const normalizeLabel = (label: string): string => label
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/[’']/g, ' ')
  .replace(/[^a-zA-Z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ')
  .toLowerCase();

const quantityFamily = (unit: PantryUnit): 'mass' | 'volume' | 'piece' | 'pack' => {
  if (unit in MASS_UNITS) return 'mass';
  if (unit in VOLUME_UNITS) return 'volume';
  return unit === 'piece' ? 'piece' : 'pack';
};

const baseUnit = (family: ReturnType<typeof quantityFamily>): PantryUnit => {
  if (family === 'mass') return 'g';
  if (family === 'volume') return 'ml';
  return family;
};

const toBaseQuantity = (quantity: number, unit: PantryUnit): number => {
  if (unit in MASS_UNITS) return quantity * MASS_UNITS[unit as 'g' | 'kg'];
  if (unit in VOLUME_UNITS) return quantity * VOLUME_UNITS[unit as 'ml' | 'l'];
  return quantity;
};

const ingredientKey = (lot: PantryLot): string => lot.known
  ? `known:${lot.ingredientId}`
  : `custom:${normalizeLabel(lot.label)}`;

const expiryKey = (lot: PantryLot): string => lot.expiresAt ?? 'none';
const baseGroupKey = (lot: PantryLot): string => `${ingredientKey(lot)}|${expiryKey(lot)}`;

const compareLots = (left: PantryLot, right: PantryLot): number => {
  const createdOrder = left.createdAt.localeCompare(right.createdAt);
  return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
};

const pickLatestById = (lots: readonly PantryLot[]): PantryLot[] => {
  const byId = new Map<string, PantryLot>();
  for (const lot of lots) {
    const current = byId.get(lot.id);
    const nextTime = Date.parse(lot.updatedAt);
    const currentTime = current === undefined ? Number.NEGATIVE_INFINITY : Date.parse(current.updatedAt);
    if (current === undefined || nextTime > currentTime || (nextTime === currentTime && lot.updatedAt >= current.updatedAt)) byId.set(lot.id, lot);
  }
  return [...byId.values()];
};

const mergeGroup = (lots: readonly PantryLot[]): PantryLot => {
  const ordered = [...lots].sort(compareLots);
  const [first] = ordered;
  const quantified = ordered.filter((lot): lot is PantryLot & { quantity: number; unit: PantryUnit } => (
    lot.quantity !== null && lot.unit !== null
  ));
  const family = quantified.length === 0 ? null : quantityFamily(quantified[0].unit);
  const quantity = quantified.length === 0
    ? null
    : quantified.reduce((total, lot) => total + toBaseQuantity(lot.quantity, lot.unit), 0);

  return {
    ...first,
    id: ordered.map((lot) => lot.id).sort()[0]!,
    known: ordered.some((lot) => lot.known),
    quantity,
    unit: family === null ? null : baseUnit(family),
    createdAt: ordered.map((lot) => lot.createdAt).sort()[0]!,
    updatedAt: ordered.map((lot) => lot.updatedAt).sort().at(-1)!,
  };
};

const lotEquivalent = (left: PantryLot, right: PantryLot): boolean => (
  left.id === right.id
    && left.ingredientId === right.ingredientId
    && left.label === right.label
    && left.known === right.known
    && left.quantity === right.quantity
    && left.unit === right.unit
    && left.expiresAt === right.expiresAt
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
);

export const mergePantryLots = (
  existingLots: readonly PantryLot[],
  incomingLots: readonly PantryLot[],
): { lots: PantryLot[]; summary: Pick<PantryMergeSummary, 'addedLots' | 'mergedLots' | 'mergedGroups'> } => {
  const distinctExistingLots = pickLatestById(existingLots);
  const existingById = new Map(distinctExistingLots.map((lot) => [lot.id, lot]));
  const distinctIncomingLots = pickLatestById(incomingLots);
  const distinctLots = [
    ...distinctExistingLots,
    ...distinctIncomingLots.filter((lot) => {
      const existing = existingById.get(lot.id);
      return existing === undefined || !lotEquivalent(existing, lot);
    }),
  ];
  const existingIds = new Set(distinctExistingLots.map((lot) => lot.id));
  const baseGroups = new Map<string, PantryLot[]>();

  for (const lot of distinctLots) {
    const key = baseGroupKey(lot);
    const group = baseGroups.get(key) ?? [];
    group.push(lot);
    baseGroups.set(key, group);
  }

  const groups: PantryLot[][] = [];
  for (const lots of baseGroups.values()) {
    const quantifiedGroups = new Map<string, PantryLot[]>();
    const presenceLots: PantryLot[] = [];
    for (const lot of lots) {
      if (lot.quantity === null || lot.unit === null) {
        presenceLots.push(lot);
      } else {
        const key = quantityFamily(lot.unit);
        const group = quantifiedGroups.get(key) ?? [];
        group.push(lot);
        quantifiedGroups.set(key, group);
      }
    }

    if (quantifiedGroups.size === 0) {
      if (presenceLots.length > 0) groups.push(presenceLots);
      continue;
    }

    const quantifiedEntries = [...quantifiedGroups.entries()];
    for (const [, quantifiedLots] of quantifiedEntries) groups.push(quantifiedLots);
    if (presenceLots.length > 0 && quantifiedEntries.length > 1) groups.push(presenceLots);
    else if (presenceLots.length > 0) quantifiedEntries[0]![1].push(...presenceLots);
  }

  const mergedLots = groups.reduce((total, group) => total + Math.max(0, group.length - 1), 0);
  const addedLots = groups.filter((group) => group.some((lot) => !existingIds.has(lot.id))
    && group.every((lot) => !existingIds.has(lot.id))).length;
  const mergedGroups = groups.filter((group) => group.length > 1).length;

  return {
    lots: groups.map(mergeGroup),
    summary: { addedLots, mergedLots, mergedGroups },
  };
};

export const mergePantrySnapshots = (
  existing: PantryMergeSnapshot,
  incoming: PantryMergeSnapshot,
): PantryMergeResult => {
  const mergedLots = mergePantryLots(existing.lots, incoming.lots);
  const stapleIds = [...new Set([...existing.stapleIds, ...incoming.stapleIds])];
  return {
    lots: mergedLots.lots,
    stapleIds,
    summary: {
      ...mergedLots.summary,
      importedStaples: incoming.stapleIds.filter((id) => !existing.stapleIds.includes(id)).length,
    },
  };
};
