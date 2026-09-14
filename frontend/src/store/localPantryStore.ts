import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import { aggregatePantryLots, validatePantryLotDetails, type PantryQuantityAggregate } from '../domain/pantryLots';
import type { ParsedIngredient } from '../domain/types';
import type { PantryLot, PantryLotPayload } from '@ikuck/shared/contracts';
import {
  GUEST_SYNC_SCOPE,
  enqueuePantryMutation,
  registerPantrySnapshotListener,
} from '../sync/syncQueue';
import {
  PANTRY_STORAGE_KEY,
  pantryStorage,
  createPresencePantryLot,
  derivePantryItems,
  normalizePantrySnapshot,
} from '../storage/pantryStorage';
import type { PantrySnapshot } from '../storage/pantryStorage';

export { LEGACY_PANTRY_STORAGE_KEY, PANTRY_STORAGE_KEY } from '../storage/pantryStorage';

export interface PantryState {
  hasHydrated: boolean;
  pantryItems: ParsedIngredient[];
  stapleIds: string[];
  pantryLots: PantryLot[];
  addIngredients: (items: ParsedIngredient[]) => void;
  addPantryLot: (input: PantryLotPayload) => string | null;
  updatePantryLot: (id: string, details: Pick<PantryLotPayload, 'quantity' | 'unit' | 'expiresAt'>) => boolean;
  removePantryLot: (id: string) => void;
  getLotsForIngredient: (ingredientId: string) => PantryLot[];
  getPantryQuantitySummary: () => PantryQuantityAggregate[];
  removeIngredient: (id: string) => void;
  toggleStaple: (id: string) => void;
  resetPantry: () => void;
  getAvailableIngredientIds: () => string[];
}

let markHydrated: (() => void) | null = null;
let hydrationPromise: Promise<void> | null = null;
let applyRemoteSnapshot: ((snapshot: PantrySnapshot) => void) | null = null;

const createLotId = (ingredientId: string, existingLots: readonly PantryLot[]): string => {
  if (!existingLots.some((lot) => lot.ingredientId === ingredientId)) return ingredientId;
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${ingredientId}:${randomId}`;
};

const normalizeStateSnapshot = (state: Pick<PantryState, 'pantryItems' | 'stapleIds' | 'pantryLots'>): PantrySnapshot => normalizePantrySnapshot({
  pantryItems: state.pantryItems,
  stapleIds: state.stapleIds,
  pantryLots: state.pantryLots,
});

export const usePantryStore = create<PantryState>()(
  persist(
    (set, get) => {
      markHydrated = () => set({ hasHydrated: true });

      return {
        hasHydrated: false,
        pantryItems: [],
        stapleIds: [...DEFAULT_STAPLE_IDS],
        pantryLots: [],
        addIngredients: (items) => {
          const current = normalizeStateSnapshot(get());
          const existingIds = new Set(current.pantryItems.map((item) => item.id));
          const additions = items.filter((item) => !existingIds.has(item.id));
          if (additions.length === 0) return;

          const newLots = additions.map((item) => ({
            ...createPresencePantryLot(item),
            id: createLotId(item.id, current.pantryLots ?? []),
          }));
          const nextLots = [...(current.pantryLots ?? []), ...newLots];
          set({
            pantryItems: derivePantryItems(nextLots),
            pantryLots: nextLots,
          });
          for (const lot of newLots) {
            void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'pantry_lot', lot.id, 'upsert', lot).catch(() => undefined);
          }
        },
        addPantryLot: (input) => {
          const errors = validatePantryLotDetails(input.quantity, input.unit, input.expiresAt);
          if (errors.length > 0) return null;

          const current = normalizeStateSnapshot(get());
          const now = new Date().toISOString();
          const lot: PantryLot = {
            ...input,
            id: createLotId(input.ingredientId, current.pantryLots ?? []),
            createdAt: now,
            updatedAt: now,
          };
          const nextLots = [...(current.pantryLots ?? []), lot];
          set({ pantryItems: derivePantryItems(nextLots), pantryLots: nextLots });
          void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'pantry_lot', lot.id, 'upsert', lot).catch(() => undefined);
          return lot.id;
        },
        updatePantryLot: (id, details) => {
          const current = normalizeStateSnapshot(get());
          const existing = current.pantryLots?.find((lot) => lot.id === id);
          if (existing === undefined) return false;
          if (validatePantryLotDetails(details.quantity, details.unit, details.expiresAt).length > 0) return false;

          const updated: PantryLot = { ...existing, ...details, updatedAt: new Date().toISOString() };
          const nextLots = (current.pantryLots ?? []).map((lot) => lot.id === id ? updated : lot);
          set({ pantryItems: derivePantryItems(nextLots), pantryLots: nextLots });
          void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'pantry_lot', updated.id, 'upsert', updated).catch(() => undefined);
          return true;
        },
        removePantryLot: (id) => {
          const current = normalizeStateSnapshot(get());
          if (!current.pantryLots?.some((lot) => lot.id === id)) return;
          const nextLots = (current.pantryLots ?? []).filter((lot) => lot.id !== id);
          set({ pantryItems: derivePantryItems(nextLots), pantryLots: nextLots });
          void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'pantry_lot', id, 'delete', null).catch(() => undefined);
        },
        getLotsForIngredient: (ingredientId) => normalizeStateSnapshot(get()).pantryLots?.filter((lot) => lot.ingredientId === ingredientId) ?? [],
        getPantryQuantitySummary: () => aggregatePantryLots(normalizeStateSnapshot(get()).pantryLots ?? []),
        removeIngredient: (id) => {
          const current = normalizeStateSnapshot(get());
          const removedLots = (current.pantryLots ?? []).filter((lot) => lot.ingredientId === id);
          if (removedLots.length === 0) return;
          const nextLots = (current.pantryLots ?? []).filter((lot) => lot.ingredientId !== id);
          set({ pantryItems: derivePantryItems(nextLots), pantryLots: nextLots });
          for (const lot of removedLots) {
            void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'pantry_lot', lot.id, 'delete', null).catch(() => undefined);
          }
        },
        toggleStaple: (id) => {
          const enabled = !get().stapleIds.includes(id);
          set((state) => ({
            stapleIds: enabled
              ? [...state.stapleIds, id]
              : state.stapleIds.filter((item) => item !== id),
          }));
          void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'staple_preference', id, 'upsert', { enabled }).catch(() => undefined);
        },
        resetPantry: () => {
          const current = normalizeStateSnapshot(get());
          const defaultStapleIds = new Set<string>(DEFAULT_STAPLE_IDS);
          const changedStaples = new Set<string>([...current.stapleIds, ...DEFAULT_STAPLE_IDS]);

          set({
            pantryItems: [],
            stapleIds: [...DEFAULT_STAPLE_IDS],
            pantryLots: [],
          });
          for (const lot of current.pantryLots ?? []) {
            void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'pantry_lot', lot.id, 'delete', null).catch(() => undefined);
          }
          for (const stapleId of changedStaples) {
            const enabled = defaultStapleIds.has(stapleId);
            if (current.stapleIds.includes(stapleId) !== enabled) {
              void enqueuePantryMutation(GUEST_SYNC_SCOPE, 'staple_preference', stapleId, 'upsert', { enabled }).catch(() => undefined);
            }
          }
        },
        getAvailableIngredientIds: () => [
          ...normalizeStateSnapshot(get()).pantryItems.filter((item) => item.known).map((item) => item.id),
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
        const current = usePantryStore.getState();
        const normalized = normalizeStateSnapshot(current);
        usePantryStore.setState({ pantryItems: normalized.pantryItems, pantryLots: normalized.pantryLots ?? [] });
        markHydrated?.();
      },
    },
  ),
);

applyRemoteSnapshot = (snapshot) => {
  const normalized = normalizePantrySnapshot(snapshot);
  usePantryStore.setState({
    pantryItems: normalized.pantryItems,
    stapleIds: normalized.stapleIds,
    pantryLots: normalized.pantryLots ?? [],
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
        const current = usePantryStore.getState();
        const normalized = normalizeStateSnapshot(current);
        usePantryStore.setState({ pantryItems: normalized.pantryItems, pantryLots: normalized.pantryLots ?? [] });
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
