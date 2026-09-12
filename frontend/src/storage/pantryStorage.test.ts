import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_PANTRY_STORAGE_KEY,
  PANTRY_STORAGE_KEY,
  migrateLegacyPantry,
  readPantrySnapshot,
  writePantrySnapshot,
} from './pantryStorage';
import * as indexedDb from './indexedDb';

const persistedPantry = (id: string) => JSON.stringify({
  state: {
    pantryItems: [{ id, label: 'Pasta', known: true }],
    stapleIds: ['salt'],
  },
  version: 1,
});

describe('pantry storage', () => {
  beforeEach(async () => {
    await indexedDb.deleteLocalDatabase();
    window.localStorage.clear();
  });

  it('imports the iKuck localStorage snapshot into IndexedDB once', async () => {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('pasta'));

    await migrateLegacyPantry();

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'pasta' }],
      stapleIds: ['salt'],
    });
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBeNull();
  });

  it('imports the legacy iRicetto snapshot and removes it after a successful write', async () => {
    window.localStorage.setItem(LEGACY_PANTRY_STORAGE_KEY, persistedPantry('legacy-pasta'));

    await migrateLegacyPantry();

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'legacy-pasta' }],
    });
    expect(window.localStorage.getItem(LEGACY_PANTRY_STORAGE_KEY)).toBeNull();
  });

  it('does not erase the localStorage snapshot when the IndexedDB write fails', async () => {
    const snapshot = persistedPantry('pasta');
    window.localStorage.setItem(PANTRY_STORAGE_KEY, snapshot);
    vi.spyOn(indexedDb, 'writeKeyValue').mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(migrateLegacyPantry()).rejects.toThrow('quota exceeded');
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(snapshot);
  });

  it('writes and reads a clean pantry snapshot through the adapter', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
    });

    await expect(readPantrySnapshot()).resolves.toEqual({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
    });
  });
});
