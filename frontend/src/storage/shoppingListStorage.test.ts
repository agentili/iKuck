import { beforeEach, describe, expect, it } from 'vitest';
import type { ShoppingListItem } from '@ikuck/shared/contracts';
import { deleteLocalDatabase } from './indexedDb';
import { readShoppingList, writeShoppingList } from './shoppingListStorage';

const item: ShoppingListItem = {
  id: 'shopping-pasta',
  ingredientId: 'pasta',
  label: 'Pasta',
  quantity: 500,
  unit: 'g',
  note: null,
  purchased: false,
  sourceRecipeId: 'pasta-tonno-pomodoro',
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z',
};

describe('shopping list storage', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
  });

  it('hydrates an empty list when no local value exists', async () => {
    await expect(readShoppingList()).resolves.toEqual([]);
  });

  it('round-trips item details through the existing local database', async () => {
    await writeShoppingList([item]);

    await expect(readShoppingList()).resolves.toEqual([item]);
  });

  it('ignores malformed or invalid local values instead of exposing them', async () => {
    const { writeKeyValue } = await import('./indexedDb');
    await writeKeyValue('shopping-list', '{not-json');

    await expect(readShoppingList()).resolves.toEqual([]);
  });
});
