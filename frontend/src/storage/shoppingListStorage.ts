import type { ShoppingListItem } from '@ikuck/shared/contracts';
import { isShoppingListItem } from '../domain/shoppingList';
import { isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';

export const SHOPPING_LIST_STORAGE_KEY = 'ikuck-shopping-list-v1';
export const SHOPPING_LIST_DATABASE_KEY = 'shopping-list';

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

const readFallback = (): ShoppingListItem[] => parse(window.localStorage.getItem(SHOPPING_LIST_STORAGE_KEY));

export async function readShoppingList(): Promise<ShoppingListItem[]> {
  if (!isIndexedDbAvailable()) return readFallback();

  try {
    return parse(await readKeyValue<string>(SHOPPING_LIST_DATABASE_KEY));
  } catch {
    return readFallback();
  }
}

export async function writeShoppingList(items: readonly ShoppingListItem[]): Promise<void> {
  const serialized = serialize(items);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(SHOPPING_LIST_STORAGE_KEY, serialized);
    return;
  }

  try {
    await writeKeyValue(SHOPPING_LIST_DATABASE_KEY, serialized);
  } catch (error) {
    window.localStorage.setItem(SHOPPING_LIST_STORAGE_KEY, serialized);
    throw error;
  }
}
