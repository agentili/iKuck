import type { PantryRecipe } from '../../domain/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteLocalDatabase, readKeyValue } from '../../storage/indexedDb';
import * as shoppingListStorage from '../../storage/shoppingListStorage';
import { readShoppingList } from '../../storage/shoppingListStorage';
import { GUEST_SYNC_SCOPE, readQueuedMutations, waitForPendingQueueWrites } from '../../sync/syncQueue';
import { hydrateShoppingListStore, useShoppingListStore } from '../shoppingListStore';
import { usePersistenceStatusStore } from '../persistenceStatusStore';

const recipe: PantryRecipe = {
  id: 'recipe-1',
  title: 'Pasta semplice',
  description: '',
  category: 'vegetables',
  durationMinutes: 15,
  difficulty: 'easy',
  servings: 2,
  ingredients: [
    { ingredientId: 'pasta', amount: '180 g' },
    { ingredientId: 'tomato_sauce', amount: '250 ml' },
    { ingredientId: 'basil', amount: '6 foglie', optional: true },
  ],
  steps: [],
  tags: [],
};

describe('shopping list store', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    usePersistenceStatusStore.getState().reset();
    useShoppingListStore.setState({ hasHydrated: false, items: [] });
  });

  it('hydrates with an empty guest list', async () => {
    await hydrateShoppingListStore();

    expect(useShoppingListStore.getState()).toMatchObject({ hasHydrated: true, items: [] });
  });

  it('adds, edits, toggles, removes and clears items immediately', async () => {
    const id = useShoppingListStore.getState().addItem({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: 500,
      unit: 'g',
      note: null,
      purchased: false,
      sourceRecipeId: null,
    });
    expect(id).not.toBeNull();
    expect(useShoppingListStore.getState().items[0]).toMatchObject({ label: 'Pasta', purchased: false });

    expect(useShoppingListStore.getState().updateItem(id!, { quantity: 1, unit: 'kg', note: 'Scorta' })).toBe(true);
    expect(useShoppingListStore.getState().togglePurchased(id!)).toBe(true);
    expect(useShoppingListStore.getState().items[0]).toMatchObject({ quantity: 1, unit: 'kg', note: 'Scorta', purchased: true });

    expect(useShoppingListStore.getState().clearPurchased()).toBe(1);
    expect(useShoppingListStore.getState().items).toEqual([]);
  });

  it('surfaces a shopping list persistence failure while keeping the local change available', async () => {
    vi.spyOn(shoppingListStorage, 'writeShoppingList').mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    useShoppingListStore.getState().addItem({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
    });

    await vi.waitFor(() => expect(usePersistenceStatusStore.getState().statuses['shopping-list'].state).toBe('memory-only'));
    expect(useShoppingListStore.getState().items).toHaveLength(1);
  });

  it('rejects invalid details without changing the list', () => {
    expect(useShoppingListStore.getState().addItem({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: 0,
      unit: 'g',
      note: null,
      purchased: false,
      sourceRecipeId: null,
    })).toBeNull();
    expect(useShoppingListStore.getState().items).toEqual([]);
  });

  it('adds only missing non-optional recipe ingredients and keeps source metadata', async () => {
    const added = useShoppingListStore.getState().addMissingRecipeIngredients(recipe, ['pasta']);

    expect(added).toBe(1);
    expect(useShoppingListStore.getState().items).toMatchObject([{
      ingredientId: 'tomato_sauce',
      quantity: 250,
      unit: 'ml',
      sourceRecipeId: 'recipe-1',
    }]);
  });

  it('queues local list mutations as shopping-list entities', async () => {
    useShoppingListStore.getState().addItem({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
    });
    await waitForPendingQueueWrites();

    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toEqual([
      expect.objectContaining({ entityType: 'shopping_list_item', operation: 'upsert' }),
    ]);
  });

  it('persists usable state across hydration', async () => {
    useShoppingListStore.getState().addItem({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: null,
      unit: null,
      note: 'Per il weekend',
      purchased: false,
      sourceRecipeId: null,
    });
    await waitForPendingQueueWrites();
    const persisted = await readKeyValue<string>('shopping-list');
    expect(persisted).not.toBeNull();

    useShoppingListStore.setState({ hasHydrated: false, items: [] });
    await hydrateShoppingListStore();

    await expect(readShoppingList()).resolves.toMatchObject([{ label: 'Pasta', note: 'Per il weekend' }]);
  });

  it('keeps in-memory changes when persistence reports an error', async () => {
    const storage = await import('../../storage/shoppingListStorage');
    vi.spyOn(storage, 'writeShoppingList').mockRejectedValueOnce(new Error('quota exceeded'));

    const id = useShoppingListStore.getState().addItem({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
    });

    expect(id).not.toBeNull();
    expect(useShoppingListStore.getState().items).toHaveLength(1);
  });
});
