import { create } from 'zustand';
import { PantryItem, ApiResponse } from '../types';
import * as api from '../utils/apiClient';
import { db } from '../db/database';

interface PantryStore {
  items: PantryItem[];
  isLoading: boolean;
  fetchPantry: () => Promise<void>;
  addItem: (item: Partial<PantryItem>) => Promise<void>;
  updateItem: (id: string, data: Partial<PantryItem>) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  loadFromCache: () => Promise<void>;
}

export const usePantryStore = create<PantryStore>((set, get) => ({
  items: [],
  isLoading: false,

  fetchPantry: async () => {
    set({ isLoading: true });
    try {
      const res = await api.get<ApiResponse<PantryItem[]>>('/pantry');
      if (res.success && res.data) {
        set({ items: res.data });
        // Sync to IndexedDB
        await db.pantryItems.clear();
        await db.pantryItems.bulkAdd(res.data);
      }
    } catch (err) {
      console.error('Fetch pantry error', err);
      await get().loadFromCache();
    } finally {
      set({ isLoading: false });
    }
  },

  addItem: async (item) => {
    // Optimistic update
    const tempId = Math.random().toString(36).substring(7);
    const newItem = { ...item, id: tempId } as PantryItem;
    set({ items: [newItem, ...get().items] });

    try {
      const res = await api.post<ApiResponse<PantryItem>>('/pantry/items', item);
      if (res.success && res.data) {
        set({
          items: get().items.map((i) => (i.id === tempId ? res.data! : i)),
        });
        await db.pantryItems.add(res.data);
      }
    } catch (err) {
      console.error('Add item error', err);
      set({ items: get().items.filter((i) => i.id !== tempId) });
    }
  },

  updateItem: async (id, data) => {
    const oldItems = get().items;
    set({
      items: oldItems.map((i) => (i.id === id ? { ...i, ...data } : i)),
    });

    try {
      const res = await api.put<ApiResponse<PantryItem>>(`/pantry/items/${id}`, data);
      if (res.success && res.data) {
        await db.pantryItems.where('id').equals(id).modify(data);
      }
    } catch (err) {
      console.error('Update item error', err);
      set({ items: oldItems });
    }
  },

  deleteItem: async (id) => {
    const oldItems = get().items;
    set({ items: oldItems.filter((i) => i.id !== id) });

    try {
      await api.del(`/pantry/items/${id}`);
      await db.pantryItems.where('id').equals(id).delete();
    } catch (err) {
      console.error('Delete item error', err);
      set({ items: oldItems });
    }
  },

  loadFromCache: async () => {
    const cachedItems = await db.pantryItems.toArray();
    set({ items: cachedItems });
  },
}));
