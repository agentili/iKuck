import type { StateStorage } from 'zustand/middleware';
import type { PantryLot, PantryUnit } from '@ikuck/shared/contracts';
import type { ParsedIngredient } from '../domain/types';
import {
  deleteKeyValue,
  isIndexedDbAvailable,
  readKeyValue,
  writeKeyValue,
} from './indexedDb';

export const PANTRY_STORAGE_KEY = 'ikuck-pantry-v1';
export const LEGACY_PANTRY_STORAGE_KEY = 'iricetto-pantry-v1';
export const PANTRY_DATABASE_KEY = 'pantry';

export interface PantrySnapshot {
  pantryItems: ParsedIngredient[];
  stapleIds: string[];
  pantryLots?: PantryLot[];
}

interface PersistedPantryState {
  state: PantrySnapshot;
  version: number;
}

interface LocalStorageSource {
  key: string;
  raw: string;
}

function isParsedIngredient(value: unknown): value is ParsedIngredient {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.known === 'boolean';
}

const PANTRY_UNITS: readonly PantryUnit[] = ['g', 'kg', 'ml', 'l', 'piece', 'pack'];

export function isPantryLot(value: unknown): value is PantryLot {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.ingredientId === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.known === 'boolean'
    && (candidate.quantity === null || (typeof candidate.quantity === 'number' && Number.isFinite(candidate.quantity) && candidate.quantity > 0))
    && (candidate.unit === null || (typeof candidate.unit === 'string' && PANTRY_UNITS.includes(candidate.unit as PantryUnit)))
    && (candidate.quantity === null ? candidate.unit === null : candidate.unit !== null)
    && (candidate.expiresAt === null || (typeof candidate.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate.expiresAt)))
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string';
}

export const createPresencePantryLot = (item: ParsedIngredient, id = item.id, now = new Date().toISOString()): PantryLot => ({
  id,
  ingredientId: item.id,
  label: item.label,
  known: item.known,
  quantity: null,
  unit: null,
  expiresAt: null,
  createdAt: now,
  updatedAt: now,
});

export const derivePantryItems = (lots: readonly PantryLot[]): ParsedIngredient[] => {
  const items = new Map<string, ParsedIngredient>();
  for (const lot of lots) {
    if (!items.has(lot.ingredientId)) {
      items.set(lot.ingredientId, {
        id: lot.ingredientId,
        label: lot.label,
        known: lot.known,
      });
    }
  }
  return [...items.values()];
};

export const normalizePantrySnapshot = (snapshot: PantrySnapshot): PantrySnapshot => {
  const validLots = (snapshot.pantryLots ?? []).filter(isPantryLot);
  const representedIngredients = new Set(validLots.map((lot) => lot.ingredientId));
  const legacyItems = snapshot.pantryItems.filter(isParsedIngredient);
  const lots = [...validLots];

  for (const item of legacyItems) {
    if (!representedIngredients.has(item.id)) {
      lots.push(createPresencePantryLot(item));
      representedIngredients.add(item.id);
    }
  }

  return {
    pantryItems: derivePantryItems(lots),
    stapleIds: [...new Set(snapshot.stapleIds.filter((id) => typeof id === 'string'))],
    pantryLots: lots,
  };
};

const serializeSnapshot = (snapshot: PantrySnapshot): string => JSON.stringify({
  state: normalizePantrySnapshot(snapshot),
  version: 1,
});

function parsePantrySnapshot(raw: string): PantrySnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPantryState>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.state !== 'object' || parsed.state === null) {
      return null;
    }

    const state = parsed.state as Partial<PantrySnapshot>;
    if (!Array.isArray(state.pantryItems) || !Array.isArray(state.stapleIds)) {
      return null;
    }

    if (!state.pantryItems.every(isParsedIngredient) || !state.stapleIds.every((id) => typeof id === 'string')) {
      return null;
    }

    return normalizePantrySnapshot({
      pantryItems: state.pantryItems,
      stapleIds: state.stapleIds,
      pantryLots: Array.isArray(state.pantryLots) ? state.pantryLots : undefined,
    });
  } catch {
    return null;
  }
}

function readLocalStorageSource(): LocalStorageSource | null {
  const candidates = [PANTRY_STORAGE_KEY, LEGACY_PANTRY_STORAGE_KEY];

  for (const key of candidates) {
    const raw = window.localStorage.getItem(key);
    if (raw === null) continue;

    if (parsePantrySnapshot(raw) !== null) {
      return { key, raw };
    }

    window.localStorage.removeItem(key);
  }

  return null;
}

const readLocalStorageSnapshot = (): PantrySnapshot | null => {
  const raw = window.localStorage.getItem(PANTRY_STORAGE_KEY);
  if (raw === null) return null;

  const snapshot = parsePantrySnapshot(raw);
  if (snapshot === null) {
    window.localStorage.removeItem(PANTRY_STORAGE_KEY);
  }
  return snapshot;
};

const writeLocalStorageSnapshot = (serialized: string): void => {
  try {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, serialized);
  } catch {
    // IndexedDB remains the primary store when localStorage is unavailable.
  }
};

function readLocalStorageFallback(name: string): string | null {
  const primaryRaw = window.localStorage.getItem(name);
  if (primaryRaw !== null) return primaryRaw;

  if (name !== PANTRY_STORAGE_KEY) return null;

  const legacyRaw = window.localStorage.getItem(LEGACY_PANTRY_STORAGE_KEY);
  if (legacyRaw !== null) {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, legacyRaw);
  }

  return legacyRaw;
}

export async function migrateLegacyPantry(): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;

  const existing = await readKeyValue<string>(PANTRY_DATABASE_KEY);
  if (existing !== null) {
    if (parsePantrySnapshot(existing) !== null) return false;
    await deleteKeyValue(PANTRY_DATABASE_KEY);
  }

  const source = readLocalStorageSource();
  if (source === null) return false;

  const snapshot = parsePantrySnapshot(source.raw);
  if (snapshot === null) return false;
  await writeKeyValue(PANTRY_DATABASE_KEY, serializeSnapshot(snapshot));
  window.localStorage.removeItem(source.key);
  return true;
}

export async function readPantrySnapshot(): Promise<PantrySnapshot | null> {
  if (!isIndexedDbAvailable()) {
    const raw = readLocalStorageFallback(PANTRY_STORAGE_KEY);
    return raw === null ? null : parsePantrySnapshot(raw);
  }

  const localSnapshot = readLocalStorageSnapshot();
  try {
    await migrateLegacyPantry();
    const raw = await readKeyValue<string>(PANTRY_DATABASE_KEY);
    const indexedSnapshot = raw === null ? null : parsePantrySnapshot(raw);
    return localSnapshot ?? indexedSnapshot;
  } catch {
    const fallbackRaw = readLocalStorageFallback(PANTRY_STORAGE_KEY);
    return fallbackRaw === null ? null : parsePantrySnapshot(fallbackRaw);
  }
}

export async function writePantrySnapshot(snapshot: PantrySnapshot): Promise<void> {
  const persisted: PersistedPantryState = { state: normalizePantrySnapshot(snapshot), version: 1 };
  const serialized = JSON.stringify(persisted);
  writeLocalStorageSnapshot(serialized);

  if (!isIndexedDbAvailable()) return;

  await writeKeyValue(PANTRY_DATABASE_KEY, serialized);
}

export const pantryStorage: StateStorage = {
  async getItem(name) {
    if (name !== PANTRY_STORAGE_KEY || !isIndexedDbAvailable()) {
      return readLocalStorageFallback(name);
    }

    const localSnapshot = readLocalStorageSnapshot();
    try {
      await migrateLegacyPantry();
      const raw = await readKeyValue<string>(PANTRY_DATABASE_KEY);
      if (raw !== null && parsePantrySnapshot(raw) === null) {
        await deleteKeyValue(PANTRY_DATABASE_KEY);
        return localSnapshot === null ? null : serializeSnapshot(localSnapshot);
      }
      const indexedSnapshot = raw === null ? null : parsePantrySnapshot(raw);
      const snapshot = localSnapshot ?? indexedSnapshot;
      return snapshot === null ? null : serializeSnapshot(snapshot);
    } catch {
      const fallbackSnapshot = readLocalStorageSnapshot();
      return fallbackSnapshot === null ? readLocalStorageFallback(name) : serializeSnapshot(fallbackSnapshot);
    }
  },
  async setItem(name, value) {
    if (name !== PANTRY_STORAGE_KEY) {
      window.localStorage.setItem(name, value);
      return;
    }

    writeLocalStorageSnapshot(value);
    if (!isIndexedDbAvailable()) return;

    try {
      const parsed = parsePantrySnapshot(value);
      await writeKeyValue(PANTRY_DATABASE_KEY, parsed === null ? value : serializeSnapshot(parsed));
    } catch {
      // The synchronous localStorage mirror keeps the latest state available.
    }
  },
  async removeItem(name) {
    if (name !== PANTRY_STORAGE_KEY || !isIndexedDbAvailable()) {
      window.localStorage.removeItem(name);
      return;
    }

    try {
      await deleteKeyValue(PANTRY_DATABASE_KEY);
    } finally {
      window.localStorage.removeItem(name);
    }
  },
};
