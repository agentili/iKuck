import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import { aggregatePantryLots, validatePantryLotDetails, type PantryQuantityAggregate } from '../domain/pantryLots';
import type { ParsedIngredient } from '../domain/types';
import type { PantryLot, PantryLotPayload } from '@ikuck/shared/contracts';
import {
  getMutationScope,
  enqueuePantryMutation,
  registerPantrySnapshotListener,
} from '../sync/syncQueue';
import {
  PANTRY_STORAGE_KEY,
  pantryStorage,
  createPresencePantryLot,
  derivePantryItems,
  normalizePantrySnapshot,
  setPantryPersistenceSuspended,
  writePantrySnapshot,
} from '../storage/pantryStorage';
import type { PantrySnapshot } from '../storage/pantryStorage';
import { trackPersistence, trackSync } from './persistenceStatusStore';
import { getActiveDataScope, getPersonalDataScope, subscribeActiveDataScope } from '../sync/scopeContext';

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
  restorePantryLot: (lot: PantryLot) => boolean;
  getLotsForIngredient: (ingredientId: string) => PantryLot[];
  getPantryQuantitySummary: () => PantryQuantityAggregate[];
  removeIngredient: (id: string) => void;
  toggleStaple: (id: string) => void;
  resetPantry: () => void;
  getAvailableIngredientIds: () => string[];
}

let markHydrated: (() => void) | null = null;
let hydrationPromise: Promise<void> | null = null;
let hydrationGeneration = 0;
let hydrationScopeInFlight: ReturnType<typeof getActiveDataScope> | null = null;
let hydrationGenerationInFlight = 0;
let hydratedScope: ReturnType<typeof getActiveDataScope> | null = null;
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

const persistSnapshot = (snapshot: PantrySnapshot): void => {
  const scope = getActiveDataScope();
  void trackPersistence('pantry', () => writePantrySnapshot(snapshot, scope));
};

const queuePantryMutation = (
  entityType: Parameters<typeof enqueuePantryMutation>[1],
  entityId: string,
  operation: Parameters<typeof enqueuePantryMutation>[3],
  payload: Parameters<typeof enqueuePantryMutation>[4],
): void => {
  const activeScope = getActiveDataScope();
  const personalScope = getPersonalDataScope();
  void trackSync('pantry', () => enqueuePantryMutation(getMutationScope(entityType, activeScope, personalScope), entityType, entityId, operation, payload));
};

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
          persistSnapshot(normalizeStateSnapshot(get()));
          for (const lot of newLots) {
            queuePantryMutation('pantry_lot', lot.id, 'upsert', lot);
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
          persistSnapshot(normalizeStateSnapshot(get()));
          queuePantryMutation('pantry_lot', lot.id, 'upsert', lot);
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
          persistSnapshot(normalizeStateSnapshot(get()));
          queuePantryMutation('pantry_lot', updated.id, 'upsert', updated);
          return true;
        },
        removePantryLot: (id) => {
          const current = normalizeStateSnapshot(get());
          if (!current.pantryLots?.some((lot) => lot.id === id)) return;
          const nextLots = (current.pantryLots ?? []).filter((lot) => lot.id !== id);
          set({ pantryItems: derivePantryItems(nextLots), pantryLots: nextLots });
          persistSnapshot(normalizeStateSnapshot(get()));
          queuePantryMutation('pantry_lot', id, 'delete', null);
        },
        restorePantryLot: (lot) => {
          const current = normalizeStateSnapshot(get());
          if (current.pantryLots?.some((existing) => existing.id === lot.id)) return false;
          if (validatePantryLotDetails(lot.quantity, lot.unit, lot.expiresAt).length > 0) return false;
          const nextLots = [...(current.pantryLots ?? []), lot];
          set({ pantryItems: derivePantryItems(nextLots), pantryLots: nextLots });
          persistSnapshot(normalizeStateSnapshot(get()));
          queuePantryMutation('pantry_lot', lot.id, 'upsert', lot);
          return true;
        },
        getLotsForIngredient: (ingredientId) => normalizeStateSnapshot(get()).pantryLots?.filter((lot) => lot.ingredientId === ingredientId) ?? [],
        getPantryQuantitySummary: () => aggregatePantryLots(normalizeStateSnapshot(get()).pantryLots ?? []),
        removeIngredient: (id) => {
          const current = normalizeStateSnapshot(get());
          const removedLots = (current.pantryLots ?? []).filter((lot) => lot.ingredientId === id);
          if (removedLots.length === 0) return;
          const nextLots = (current.pantryLots ?? []).filter((lot) => lot.ingredientId !== id);
          set({ pantryItems: derivePantryItems(nextLots), pantryLots: nextLots });
          persistSnapshot(normalizeStateSnapshot(get()));
          for (const lot of removedLots) {
            queuePantryMutation('pantry_lot', lot.id, 'delete', null);
          }
        },
        toggleStaple: (id) => {
          const enabled = !get().stapleIds.includes(id);
          set((state) => ({
            stapleIds: enabled
              ? [...state.stapleIds, id]
              : state.stapleIds.filter((item) => item !== id),
          }));
          persistSnapshot(normalizeStateSnapshot(get()));
          queuePantryMutation('staple_preference', id, 'upsert', { enabled });
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
          persistSnapshot(normalizeStateSnapshot(get()));
          for (const lot of current.pantryLots ?? []) {
            queuePantryMutation('pantry_lot', lot.id, 'delete', null);
          }
          for (const stapleId of changedStaples) {
            const enabled = defaultStapleIds.has(stapleId);
            if (current.stapleIds.includes(stapleId) !== enabled) {
              queuePantryMutation('staple_preference', stapleId, 'upsert', { enabled });
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
      onRehydrateStorage: () => {
        const callbackScope = hydrationScopeInFlight;
        const callbackGeneration = hydrationGenerationInFlight;
        return () => {
          if (callbackScope === null || callbackScope !== getActiveDataScope() || callbackGeneration !== hydrationGeneration) return;
          const current = usePantryStore.getState();
          const normalized = normalizeStateSnapshot(current);
          usePantryStore.setState({ pantryItems: normalized.pantryItems, pantryLots: normalized.pantryLots ?? [] });
          hydratedScope = callbackScope;
          markHydrated?.();
        };
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

subscribeActiveDataScope(() => {
  hydrationGeneration += 1;
  hydratedScope = null;
  setPantryPersistenceSuspended(true);
  try {
    usePantryStore.setState({
      hasHydrated: false,
      pantryItems: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
      pantryLots: [],
    });
  } finally {
    setPantryPersistenceSuspended(false);
  }
});

export async function hydratePantryStore(): Promise<void> {
  for (;;) {
    const activeScope = getActiveDataScope();
    const activeGeneration = hydrationGeneration;
    if (usePantryStore.getState().hasHydrated && hydratedScope === activeScope) return;

    if (hydrationPromise === null) {
      const hydrationScope = activeScope;
      const hydrationGenerationAtStart = activeGeneration;
      hydrationScopeInFlight = hydrationScope;
      hydrationGenerationInFlight = hydrationGenerationAtStart;
      const currentPromise = Promise.resolve(usePantryStore.persist.rehydrate())
        .catch(() => undefined)
        .then(() => {
          if (getActiveDataScope() !== hydrationScope || hydrationGeneration !== hydrationGenerationAtStart) return;
          const current = usePantryStore.getState();
          const normalized = normalizeStateSnapshot(current);
          usePantryStore.setState({ pantryItems: normalized.pantryItems, pantryLots: normalized.pantryLots ?? [] });
          if (!usePantryStore.getState().hasHydrated) {
            usePantryStore.setState({ hasHydrated: true });
          }
          hydratedScope = hydrationScope;
        })
        .finally(() => {
          hydrationPromise = null;
          hydrationScopeInFlight = null;
        });
      hydrationPromise = currentPromise;
    }

    const pendingHydration = hydrationPromise;
    if (pendingHydration !== null) await pendingHydration;
    if (getActiveDataScope() === activeScope && hydrationGeneration === activeGeneration
      && usePantryStore.getState().hasHydrated && hydratedScope === activeScope) return;
  }
}
