import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPantryCandidatesApi, type PantryCandidate } from './pantryCandidatesApi';

const baseCandidate: PantryCandidate = {
  id: 'c-1',
  label: 'Latte',
  rawLabel: 'Latte',
  normalizedLabel: 'latte',
  specification: '1 l',
  listName: 'Spesa',
  checkedOffAt: '2026-01-15T10:00:00.000Z',
  detectedAt: '2026-01-15T10:00:00.000Z',
  expiresAt: '2026-02-14T10:00:00.000Z',
  status: 'pending',
};

const json = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
);

describe('pantryCandidatesApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches candidates same-origin with csrf token and credentials', async () => {
    fetchMock.mockResolvedValue(json({ candidates: [baseCandidate] }));
    const api = createPantryCandidatesApi();
    const result = await api.fetchCandidates('csrf-1');

    expect(result.candidates).toEqual([baseCandidate]);
    expect(fetchMock).toHaveBeenCalledWith('/v1/pantry/candidates', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }),
      credentials: 'include',
    }));
  });

  it('accepts a batch of candidates with csrf token', async () => {
    fetchMock.mockResolvedValue(json({ results: [{ id: 'c-1', ok: true, code: 'accepted' }] }));
    const api = createPantryCandidatesApi();
    const result = await api.acceptCandidates(['c-1'], 'csrf-1');

    expect(result.results).toEqual([{ id: 'c-1', ok: true, code: 'accepted' }]);
    expect(fetchMock).toHaveBeenCalledWith('/v1/pantry/candidates/accept', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-csrf-token': 'csrf-1',
      }),
      body: JSON.stringify({ ids: ['c-1'] }),
      credentials: 'include',
    }));
  });

  it('ignores a batch of candidates with csrf token', async () => {
    fetchMock.mockResolvedValue(json({ results: [{ id: 'c-1', ok: true, code: 'ignored' }] }));
    const api = createPantryCandidatesApi();
    await api.ignoreCandidates(['c-1', 'c-2'], 'csrf-1');

    expect(fetchMock).toHaveBeenCalledWith('/v1/pantry/candidates/ignore', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ids: ['c-1', 'c-2'] }),
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }),
    }));
  });

  it('throws ApiClientError carrying the server reason code on failure', async () => {
    fetchMock.mockResolvedValue(json({ code: 'not_found' }, 404));
    const api = createPantryCandidatesApi();
    await expect(api.fetchCandidates('csrf-1')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      name: 'ApiClientError',
    });
  });

  it('throws network_error when the request cannot complete', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));
    const api = createPantryCandidatesApi();
    await expect(api.fetchCandidates('csrf-1')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });
});
