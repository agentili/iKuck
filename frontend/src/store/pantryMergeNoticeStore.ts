import { create } from 'zustand';
import type { PantryMergeSummary } from '@ikuck/shared/pantryMerge';

interface PantryMergeNoticeState {
  summary: PantryMergeSummary | null;
  show: (summary: PantryMergeSummary) => void;
  clear: () => void;
}

export const usePantryMergeNoticeStore = create<PantryMergeNoticeState>((set) => ({
  summary: null,
  show: (summary) => set({ summary }),
  clear: () => set({ summary: null }),
}));
