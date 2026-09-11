import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import type { ParsedIngredient } from '../domain/types';

interface PantryState {
  pantryItems: ParsedIngredient[];
  stapleIds: string[];
  addIngredients: (items: ParsedIngredient[]) => void;
  removeIngredient: (id: string) => void;
  toggleStaple: (id: string) => void;
  resetPantry: () => void;
  getAvailableIngredientIds: () => string[];
}

const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    const raw = window.localStorage.getItem(name);
    if (raw === null) return null;

    try {
      JSON.parse(raw);
      return raw;
    } catch {
      window.localStorage.removeItem(name);
      return null;
    }
  },
  setItem: (name, value) => window.localStorage.setItem(name, value),
  removeItem: (name) => window.localStorage.removeItem(name),
};

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

export const usePantryStore = create<PantryState>()(
  persist(
    (set, get) => ({
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
    }),
    {
      name: 'iricetto-pantry-v1',
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
    },
  ),
);
