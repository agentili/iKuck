import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_PANTRY_STORAGE_KEY,
  PANTRY_STORAGE_KEY,
  migrateLegacyPantry,
  readPantrySnapshot,
  clearPantrySnapshot,
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
      pantryLots: [expect.objectContaining({
        id: 'pasta',
        ingredientId: 'pasta',
        quantity: null,
        unit: null,
        expiresAt: null,
      })],
    });
  });

  it('reads the latest snapshot while its IndexedDB write is still pending', async () => {
    await indexedDb.writeKeyValue('pantry', persistedPantry('old-pasta'));
    let resolveWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writeSpy = vi.spyOn(indexedDb, 'writeKeyValue').mockReturnValue(pendingWrite);
    const persistPromise = writePantrySnapshot({
      pantryItems: [{ id: 'new-pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
    });

    await Promise.resolve();

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'new-pasta' }],
    });

    resolveWrite?.();
    await persistPromise;
    writeSpy.mockRestore();
  });

  it('round-trips multiple lots without losing nullable details', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [
        {
          id: 'lot-1',
          ingredientId: 'pasta',
          label: 'Pasta',
          known: true,
          quantity: 500,
          unit: 'g',
          expiresAt: '2026-10-01',
          createdAt: '2026-09-13T10:00:00.000Z',
          updatedAt: '2026-09-13T10:00:00.000Z',
        },
        {
          id: 'lot-2',
          ingredientId: 'pasta',
          label: 'Pasta',
          known: true,
          quantity: null,
          unit: null,
          expiresAt: null,
          createdAt: '2026-09-13T11:00:00.000Z',
          updatedAt: '2026-09-13T11:00:00.000Z',
        },
      ],
    });

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryLots: [
        expect.objectContaining({ id: 'lot-1', quantity: 500, unit: 'g', expiresAt: '2026-10-01' }),
        expect.objectContaining({ id: 'lot-2', quantity: null, unit: null, expiresAt: null }),
      ],
    });
  });

  it('clears a scoped pantry snapshot after a successful house import', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
    });

    await clearPantrySnapshot('guest');

    await expect(readPantrySnapshot()).resolves.toBeNull();
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBeNull();
  });
});
