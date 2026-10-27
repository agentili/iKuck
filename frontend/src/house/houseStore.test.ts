import { describe, expect, it, vi } from 'vitest';
import type { HouseState } from '@ikuck/shared/contracts';
import type { ApiRequest, ApiRequestOptions } from '../api/apiClient';
import { createHouseStore } from './houseStore';
import { useAuthStore } from '../auth/authStore';

const state: HouseState = {
  house: { id: 'house-1', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
  membership: { role: 'admin', joinedAt: '2026-09-24T00:00:00.000Z' },
  members: [],
};

describe('house store', () => {
  it.each([false, true])('ignores an old account refresh while a new refresh is loading (failure: %s)', async (fails) => {
    let finishOld!: (value: HouseState) => void;
    let failOld!: (error: unknown) => void;
    let finishCurrent!: (value: HouseState) => void;
    const oldResponse = new Promise<HouseState>((resolve, reject) => { finishOld = resolve; failOld = reject; });
    const currentResponse = new Promise<HouseState>((resolve) => { finishCurrent = resolve; });
    const request = vi.fn().mockReturnValueOnce(oldResponse).mockReturnValueOnce(currentResponse);
    const store = createHouseStore({ request: request as ApiRequest });
    useAuthStore.setState({ user: { id: 'a', email: 'a@example.com', emailVerifiedAt: '2026-10-26' }, csrfToken: 'csrf-a' });
    const oldRefresh = store.getState().refresh();
    useAuthStore.setState({ user: { id: 'b', email: 'b@example.com', emailVerifiedAt: '2026-10-26' }, csrfToken: 'csrf-b' });
    store.getState().clear();
    expect(store.getState().isLoading).toBe(false);
    const currentRefresh = store.getState().refresh();
    if (fails) failOld(new Error('previous account offline'));
    else finishOld(state);
    await expect(oldRefresh).resolves.toBeNull();
    expect(store.getState()).toMatchObject({ state: null, error: null, isLoading: true });
    const currentState = { ...state, house: { ...state.house!, id: 'house-b', name: 'Casa B' } };
    finishCurrent(currentState);
    await expect(currentRefresh).resolves.toEqual(currentState);
    expect(store.getState()).toMatchObject({ state: currentState, error: null, isLoading: false });
  });
  it('refreshes and delegates membership mutations while preserving api errors', async () => {
    const request = vi.fn(async <T>(...args: [string, ApiRequestOptions?]): Promise<T> => {
      void args;
      return state as T;
    });
    const store = createHouseStore({ request: request as unknown as ApiRequest });

    await store.getState().refresh();
    await store.getState().create('Casa', 'csrf');
    await store.getState().addMember('member@example.com', 'csrf');
    await store.getState().changeRole('member-1', 'member', 'csrf');
    await store.getState().removeMember('member-1', 'csrf');
    await store.getState().importPersonalData('csrf');
    expect(store.getState().state).toEqual(state);
    await store.getState().leave('csrf');

    expect(store.getState().state).toBeNull();
    expect(request).toHaveBeenCalledWith('/v1/house');
    expect(request).toHaveBeenCalledWith('/v1/house/members', expect.objectContaining({ csrfToken: 'csrf' }));
  });

  it('stores a failed refresh without replacing the last known state', async () => {
    const request = vi.fn(async <T>(): Promise<T> => { throw new Error('offline'); });
    const store = createHouseStore({ request: request as unknown as ApiRequest });

    await expect(store.getState().refresh()).rejects.toThrow('offline');
    expect(store.getState().error).toEqual(expect.objectContaining({ message: 'offline' }));
  });
});
