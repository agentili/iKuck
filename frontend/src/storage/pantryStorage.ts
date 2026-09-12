import type { StateStorage } from 'zustand/middleware';
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

    return {
      pantryItems: state.pantryItems,
      stapleIds: state.stapleIds,
    };
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

  await writeKeyValue(PANTRY_DATABASE_KEY, source.raw);
  window.localStorage.removeItem(source.key);
  return true;
}

export async function readPantrySnapshot(): Promise<PantrySnapshot | null> {
  if (!isIndexedDbAvailable()) {
    const raw = readLocalStorageFallback(PANTRY_STORAGE_KEY);
    return raw === null ? null : parsePantrySnapshot(raw);
  }

  try {
    await migrateLegacyPantry();
    const raw = await readKeyValue<string>(PANTRY_DATABASE_KEY);
    return raw === null ? null : parsePantrySnapshot(raw);
  } catch {
    const fallbackRaw = readLocalStorageFallback(PANTRY_STORAGE_KEY);
    return fallbackRaw === null ? null : parsePantrySnapshot(fallbackRaw);
  }
}

export async function writePantrySnapshot(snapshot: PantrySnapshot): Promise<void> {
  const persisted: PersistedPantryState = { state: snapshot, version: 1 };

  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(persisted));
    return;
  }

  try {
    await writeKeyValue(PANTRY_DATABASE_KEY, JSON.stringify(persisted));
  } catch (error) {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(persisted));
    throw error;
  }
}

export const pantryStorage: StateStorage = {
  async getItem(name) {
    if (name !== PANTRY_STORAGE_KEY || !isIndexedDbAvailable()) {
      return readLocalStorageFallback(name);
    }

    try {
      await migrateLegacyPantry();
      const raw = await readKeyValue<string>(PANTRY_DATABASE_KEY);
      if (raw !== null && parsePantrySnapshot(raw) === null) {
        await deleteKeyValue(PANTRY_DATABASE_KEY);
        return null;
      }
      return raw;
    } catch {
      return readLocalStorageFallback(name);
    }
  },
  async setItem(name, value) {
    if (name !== PANTRY_STORAGE_KEY || !isIndexedDbAvailable()) {
      window.localStorage.setItem(name, value);
      return;
    }

    try {
      await writeKeyValue(PANTRY_DATABASE_KEY, value);
    } catch {
      window.localStorage.setItem(name, value);
    }
  },
  async removeItem(name) {
    if (name !== PANTRY_STORAGE_KEY || !isIndexedDbAvailable()) {
      window.localStorage.removeItem(name);
      return;
    }

    try {
      await deleteKeyValue(PANTRY_DATABASE_KEY);
    } catch {
      window.localStorage.removeItem(name);
    }
  },
};
