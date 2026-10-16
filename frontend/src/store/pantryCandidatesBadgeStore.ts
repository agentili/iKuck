import { create } from 'zustand';

export interface PantryCandidatesBadgeState {
  houseId: string | null;
  pendingCount: number;
  setHouse: (houseId: string | null) => void;
  setPendingCount: (count: number) => void;
  incrementPendingCount: () => void;
  decrementPendingCount: () => void;
  reset: () => void;
}

export const createPantryCandidatesBadgeStore = () => create<PantryCandidatesBadgeState>((set) => ({
  houseId: null,
  pendingCount: 0,
  setHouse: (houseId) => set((state) => ({
    houseId,
    pendingCount: state.houseId === houseId ? state.pendingCount : 0,
  })),
  setPendingCount: (count) => set({ pendingCount: Math.max(0, count) }),
  incrementPendingCount: () => set((state) => ({ pendingCount: state.pendingCount + 1 })),
  decrementPendingCount: () => set((state) => ({ pendingCount: Math.max(0, state.pendingCount - 1) })),
  reset: () => set({ houseId: null, pendingCount: 0 }),
}));

export const usePantryCandidatesBadgeStore = createPantryCandidatesBadgeStore();
