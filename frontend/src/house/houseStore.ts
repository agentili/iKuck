import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { HouseRole, HouseState } from '@ikuck/shared/contracts';
import type { ApiRequest } from '../api/apiClient';
import {
  addHouseMember,
  changeHouseMemberRole,
  createHouse,
  fetchHouseState,
  importPersonalHouseData,
  leaveHouse,
  removeHouseMember,
} from './houseApi';

export interface HouseStoreState {
  state: HouseState | null;
  isLoading: boolean;
  error: unknown | null;
  refresh: () => Promise<HouseState | null>;
  create: (name: string, csrfToken: string) => Promise<HouseState>;
  addMember: (email: string, csrfToken: string) => Promise<void>;
  importPersonalData: (csrfToken: string) => Promise<void>;
  changeRole: (userId: string, role: HouseRole, csrfToken: string) => Promise<void>;
  removeMember: (userId: string, csrfToken: string) => Promise<void>;
  leave: (csrfToken: string) => Promise<void>;
  clear: () => void;
}

export interface HouseStoreOptions {
  request?: ApiRequest;
}

export type HouseStore = UseBoundStore<StoreApi<HouseStoreState>>;

export const createHouseStore = ({ request }: HouseStoreOptions = {}): HouseStore => create<HouseStoreState>((set) => {
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    set({ isLoading: true, error: null });
    try {
      const result = await operation();
      set({ isLoading: false });
      return result;
    } catch (error) {
      set({ isLoading: false, error });
      throw error;
    }
  };

  const refresh = async (): Promise<HouseState | null> => run(async () => {
    const next = await fetchHouseState(request);
    set({ state: next });
    return next;
  });

  return {
    state: null,
    isLoading: false,
    error: null,
    refresh,
    create: (name, csrfToken) => run(async () => {
      const next = await createHouse(name, csrfToken, request);
      set({ state: next });
      return next;
    }),
    addMember: (email, csrfToken) => run(async () => {
      await addHouseMember(email, csrfToken, request);
      await refresh();
    }),
    importPersonalData: (csrfToken) => run(async () => {
      await importPersonalHouseData(csrfToken, request);
      await refresh();
    }),
    changeRole: (userId, role, csrfToken) => run(async () => {
      await changeHouseMemberRole(userId, role, csrfToken, request);
      await refresh();
    }),
    removeMember: (userId, csrfToken) => run(async () => {
      await removeHouseMember(userId, csrfToken, request);
      await refresh();
    }),
    leave: (csrfToken) => run(async () => {
      await leaveHouse(csrfToken, request);
      set({ state: null });
    }),
    clear: () => set({ state: null, error: null }),
  };
});

export const useHouseStore = createHouseStore();
