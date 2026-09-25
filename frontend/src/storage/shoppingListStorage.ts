import type { ShoppingListItem } from '@ikuck/shared/contracts';
import { isShoppingListItem } from '../domain/shoppingList';
import { deleteKeyValue, isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';
import { getPersonalDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';

export const SHOPPING_LIST_STORAGE_KEY = 'ikuck-shopping-list-v1';
export const SHOPPING_LIST_DATABASE_KEY = 'shopping-list';

const scopedStorageKey = (scope: SyncScope = getPersonalDataScope()): string => scope === 'guest'
  ? SHOPPING_LIST_STORAGE_KEY
  : scopeStorageKey(scope, SHOPPING_LIST_STORAGE_KEY);
const scopedDatabaseKey = (scope: SyncScope = getPersonalDataScope()): string => scope === 'guest'
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

const parse = (raw: string | null): ShoppingListItem[] => {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedShoppingList>;
    return Array.isArray(parsed.items) ? normalizeShoppingList(parsed.items) : [];
  } catch {
    return [];
  }
};

const readFallback = (scope: SyncScope = getPersonalDataScope()): ShoppingListItem[] => parse(window.localStorage.getItem(scopedStorageKey(scope)));

export async function readShoppingList(scope: SyncScope = getPersonalDataScope()): Promise<ShoppingListItem[]> {
  if (!isIndexedDbAvailable()) return readFallback(scope);

  try {
    return parse(await readKeyValue<string>(scopedDatabaseKey(scope)));
  } catch {
    return readFallback(scope);
  }
}

export async function writeShoppingList(items: readonly ShoppingListItem[], scope: SyncScope = getPersonalDataScope()): Promise<void> {
  const serialized = serialize(items);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(scopedStorageKey(scope), serialized);
    return;
  }

  try {
    await writeKeyValue(scopedDatabaseKey(scope), serialized);
  } catch (error) {
    window.localStorage.setItem(scopedStorageKey(scope), serialized);
    throw error;
  }
}

export async function clearShoppingList(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(scopedDatabaseKey(scope));
  window.localStorage.removeItem(scopedStorageKey(scope));
}
