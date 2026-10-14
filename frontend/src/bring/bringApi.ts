import { apiRequest, type ApiRequest } from '../api/apiClient';
import type { BringConnected, BringCredentials, BringImportResult, BringList, BringMutation, BringSnapshot, BringStatus } from '@ikuck/shared/bring';

const root = '/v1/integrations/bring';

export const createBringApi = (request: ApiRequest = apiRequest) => ({
  status: (signal?: AbortSignal) => request<BringStatus>(root, { signal }),
  connect: (body: BringCredentials, csrfToken: string, signal?: AbortSignal) => request<BringConnected>(`${root}/connection`, { method: 'POST', body, csrfToken, signal }),
  disconnect: (connectionId: string, csrfToken: string, signal?: AbortSignal) => request<void>(`${root}/connection`, { method: 'DELETE', body: { connectionId }, csrfToken, signal }),
  lists: (connectionId: string, signal?: AbortSignal) => request<{ connectionId: string; lists: BringList[] }>(`${root}/lists?${new URLSearchParams({ connectionId })}`, { signal }),
  items: (connectionId: string, listId: string, signal?: AbortSignal) => request<BringSnapshot>(`${root}/items?${new URLSearchParams({ connectionId, listId })}`, { signal }),
  write: (body: BringMutation, csrfToken: string, signal?: AbortSignal) => request<BringSnapshot>(`${root}/items`, { method: 'POST', body, csrfToken, signal }),
  importList: (body: { connectionId: string; listId: string }, csrfToken: string, signal?: AbortSignal) => request<BringImportResult>(`${root}/import`, { method: 'POST', body, csrfToken, signal }),
});
