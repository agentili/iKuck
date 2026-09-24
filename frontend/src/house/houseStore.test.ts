import { describe, expect, it, vi } from 'vitest';
import type { HouseState } from '@ikuck/shared/contracts';
import type { ApiRequest, ApiRequestOptions } from '../api/apiClient';
import { createHouseStore } from './houseStore';

const state: HouseState = {
  house: { id: 'house-1', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
  membership: { role: 'admin', joinedAt: '2026-09-24T00:00:00.000Z' },
  members: [],
};

describe('house store', () => {
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
