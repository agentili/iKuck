import { create } from 'zustand';
import type { PantryUnit, ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';
import { createShoppingListItemFromRecipe, validateShoppingListItemDetails } from '../domain/shoppingList';
import type { PantryRecipe } from '../domain/types';
import {
  normalizeShoppingList,
  readShoppingList,
  writeShoppingList,
} from '../storage/shoppingListStorage';
import {
  GUEST_SYNC_SCOPE,
  enqueueEntityMutation,
  registerShoppingListSnapshotListener,
  waitForPendingQueueWrites,
} from '../sync/syncQueue';

export interface ShoppingListItemPatch {
  label?: string;
  quantity?: number | null;
  unit?: PantryUnit | null;
  note?: string | null;
}

export interface ShoppingListState {
  hasHydrated: boolean;
  items: ShoppingListItem[];
  addItem: (input: ShoppingListItemPayload) => string | null;
  addMissingRecipeIngredients: (recipe: PantryRecipe, availableIds: string[]) => number;
  updateItem: (id: string, patch: ShoppingListItemPatch) => boolean;
  togglePurchased: (id: string) => boolean;
  removeItem: (id: string) => void;
  clearPurchased: () => number;
}

let hydrationPromise: Promise<void> | null = null;
let pendingStorageWrites = Promise.resolve();

const createItemId = (): string => {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `shopping:${id}`;
};

const persistItems = (items: readonly ShoppingListItem[]): Promise<void> => {
  const operation = pendingStorageWrites.then(() => writeShoppingList(items));
  pendingStorageWrites = operation.catch(() => undefined);
  return operation;
};

const normalizeOptionalText = (value: string | null): string | null => {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
};

const isValidPayload = (input: ShoppingListItemPayload): boolean => (
  input.ingredientId.trim().length > 0
    && typeof input.purchased === 'boolean'
    && (input.sourceRecipeId === null || input.sourceRecipeId.trim().length > 0)
    && validateShoppingListItemDetails(input.label, input.quantity, input.unit, input.note).length === 0
);

const persistAndQueue = (
  items: readonly ShoppingListItem[],
  changed: ShoppingListItem,
  operation: 'upsert' | 'delete' = 'upsert',
): void => {
  void persistItems(items).catch(() => undefined);
  void enqueueEntityMutation(GUEST_SYNC_SCOPE, 'shopping_list_item', changed.id, operation, operation === 'upsert' ? changed : null).catch(() => undefined);
};

export const useShoppingListStore = create<ShoppingListState>((set, get) => ({
  hasHydrated: false,
  items: [],
  addItem: (input) => {
    if (!isValidPayload(input)) return null;
    const now = new Date().toISOString();
    const item: ShoppingListItem = {
      ...input,
      ingredientId: input.ingredientId.trim(),
      label: input.label.trim(),
      note: normalizeOptionalText(input.note),
      sourceRecipeId: normalizeOptionalText(input.sourceRecipeId),
      id: createItemId(),
      createdAt: now,
      updatedAt: now,
    };
    const items = [...get().items, item];
    set({ items });
    persistAndQueue(items, item);
    return item.id;
  },
  addMissingRecipeIngredients: (recipe, availableIds) => {
    const available = new Set(availableIds);
    let added = 0;
    for (const ingredient of recipe.ingredients) {
      if (ingredient.optional || available.has(ingredient.ingredientId)) continue;
      if (get().items.some((item) => !item.purchased && item.ingredientId === ingredient.ingredientId)) continue;
      const payload = createShoppingListItemFromRecipe(recipe, ingredient);
      if (get().addItem(payload) !== null) added += 1;
    }
    return added;
  },
  updateItem: (id, patch) => {
    const existing = get().items.find((item) => item.id === id);
    if (existing === undefined) return false;
    const next: ShoppingListItem = {
      ...existing,
      ...patch,
      label: patch.label === undefined ? existing.label : patch.label.trim(),
      note: patch.note === undefined ? existing.note : normalizeOptionalText(patch.note),
      updatedAt: new Date().toISOString(),
    };
    if (!isValidPayload(next)) return false;
    const items = get().items.map((item) => item.id === id ? next : item);
    set({ items });
    persistAndQueue(items, next);
    return true;
  },
  togglePurchased: (id) => {
    const existing = get().items.find((item) => item.id === id);
    if (existing === undefined) return false;
    const updated = { ...existing, purchased: !existing.purchased, updatedAt: new Date().toISOString() };
    const items = get().items.map((item) => item.id === id ? updated : item);
    set({ items });
    persistAndQueue(items, updated);
    return true;
  },
  removeItem: (id) => {
    const existing = get().items.find((item) => item.id === id);
    if (existing === undefined) return;
    const items = get().items.filter((item) => item.id !== id);
    set({ items });
    persistAndQueue(items, existing, 'delete');
  },
  clearPurchased: () => {
    const removed = get().items.filter((item) => item.purchased);
    if (removed.length === 0) return 0;
    const items = get().items.filter((item) => !item.purchased);
    set({ items });
    void persistItems(items).catch(() => undefined);
    for (const item of removed) {
      void enqueueEntityMutation(GUEST_SYNC_SCOPE, 'shopping_list_item', item.id, 'delete', null).catch(() => undefined);
    }
    return removed.length;
  },
}));

registerShoppingListSnapshotListener((items) => {
  useShoppingListStore.setState({ items: normalizeShoppingList(items) });
});

export async function waitForPendingShoppingListWrites(): Promise<void> {
  await pendingStorageWrites;
  await waitForPendingQueueWrites();
}

export async function hydrateShoppingListStore(): Promise<void> {
  if (useShoppingListStore.getState().hasHydrated) return;
  if (hydrationPromise === null) {
    hydrationPromise = readShoppingList()
      .then((items) => useShoppingListStore.setState({ items: normalizeShoppingList(items), hasHydrated: true }))
      .catch(() => useShoppingListStore.setState({ items: [], hasHydrated: true }))
      .finally(() => {
        hydrationPromise = null;
      });
  }
  await hydrationPromise;
}
