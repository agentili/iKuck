import type { ShoppingListItem } from '@ikuck/shared/contracts';
import { isShoppingListItem } from '../domain/shoppingList';
import { deleteKeyValue, isIndexedDbAvailable, writeKeyValue } from './indexedDb';
import { parseCollectionSnapshot, readCollectionSnapshot } from './collectionSnapshot';
import { getActiveDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { trackScopedWrite } from '../sync/scopeWriteFence';

export const SHOPPING_LIST_STORAGE_KEY = 'ikuck-shopping-list-v1';
export const SHOPPING_LIST_DATABASE_KEY = 'shopping-list';

const scopedStorageKey = (scope: SyncScope = getActiveDataScope()): string => scope === 'guest'
  ? SHOPPING_LIST_STORAGE_KEY
  : scopeStorageKey(scope, SHOPPING_LIST_STORAGE_KEY);
const scopedDatabaseKey = (scope: SyncScope = getActiveDataScope()): string => scope === 'guest'
  ? SHOPPING_LIST_DATABASE_KEY
  : scopeStorageKey(scope, SHOPPING_LIST_DATABASE_KEY);

interface PersistedShoppingList {
  items: ShoppingListItem[];
  version: number;
}

export const normalizeShoppingList = (items: readonly unknown[]): ShoppingListItem[] => {
  const unique = new Map<string, ShoppingListItem>();
  for (const item of items) {
    if (isShoppingListItem(item)) unique.set(item.id, item);
  }
  return [...unique.values()];
};

const serialize = (items: readonly ShoppingListItem[]): string => JSON.stringify({
  items: normalizeShoppingList(items),
  version: 1,
} satisfies PersistedShoppingList);

export async function readShoppingList(scope: SyncScope = getActiveDataScope()): Promise<ShoppingListItem[]> {
  return normalizeShoppingList(parseCollectionSnapshot(await readCollectionSnapshot(scopedDatabaseKey(scope), scopedStorageKey(scope)), isShoppingListItem));
}

export async function writeShoppingList(items: readonly ShoppingListItem[], scope: SyncScope = getActiveDataScope()): Promise<void> {
  return trackScopedWrite(scope, async (assertWritable) => {
    await readShoppingList(scope);
    assertWritable();
    const serialized = serialize(items);
    if (!isIndexedDbAvailable()) {
      assertWritable();
      window.localStorage.setItem(scopedStorageKey(scope), serialized);
      return;
    }
    try {
      assertWritable();
      await writeKeyValue(scopedDatabaseKey(scope), serialized, assertWritable);
      assertWritable();
    } catch (error) {
      assertWritable();
      // Keep both copies unchanged on rejection; the primary remains authoritative.
      // In particular, never overwrite a recovery mirror changed during the await.
      throw error;
    }
  });
}

export async function clearShoppingList(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(scopedDatabaseKey(scope));
  window.localStorage.removeItem(scopedStorageKey(scope));
}
