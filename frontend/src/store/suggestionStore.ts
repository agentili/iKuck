import { create } from 'zustand';
import { Suggestion, ApiResponse } from '../types';
import * as api from '../utils/apiClient';

interface SuggestionStore {
  suggestions: Suggestion[];
  mealType: 'breakfast' | 'lunch' | 'dinner';
  isLoading: boolean;
  setMealType: (type: 'breakfast' | 'lunch' | 'dinner') => void;
  fetchSuggestions: (mealType: string) => Promise<void>;
}

export const useSuggestionStore = create<SuggestionStore>((set, get) => ({
  suggestions: [],
  mealType: 'dinner',
  isLoading: false,

  setMealType: (type) => set({ mealType: type }),

  fetchSuggestions: async (mealType) => {
    set({ isLoading: true });
    try {
      const res = await api.get<ApiResponse<{ suggestions: Suggestion[] }>>(
        `/recipes/suggest?mealType=${mealType}`
      );
      if (res.success && res.data) {
        set({ suggestions: res.data.suggestions });
      }
    } catch (err) {
      console.error('Fetch suggestions error', err);
    } finally {
      set({ isLoading: false });
    }
  },
}));
