import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiRequest } from './apiClient';

describe('api client', () => {
  it('uses same-origin credentials and JSON for a request body', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiRequest('/v1/profile', {
      method: 'PATCH',
      body: { displayName: 'Ale' },
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith('/v1/profile', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
      body: JSON.stringify({ displayName: 'Ale' }),
    }));
  });

  it('adds the CSRF header only when a token is supplied', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await apiRequest('/v1/profile', {
      method: 'PATCH',
      body: {},
      csrfToken: 'csrf-1',
      fetch,
    });

    expect(fetch.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }),
    });
  });

  it('returns structured API errors without leaking the request body', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'csrf_failed', message: 'CSRF token is invalid' }),
      { status: 403 },
    ));

    const error = await apiRequest('/v1/profile', {
      method: 'PATCH',
      body: { password: 'do-not-repeat-this' },
      fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      status: 403,
      code: 'csrf_failed',
    });
  });

  it('maps a failed fetch to a stable network error', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiRequest('/v1/auth/session', { fetch })).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });
});
