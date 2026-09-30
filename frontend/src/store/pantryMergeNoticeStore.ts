import { create } from 'zustand';
import type { PantryMergeSummary } from '@ikuck/shared/pantryMerge';

interface PantryMergeNoticeState {
  summary: PantryMergeSummary | null;
  mergeFailed: boolean;
  show: (summary: PantryMergeSummary) => void;
  showFailure: () => void;
  clear: () => void;
}

export const usePantryMergeNoticeStore = create<PantryMergeNoticeState>((set) => ({
  summary: null,
  mergeFailed: false,
  show: (summary) => set({ summary, mergeFailed: false }),
  showFailure: () => set({ summary: null, mergeFailed: true }),
  clear: () => set({ summary: null, mergeFailed: false }),
}));
