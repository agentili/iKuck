import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import type { ParsedIngredient } from '../domain/types';
import {
  PANTRY_STORAGE_KEY,
  pantryStorage,
} from '../storage/pantryStorage';

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

export const usePantryStore = create<PantryState>()(
  persist(
    (set, get) => {
      markHydrated = () => set({ hasHydrated: true });

      return {
        hasHydrated: false,
        pantryItems: [],
        stapleIds: [...DEFAULT_STAPLE_IDS],
        addIngredients: (items) =>
          set((state) => ({
            pantryItems: mergeUniqueIngredients(state.pantryItems, items),
          })),
        removeIngredient: (id) =>
          set((state) => ({
            pantryItems: state.pantryItems.filter((item) => item.id !== id),
          })),
        toggleStaple: (id) =>
          set((state) => ({
            stapleIds: state.stapleIds.includes(id)
              ? state.stapleIds.filter((item) => item !== id)
              : [...state.stapleIds, id],
          })),
        resetPantry: () =>
          set({
            pantryItems: [],
            stapleIds: [...DEFAULT_STAPLE_IDS],
          }),
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
