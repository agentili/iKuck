import type { PantryRecipe } from '../../domain/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteLocalDatabase, readKeyValue } from '../../storage/indexedDb';
import * as shoppingListStorage from '../../storage/shoppingListStorage';
import { readShoppingList, writeShoppingList } from '../../storage/shoppingListStorage';
import { setActiveDataScope, setPersonalDataScope } from '../../sync/scopeContext';
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
    setActiveDataScope('guest');
    await deleteLocalDatabase();
    usePersistenceStatusStore.getState().reset();
    useShoppingListStore.setState({ hasHydrated: false, items: [] });
  });

  it('hydrates with an empty guest list', async () => {
    await hydrateShoppingListStore();

    expect(useShoppingListStore.getState()).toMatchObject({ hasHydrated: true, items: [] });
  });

  it('retries hydration for the newest account after an older request is in flight', async () => {
    const accountA = 'account:hydration-a' as const;
    const accountB = 'account:hydration-b' as const;
    const item = (id: string) => ({
      id,
      ingredientId: 'pasta',
      label: id,
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z',
    });
    let releaseOld: (() => void) | undefined;
    const oldRequest = new Promise<void>((resolve) => { releaseOld = resolve; });
    const readSpy = vi.spyOn(shoppingListStorage, 'readShoppingList').mockImplementation(async (scope) => {
      if (scope === accountA) await oldRequest;
      return [item(scope === accountA ? 'account-a-item' : 'account-b-item')];
    });

    setActiveDataScope(accountA);
    const firstHydration = hydrateShoppingListStore();
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledWith(accountA));
    setPersonalDataScope(accountB);
    const secondHydration = hydrateShoppingListStore();
    releaseOld?.();
    await Promise.all([firstHydration, secondHydration]);

    expect(useShoppingListStore.getState()).toMatchObject({ hasHydrated: true, items: [{ id: 'account-b-item' }] });
    readSpy.mockRestore();
    setActiveDataScope('guest');
  });

  it('keeps personal shopping data out of house scope and rehydrates on account change', async () => {
    const accountScope = 'account:scope-user' as const;
    const otherAccountScope = 'account:other-user' as const;
    const houseScope = 'house:scope-house' as const;
    const item = (id: string, label: string) => ({
      id,
      ingredientId: 'pasta',
      label,
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z',
    });
    await writeShoppingList([item('account-item', 'Account item')], accountScope);
    await writeShoppingList([item('other-account-item', 'Other account item')], otherAccountScope);

    setActiveDataScope(accountScope);
    await hydrateShoppingListStore();
    expect(useShoppingListStore.getState().items).toMatchObject([{ id: 'account-item' }]);

    setActiveDataScope(houseScope);
    expect(useShoppingListStore.getState()).toMatchObject({ hasHydrated: true, items: [{ id: 'account-item' }] });

    setPersonalDataScope(otherAccountScope);
    expect(useShoppingListStore.getState()).toMatchObject({ hasHydrated: false, items: [] });
    await hydrateShoppingListStore();
    expect(useShoppingListStore.getState().items).toMatchObject([{ id: 'other-account-item' }]);
    setActiveDataScope('guest');
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

  it('restores a removed item with the same identity', () => {
    const id = useShoppingListStore.getState().addItem({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
    });
    const removedItem = useShoppingListStore.getState().items[0];

    useShoppingListStore.getState().removeItem(id!);

    expect(useShoppingListStore.getState().restoreItem(removedItem)).toBe(true);
    expect(useShoppingListStore.getState().items).toContainEqual(removedItem);
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
