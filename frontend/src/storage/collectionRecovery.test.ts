import { beforeEach, expect, it, vi } from 'vitest';
import * as db from './indexedDb';
import { readShoppingList, writeShoppingList } from './shoppingListStorage';
import { readCookEvents, writeCookEvents, readRecipePreferences } from './activityStorage';
import { hydrateShoppingListStore, useShoppingListStore } from '../store/shoppingListStore';
import { hydrateActivityStore, useActivityStore } from '../store/activityStore';
import { setActiveDataScope, setPersonalDataScope, scopeStorageKey } from '../sync/scopeContext';
import { importLocalData, syncNow, readSyncCursor } from '../sync/syncQueue';
import { RECIPES } from '../domain/recipes';

const item = { id: 'old', ingredientId: 'pasta', label: 'Pasta', quantity: null, unit: null, note: null, purchased: false, sourceRecipeId: null, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z' };
const event = { id: 'old-event', recipeId: 'pasta', recipeTitle: 'Pasta', servings: 2, cookedAt: item.createdAt, note: null, createdAt: item.createdAt, updatedAt: item.createdAt };

beforeEach(async () => {
  vi.restoreAllMocks();
  setActiveDataScope('account:reset');
  setActiveDataScope('guest');
  window.localStorage.clear();
  await db.deleteLocalDatabase();
});

it.each(['shopping-list', 'activity', 'recipe-preferences'])('keeps corrupt %s intact during sync without advancing its cursor', async key => {
  const scope = 'account:recovery';
  setActiveDataScope(scope);
  setPersonalDataScope(scope);
  const actualKey = scopeStorageKey(scope, key);
  await db.writeKeyValue(actualKey, '{recoverable-corruption');
  const entityType = key === 'shopping-list' ? 'shopping_list_item' : key === 'activity' ? 'cook_event' : 'recipe_preference';
  const payload = key === 'shopping-list' ? item : key === 'activity' ? event : { recipeId: 'pasta', favorite: true, rating: null, note: null, createdAt: item.createdAt, updatedAt: item.createdAt };
  const request = vi.fn().mockResolvedValue({ changes: [{ mutationId: 'remote', deviceId: 'other', entityType,
    entityId: key === 'recipe-preferences' ? 'pasta' : key === 'activity' ? event.id : item.id, operation: 'upsert', payload,
    clientUpdatedAt: item.createdAt, serverSequence: 1 }], nextCursor: 1 });
  await expect(syncNow({ session: { userId: 'recovery', emailVerifiedAt: item.createdAt, csrfToken: 'fixture' }, request })).rejects.toBeInstanceOf(SyntaxError);
  await expect(db.readKeyValue(actualKey)).resolves.toBe('{recoverable-corruption');
  expect(await readSyncCursor(scope)).toBe(0);
});

it('refuses an explicit guest import when a source collection is unreadable', async () => {
  await db.writeKeyValue('shopping-list', '{recoverable-corruption');
  setActiveDataScope('account:recovery');
  setPersonalDataScope('account:recovery');
  await expect(importLocalData({ userId: 'recovery', emailVerifiedAt: item.createdAt, csrfToken: 'fixture' }, () => true)).rejects.toBeInstanceOf(SyntaxError);
  await expect(db.readKeyValue('shopping-list')).resolves.toBe('{recoverable-corruption');
});

it('blocks writes before hydration in a newly selected scope', async () => {
  setActiveDataScope('account:not-loaded');
  expect(useShoppingListStore.getState().addItem(item)).toBeNull();
  expect(await useActivityStore.getState().recordCookEvent(RECIPES[0], 2)).toBeNull();
});

it('preserves a fallback-only snapshot when localStorage reads fail and recovers without deletion', async () => {
  const raw = JSON.stringify({ items: [item], version: 1 });
  window.localStorage.setItem('ikuck-shopping-list-v1', raw);
  const available = vi.spyOn(db, 'isIndexedDbAvailable').mockReturnValue(false);
  const fallback = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('fallback unavailable'); });
  try {
    await hydrateShoppingListStore();
    expect(useShoppingListStore.getState().hydrationError).toBe(true);
    expect(useShoppingListStore.getState().addItem(item)).toBeNull();
    await expect(writeShoppingList([])).rejects.toThrow('fallback unavailable');
    fallback.mockRestore();
    await hydrateShoppingListStore();
    expect(useShoppingListStore.getState().items).toEqual([item]);
    expect(window.localStorage.getItem('ikuck-shopping-list-v1')).toBe(raw);
  } finally { fallback.mockRestore(); available.mockRestore(); }
});

it('preserves shopping data after primary and fallback read failures, fences mutations and recovers on retry', async () => {
  await writeShoppingList([item]);
  useShoppingListStore.setState({ items: [item], hasHydrated: false });
  const read = vi.spyOn(db, 'readKeyValue').mockRejectedValue(new Error('read unavailable'));
  const fallback = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('fallback unavailable'); });
  await hydrateShoppingListStore();
  expect(useShoppingListStore.getState().items).toEqual([item]);
  expect(useShoppingListStore.getState().hydrationError).toBe(true);
  expect(useShoppingListStore.getState().addItem({ ...item, label: 'Nuovo' })).toBeNull();
  useShoppingListStore.getState().removeItem(item.id);
  expect(useShoppingListStore.getState().items).toEqual([item]);
  await expect(writeShoppingList([])).rejects.toThrow();
  read.mockRestore(); fallback.mockRestore();
  await hydrateShoppingListStore();
  expect(useShoppingListStore.getState().hydrationError).toBe(false);
  expect(useShoppingListStore.getState().items).toEqual([item]);
  await expect(readShoppingList()).resolves.toEqual([item]);
});

it('preserves activity and preferences on failed reads and releases only after successful retry', async () => {
  await writeCookEvents([event]);
  useActivityStore.setState({ events: [event], preferences: [], hasHydrated: false });
  const read = vi.spyOn(db, 'readKeyValue').mockRejectedValue(new Error('read unavailable'));
  await hydrateActivityStore();
  expect(useActivityStore.getState().events).toEqual([event]);
  expect(useActivityStore.getState().hydrationError).toBe(true);
  expect(await useActivityStore.getState().recordCookEvent(RECIPES[0], 2)).toBeNull();
  expect(useActivityStore.getState().setRecipePreference('pasta', true, null, null)).toBe(false);
  expect(useActivityStore.getState().clearActivity()).toBe(0);
  read.mockRestore();
  await hydrateActivityStore();
  expect(useActivityStore.getState().hydrationError).toBe(false);
  await expect(readCookEvents()).resolves.toEqual([event]);
  await expect(readRecipePreferences()).resolves.toEqual([]);
  setActiveDataScope('account:other');
  await hydrateActivityStore();
  expect(useActivityStore.getState().events).toEqual([]);
  setActiveDataScope('guest');
  await hydrateActivityStore();
  expect(useActivityStore.getState().events).toEqual([event]);
});
