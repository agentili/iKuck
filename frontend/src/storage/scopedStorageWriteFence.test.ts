import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookEvent, DietProfile, ShoppingListItem } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import * as indexedDb from './indexedDb';
import { deleteLocalDatabase } from './indexedDb';
import { scopeStorageKey } from '../sync/scopeContext';
import { markScopeUncertain, resumeScope, trackScopedWrite } from '../sync/scopeWriteFence';
import { ACTIVITY_DATABASE_KEY, ACTIVITY_STORAGE_KEY, writeCookEvents } from './activityStorage';
import { writeDinnerEntries } from './dinnerDiaryStorage';
import { DIET_PROFILE_DATABASE_KEY, DIET_PROFILE_STORAGE_KEY, writeDietProfile } from './dietProfileStorage';
import { SHOPPING_LIST_DATABASE_KEY, SHOPPING_LIST_STORAGE_KEY, writeShoppingList } from './shoppingListStorage';

const shoppingItem: ShoppingListItem = {
  id: 'fenced-shopping-item',
  ingredientId: 'pasta',
  label: 'Pasta',
  quantity: null,
  unit: null,
  note: null,
  purchased: false,
  sourceRecipeId: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
};

const cookEvent: CookEvent = {
  id: 'fenced-cook-event',
  recipeId: 'recipe-1',
  recipeTitle: 'Pasta',
  servings: 2,
  cookedAt: '2026-10-08T10:00:00.000Z',
  note: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
};

const dinnerEntry: DinnerEntry = {
  id: 'fenced-dinner-entry',
  date: '2026-10-08',
  text: 'Pasta',
  servings: 2,
  note: null,
  recipes: [],
  authorId: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
};

const dietProfile: DietProfile = {
  diet: 'vegan',
  excludedAllergens: ['milk'],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
  updatedAt: '2026-10-08T10:00:00.000Z',
};

describe('scoped storage write fences', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    window.localStorage.clear();
  });

  it('does not write a shopping-list mirror after an uncertain House IDB write fails', async () => {
    const scope = 'house:storage-fence-shopping' as const;
    const databaseKey = scopeStorageKey(scope, SHOPPING_LIST_DATABASE_KEY);
    const storageKey = scopeStorageKey(scope, SHOPPING_LIST_STORAGE_KEY);
    await indexedDb.writeKeyValue(databaseKey, 'existing-house-shopping-data');
    window.localStorage.setItem(storageKey, 'existing-house-shopping-mirror');

    let releaseWrite!: () => void;
    let signalWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const actualWrite = indexedDb.writeKeyValue;
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === databaseKey) {
        signalWrite();
        await writeGate;
        throw new Error('IndexedDB write failed after membership loss');
      }
      return actualWrite(key, value);
    });

    try {
      const pending = writeShoppingList([shoppingItem], scope);
      await writeStarted;
      markScopeUncertain(scope);
      releaseWrite();

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      expect(await indexedDb.readKeyValue(databaseKey)).toBe('existing-house-shopping-data');
      expect(window.localStorage.getItem(storageKey)).toBe('existing-house-shopping-mirror');
    } finally {
      releaseWrite();
      write.mockRestore();
      resumeScope(scope);
    }
  });

  it('does not write an activity mirror after an uncertain House IDB write fails', async () => {
    const scope = 'house:storage-fence-activity' as const;
    const databaseKey = scopeStorageKey(scope, ACTIVITY_DATABASE_KEY);
    const storageKey = scopeStorageKey(scope, ACTIVITY_STORAGE_KEY);
    await indexedDb.writeKeyValue(databaseKey, 'existing-house-activity-data');
    window.localStorage.setItem(storageKey, 'existing-house-activity-mirror');

    let releaseWrite!: () => void;
    let signalWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const actualWrite = indexedDb.writeKeyValue;
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === databaseKey) {
        signalWrite();
        await writeGate;
        throw new Error('IndexedDB write failed after membership loss');
      }
      return actualWrite(key, value);
    });

    try {
      const pending = writeCookEvents([cookEvent], scope);
      await writeStarted;
      markScopeUncertain(scope);
      releaseWrite();

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      expect(await indexedDb.readKeyValue(databaseKey)).toBe('existing-house-activity-data');
      expect(window.localStorage.getItem(storageKey)).toBe('existing-house-activity-mirror');
    } finally {
      releaseWrite();
      write.mockRestore();
      resumeScope(scope);
    }
  });

  it('does not write dinner-diary mirrors after an uncertain House IDB write fails', async () => {
    const scope = 'house:storage-fence-dinner' as const;
    const databaseKey = scopeStorageKey(scope, 'dinner-entries');
    const storageKey = scopeStorageKey(scope, 'ikuck-dinner-entries-v1');
    await indexedDb.writeKeyValue(databaseKey, 'existing-house-dinner-data');
    window.localStorage.setItem(storageKey, 'existing-house-dinner-mirror');

    let releaseWrite!: () => void;
    let signalWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const actualWrite = indexedDb.writeKeyValue;
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === databaseKey) {
        signalWrite();
        await writeGate;
        throw new Error('IndexedDB write failed after membership loss');
      }
      return actualWrite(key, value);
    });

    try {
      const pending = writeDinnerEntries([dinnerEntry], scope);
      await writeStarted;
      markScopeUncertain(scope);
      releaseWrite();

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      expect(await indexedDb.readKeyValue(databaseKey)).toBe('existing-house-dinner-data');
      expect(window.localStorage.getItem(storageKey)).toBe('existing-house-dinner-mirror');
    } finally {
      releaseWrite();
      write.mockRestore();
      resumeScope(scope);
    }
  });

  it('does not write a diet-profile mirror after an uncertain House IDB write fails', async () => {
    const scope = 'house:storage-fence-diet' as const;
    const databaseKey = scopeStorageKey(scope, DIET_PROFILE_DATABASE_KEY);
    const storageKey = scopeStorageKey(scope, DIET_PROFILE_STORAGE_KEY);
    await indexedDb.writeKeyValue(databaseKey, 'existing-house-diet-data');
    window.localStorage.setItem(storageKey, 'existing-house-diet-mirror');

    let releaseWrite!: () => void;
    let signalWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const actualWrite = indexedDb.writeKeyValue;
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === databaseKey) {
        signalWrite();
        await writeGate;
        throw new Error('IndexedDB write failed after membership loss');
      }
      return actualWrite(key, value);
    });

    try {
      const pending = writeDietProfile(dietProfile, scope);
      await writeStarted;
      markScopeUncertain(scope);
      releaseWrite();

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      expect(await indexedDb.readKeyValue(databaseKey)).toBe('existing-house-diet-data');
      expect(window.localStorage.getItem(storageKey)).toBe('existing-house-diet-mirror');
    } finally {
      releaseWrite();
      write.mockRestore();
      resumeScope(scope);
    }
  });

  it('rechecks House writability after opening IndexedDB and before writing a queue mutation', async () => {
    const scope = 'house:storage-fence-queue' as const;
    const mutation = { mutationId: 'fenced-queue-mutation', scope };

    try {
      const pending = trackScopedWrite(scope, (assertWritable) => (
        indexedDb.writeQueueValue(mutation, assertWritable)
      ));
      markScopeUncertain(scope);

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      await expect(indexedDb.readQueueValues<typeof mutation>(scope)).resolves.toEqual([]);
    } finally {
      resumeScope(scope);
    }
  });

  it('rechecks House writability after opening IndexedDB and before deleting a queue mutation', async () => {
    const scope = 'house:storage-fence-queue-delete' as const;
    const mutation = { mutationId: 'preserved-fenced-queue-mutation', scope };
    await indexedDb.writeQueueValue(mutation);

    try {
      const pending = trackScopedWrite(scope, (assertWritable) => (
        indexedDb.deleteQueueValue(mutation.mutationId, scope, assertWritable)
      ));
      markScopeUncertain(scope);

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      await expect(indexedDb.readQueueValues<typeof mutation>(scope)).resolves.toEqual([mutation]);
    } finally {
      resumeScope(scope);
    }
  });

  it('rechecks House writability after opening IndexedDB and before updating a sync cursor', async () => {
    const scope = 'house:storage-fence-cursor' as const;
    const cursorKey = `syncCursor:${scope}`;
    await indexedDb.writeMeta(cursorKey, 23);

    try {
      const pending = trackScopedWrite(scope, (assertWritable) => (
        indexedDb.writeMeta(cursorKey, 24, assertWritable)
      ));
      markScopeUncertain(scope);

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      await expect(indexedDb.readMeta<number>(cursorKey)).resolves.toBe(23);
    } finally {
      resumeScope(scope);
    }
  });

  it('rechecks House writability after opening IndexedDB and before putting a value', async () => {
    const scope = 'house:storage-fence-before-put' as const;
    const databaseKey = scopeStorageKey(scope, 'fenced-before-put');
    await indexedDb.writeKeyValue(databaseKey, 'existing-house-value');

    try {
      const pending = trackScopedWrite(scope, (assertWritable) => (
        indexedDb.writeKeyValue(databaseKey, 'new-house-value', assertWritable)
      ));
      markScopeUncertain(scope);

      await expect(pending).rejects.toMatchObject({ code: 'scope_unverified' });
      expect(await indexedDb.readKeyValue(databaseKey)).toBe('existing-house-value');
    } finally {
      resumeScope(scope);
    }
  });
});
