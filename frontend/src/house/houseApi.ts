import type { HouseMember, HouseRole, HouseState, PantryLot } from '@ikuck/shared/contracts';
import type { PantryMergeSummary } from '@ikuck/shared/pantryMerge';
import { apiRequest, type ApiRequest } from '../api/apiClient';

interface AddMemberResponse {
  member: HouseMember;
}

export interface PantryMergeResponse {
  summary: PantryMergeSummary;
}

export const fetchHouseState = (request: ApiRequest = apiRequest): Promise<HouseState | null> => request<HouseState | null>('/v1/house');

export const createHouse = (name: string, csrfToken: string, request: ApiRequest = apiRequest): Promise<HouseState> => request<HouseState>('/v1/house', {
  method: 'POST',
  body: { name },
  csrfToken,
});

export const addHouseMember = (email: string, csrfToken: string, request: ApiRequest = apiRequest): Promise<AddMemberResponse> => request<AddMemberResponse>('/v1/house/members', {
  method: 'POST',
  body: { email },
  csrfToken,
});

export const importPersonalHouseData = (csrfToken: string, request: ApiRequest = apiRequest): Promise<void> => request<void>('/v1/house/import-personal-data', {
  method: 'POST',
  csrfToken,
});

export const mergeGuestPantry = (
  deviceId: string,
  lots: PantryLot[],
  stapleIds: string[],
  csrfToken: string,
  request: ApiRequest = apiRequest,
): Promise<PantryMergeResponse> => request<PantryMergeResponse>('/v1/house/pantry/merge', {
  method: 'POST',
  body: { deviceId, lots, stapleIds },
  csrfToken,
});

export const changeHouseMemberRole = (userId: string, role: HouseRole, csrfToken: string, request: ApiRequest = apiRequest): Promise<void> => request<void>(`/v1/house/members/${encodeURIComponent(userId)}`, {
  method: 'PATCH',
  body: { role },
  csrfToken,
});

export const removeHouseMember = (userId: string, csrfToken: string, request: ApiRequest = apiRequest): Promise<void> => request<void>(`/v1/house/members/${encodeURIComponent(userId)}`, {
  method: 'DELETE',
  csrfToken,
});

export const leaveHouse = (csrfToken: string, request: ApiRequest = apiRequest): Promise<void> => request<void>('/v1/house/leave', {
  method: 'POST',
  csrfToken,
});
