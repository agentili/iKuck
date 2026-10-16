import { apiRequest, type ApiRequest } from '../api/apiClient';

export interface PantryCandidate {
  id: string;
  label: string;
  rawLabel: string;
  normalizedLabel: string;
  specification: string;
  listName: string;
  checkedOffAt: string | null;
  detectedAt: string;
  expiresAt: string;
  status: 'pending';
}

export interface PantryCandidateActionResult {
  id: string;
  ok: boolean;
  code:
    | 'accepted'
    | 'ignored'
    | 'duplicate_in_pantry'
    | 'already_resolved'
    | 'not_found'
    | 'invalid_candidate';
}

const root = '/v1/pantry/candidates';

export const createPantryCandidatesApi = (request: ApiRequest = apiRequest) => ({
  fetchCandidates: (csrfToken: string) =>
    request<{ candidates: PantryCandidate[] }>(root, { csrfToken }),

  acceptCandidates: (ids: readonly string[], csrfToken: string) =>
    request<{ results: PantryCandidateActionResult[] }>(`${root}/accept`, {
      method: 'POST',
      body: { ids },
      csrfToken,
    }),

  ignoreCandidates: (ids: readonly string[], csrfToken: string) =>
    request<{ results: PantryCandidateActionResult[] }>(`${root}/ignore`, {
      method: 'POST',
      body: { ids },
      csrfToken,
    }),
});

export const pantryCandidatesApi = createPantryCandidatesApi();
