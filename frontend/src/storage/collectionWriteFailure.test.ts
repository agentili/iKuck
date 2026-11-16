import { beforeEach, expect, it, vi } from 'vitest';
import * as db from './indexedDb';
import { readCookEvents, readRecipePreferences, writeCookEvents, writeRecipePreferences } from './activityStorage';
import { readShoppingList, writeShoppingList } from './shoppingListStorage';
import { setActiveDataScope } from '../sync/scopeContext';
import { waitForScopedWrites } from '../sync/scopeWriteFence';

const timestamp = '2026-10-07T09:00:00.000Z';
const event = { id: 'old-event', recipeId: 'pasta', recipeTitle: 'Pasta', servings: 2, cookedAt: timestamp, note: null, createdAt: timestamp, updatedAt: timestamp };
const preference = { recipeId: 'pasta', favorite: true, rating: null, note: null, createdAt: timestamp, updatedAt: timestamp };
const item = { id: 'old-item', ingredientId: 'pasta', label: 'Pasta', quantity: null, unit: null, note: null, purchased: false, sourceRecipeId: null, createdAt: timestamp, updatedAt: timestamp };
const collections = [
  { key: 'activity', mirror: 'ikuck-activity-v1', items: [event], write: () => writeCookEvents([]), read: readCookEvents },
  { key: 'recipe-preferences', mirror: 'ikuck-recipe-preferences-v1', items: [preference], write: () => writeRecipePreferences([]), read: readRecipePreferences },
  { key: 'shopping-list', mirror: 'ikuck-shopping-list-v1', items: [item], write: () => writeShoppingList([]), read: readShoppingList },
];

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.deleteLocalDatabase();
  window.localStorage.clear();
  setActiveDataScope('guest');
});

for (const collection of collections) {
  it.each(['corrupt', 'valid', 'absent', 'unreadable', 'changed-corrupt', 'changed-valid'] as const)(`${collection.key} quota rejection preserves %s mirror and primary authority, then retries`, async (kind) => {
    const primary = JSON.stringify({ items: collection.items, version: 1 });
    const mirror = kind === 'valid' || kind.startsWith('changed') || kind === 'unreadable'
      ? JSON.stringify({ version: 1, items: collection.items }) : '{recoverable-fragment';
    await db.writeKeyValue(collection.key, primary);
    if (kind !== 'absent') window.localStorage.setItem(collection.mirror, mirror);
    const get = Storage.prototype.getItem;
    const denied = kind === 'unreadable' ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === collection.mirror) throw new Error('mirror unavailable');
      return get.call(this, key);
    }) : null;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const failure = new Error('quota failure');
    const write = vi.spyOn(db, 'writeKeyValue').mockImplementationOnce(async () => {
      started();
      await gate;
      throw failure;
    });
    const pending = collection.write();
    // Attach the rejection assertion before releasing the suspended real writer.
    const rejected = expect(pending).rejects.toBe(failure);
    await entered;
    const expectedMirror = kind === 'changed-corrupt' ? '{new-recoverable-fragment'
      : kind === 'changed-valid' ? JSON.stringify({ version: 1, items: [] })
        : kind === 'absent' ? null : mirror;
    if (kind.startsWith('changed')) window.localStorage.setItem(collection.mirror, expectedMirror!);
    release();
    try {
      await rejected;
    } finally {
      denied?.mockRestore();
      write.mockRestore();
    }
    expect(await db.readKeyValue(collection.key)).toBe(primary);
    expect(window.localStorage.getItem(collection.mirror)).toBe(expectedMirror);
    expect(await collection.read()).toEqual(collection.items);
    await waitForScopedWrites('guest');
    await collection.write();
    expect(await collection.read()).toEqual([]);
    expect(window.localStorage.getItem(collection.mirror)).toBe(expectedMirror);
  });
}
