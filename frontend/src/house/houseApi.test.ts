import { describe, expect, it, vi } from 'vitest';
import type { HouseState } from '@ikuck/shared/contracts';
import type { ApiRequest, ApiRequestOptions } from '../api/apiClient';
import { addHouseMember, changeHouseMemberRole, createHouse, fetchHouseState, importPersonalHouseData, leaveHouse, removeHouseMember } from './houseApi';

const state: HouseState = { house: null, membership: null, members: [] };

describe('house api', () => {
  it('uses typed same-origin endpoints and passes csrf to every mutation', async () => {
    const request = vi.fn(async <T>(...args: [string, ApiRequestOptions?]): Promise<T> => {
      void args;
      return state as T;
    });
    await fetchHouseState(request as unknown as ApiRequest);
    await createHouse('Casa', 'csrf', request as unknown as ApiRequest);
    await addHouseMember('member@example.com', 'csrf', request as unknown as ApiRequest);
    await importPersonalHouseData('csrf', request as unknown as ApiRequest);
    await changeHouseMemberRole('user/1', 'admin', 'csrf', request as unknown as ApiRequest);
    await removeHouseMember('user/1', 'csrf', request as unknown as ApiRequest);
    await leaveHouse('csrf', request as unknown as ApiRequest);

    expect(request).toHaveBeenNthCalledWith(1, '/v1/house');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/house', { method: 'POST', body: { name: 'Casa' }, csrfToken: 'csrf' });
    expect(request).toHaveBeenNthCalledWith(3, '/v1/house/members', { method: 'POST', body: { email: 'member@example.com' }, csrfToken: 'csrf' });
    expect(request).toHaveBeenNthCalledWith(4, '/v1/house/import-personal-data', { method: 'POST', csrfToken: 'csrf' });
    expect(request).toHaveBeenNthCalledWith(5, '/v1/house/members/user%2F1', { method: 'PATCH', body: { role: 'admin' }, csrfToken: 'csrf' });
    expect(request).toHaveBeenNthCalledWith(6, '/v1/house/members/user%2F1', { method: 'DELETE', csrfToken: 'csrf' });
    expect(request).toHaveBeenNthCalledWith(7, '/v1/house/leave', { method: 'POST', csrfToken: 'csrf' });
  });
});
