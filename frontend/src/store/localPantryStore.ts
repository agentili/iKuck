import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import type { ParsedIngredient } from '../domain/types';
import {
  enqueuePantryMutation,
  registerPantrySnapshotListener,
} from '../sync/syncQueue';
import {
  PANTRY_STORAGE_KEY,
  pantryStorage,
} from '../storage/pantryStorage';
import type { PantrySnapshot } from '../storage/pantryStorage';

export { LEGACY_PANTRY_STORAGE_KEY, PANTRY_STORAGE_KEY } from '../storage/pantryStorage';

export interface PantryState {
  hasHydrated: boolean;
  pantryItems: ParsedIngredient[];
  stapleIds: string[];
  addIngredients: (items: ParsedIngredient[]) => void;
  removeIngredient: (id: string) => void;
  toggleStaple: (id: string) => void;
  resetPantry: () => void;
  getAvailableIngredientIds: () => string[];
}

const mergeUniqueIngredients = (
  existing: ParsedIngredient[],
  incoming: ParsedIngredient[],
): ParsedIngredient[] => {
  const unique = new Map(existing.map((item) => [item.id, item]));

  for (const item of incoming) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }

  return [...unique.values()];
};

let markHydrated: (() => void) | null = null;
let hydrationPromise: Promise<void> | null = null;
let applyRemoteSnapshot: ((snapshot: PantrySnapshot) => void) | null = null;

export const usePantryStore = create<PantryState>()(
  persist(
    (set, get) => {
      markHydrated = () => set({ hasHydrated: true });

      return {
        hasHydrated: false,
        pantryItems: [],
        stapleIds: [...DEFAULT_STAPLE_IDS],
        addIngredients: (items) => {
          const existingIds = new Set(get().pantryItems.map((item) => item.id));
          const additions = items.filter((item) => !existingIds.has(item.id));
          if (additions.length === 0) return;

          set((state) => ({
            pantryItems: mergeUniqueIngredients(state.pantryItems, additions),
          }));
          for (const item of additions) {
            void enqueuePantryMutation('pantry_item', item.id, 'upsert', item).catch(() => undefined);
          }
        },
        removeIngredient: (id) => {
          if (!get().pantryItems.some((item) => item.id === id)) return;
          set((state) => ({
            pantryItems: state.pantryItems.filter((item) => item.id !== id),
          }));
          void enqueuePantryMutation('pantry_item', id, 'delete', null).catch(() => undefined);
        },
        toggleStaple: (id) => {
          const enabled = !get().stapleIds.includes(id);
          set((state) => ({
            stapleIds: enabled
              ? [...state.stapleIds, id]
              : state.stapleIds.filter((item) => item !== id),
          }));
          void enqueuePantryMutation('staple_preference', id, 'upsert', { enabled }).catch(() => undefined);
        },
        resetPantry: () => {
          const current = get();
          const removedItems = current.pantryItems.map((item) => item.id);
          const defaultStapleIds = new Set<string>(DEFAULT_STAPLE_IDS);
          const changedStaples = new Set<string>([...current.stapleIds, ...DEFAULT_STAPLE_IDS]);

          set({
            pantryItems: [],
            stapleIds: [...DEFAULT_STAPLE_IDS],
          });
          for (const itemId of removedItems) {
            void enqueuePantryMutation('pantry_item', itemId, 'delete', null).catch(() => undefined);
          }
          for (const stapleId of changedStaples) {
            const enabled = defaultStapleIds.has(stapleId);
            if (current.stapleIds.includes(stapleId) !== enabled) {
              void enqueuePantryMutation('staple_preference', stapleId, 'upsert', { enabled }).catch(() => undefined);
            }
          }
        },
        getAvailableIngredientIds: () => [
          ...get().pantryItems.filter((item) => item.known).map((item) => item.id),
          ...get().stapleIds,
        ],
      };
    },
    {
      name: PANTRY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => pantryStorage),
      skipHydration: true,
      partialize: (state) => {
        const persistedState = { ...state };
        Reflect.deleteProperty(persistedState, 'hasHydrated');
        return persistedState;
      },
      onRehydrateStorage: () => () => {
        markHydrated?.();
      },
    },
  ),
);

applyRemoteSnapshot = (snapshot) => {
  usePantryStore.setState({
    pantryItems: snapshot.pantryItems,
    stapleIds: snapshot.stapleIds,
  });
};

registerPantrySnapshotListener((snapshot) => {
  applyRemoteSnapshot?.(snapshot);
});

export async function hydratePantryStore(): Promise<void> {
  if (usePantryStore.getState().hasHydrated) return;

  if (hydrationPromise === null) {
    hydrationPromise = Promise.resolve(usePantryStore.persist.rehydrate())
      .catch(() => undefined)
      .then(() => {
        if (!usePantryStore.getState().hasHydrated) {
          usePantryStore.setState({ hasHydrated: true });
        }
      })
      .finally(() => {
        hydrationPromise = null;
      });
  }

  await hydrationPromise;
}
