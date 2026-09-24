import type { ShoppingListItem } from '@ikuck/shared/contracts';
import { isShoppingListItem } from '../domain/shoppingList';
import { isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';
import { getActiveDataScope, scopeStorageKey } from '../sync/scopeContext';

export const SHOPPING_LIST_STORAGE_KEY = 'ikuck-shopping-list-v1';
export const SHOPPING_LIST_DATABASE_KEY = 'shopping-list';

const scopedStorageKey = (): string => getActiveDataScope() === 'guest'
  ? SHOPPING_LIST_STORAGE_KEY
  : scopeStorageKey(getActiveDataScope(), SHOPPING_LIST_STORAGE_KEY);
const scopedDatabaseKey = (): string => getActiveDataScope() === 'guest'
  ? SHOPPING_LIST_DATABASE_KEY
  : scopeStorageKey(getActiveDataScope(), SHOPPING_LIST_DATABASE_KEY);

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

const readFallback = (): ShoppingListItem[] => parse(window.localStorage.getItem(scopedStorageKey()));

export async function readShoppingList(): Promise<ShoppingListItem[]> {
  if (!isIndexedDbAvailable()) return readFallback();

  try {
    return parse(await readKeyValue<string>(scopedDatabaseKey()));
  } catch {
    return readFallback();
  }
}

export async function writeShoppingList(items: readonly ShoppingListItem[]): Promise<void> {
  const serialized = serialize(items);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(scopedStorageKey(), serialized);
    return;
  }

  try {
    await writeKeyValue(scopedDatabaseKey(), serialized);
  } catch (error) {
    window.localStorage.setItem(scopedStorageKey(), serialized);
    throw error;
  }
}
