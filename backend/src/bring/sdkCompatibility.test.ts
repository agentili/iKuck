import { describe, expect, it, vi } from 'vitest';
import { authenticate, createBringClient, isBringApiError } from '@micsob/bring-api-client';

const listId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const session = { userId, accessToken: 'synthetic-access', userName: 'Test' };

describe('published Bring SDK compatibility', () => {
  it('authenticates once and resumes a stored session without credentials', async () => {
    const fakeFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ uuid: userId, name: 'Test', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }))
      .mockResolvedValueOnce(Response.json({ lists: [{ listUuid: listId, name: 'Prova', theme: 'default' }] }));
    const received = await authenticate({ email: 'test@example.com', password: 'synthetic-password' }, { fetch: fakeFetch });
    expect(received).toMatchObject(session);
    const client = createBringClient({ session: received, fetch: fakeFetch });
    expect((await client.lists.getAll()).lists[0]?.listUuid).toBe(listId);
    const body = fakeFetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get('email')).toBe('test@example.com');
    expect(body.get('password')).toBe('synthetic-password');
    expect(String(fakeFetch.mock.calls[1]?.[0])).toContain(`bringusers/${userId}/lists`);
    expect(new Headers(fakeFetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer synthetic-access');
  });

  it('encodes additions, completion and removal through its own form builder', async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    const client = createBringClient({ session, fetch: fakeFetch });
    await client.lists.saveItem({ listId, name: 'Sale & pepe + limone', specification: '2 & 3 + bio' });
    await client.lists.moveItemToRecent({ listId, name: 'Sale & pepe + limone' });
    await client.lists.removeItem({ listId, name: 'Sale & pepe + limone' });
    const forms = fakeFetch.mock.calls.map((call) => call[1]?.body as URLSearchParams);
    expect(forms[0]?.get('purchase')).toBe('Sale & pepe + limone');
    expect(forms[0]?.get('specification')).toBe('2 & 3 + bio');
    expect(forms[1]?.get('recently')).toBe('Sale & pepe + limone');
    expect(forms[2]?.get('remove')).toBe('Sale & pepe + limone');
  });

  it('forwards an AbortSignal through the client to its injected fetch', async () => {
    const controller = new AbortController();
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      uuid: listId,
      status: 'ok',
      purchase: [],
      recently: []
    }));
    const client = createBringClient({ session, fetch: fakeFetch });

    await client.lists.getItems({ listId }, { signal: controller.signal });

    expect(fakeFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it.each([401, 500])('rejects HTTP %i instead of reporting a successful write', async (status) => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'synthetic_error', message: 'Synthetic upstream failure' }, { status }));
    const client = createBringClient({ session, fetch: fakeFetch });
    let failure: unknown;
    try { await client.lists.saveItem({ listId, name: 'Latte' }); } catch (error) { failure = error; }
    expect(isBringApiError(failure)).toBe(true);
    expect(failure).toMatchObject({ status });
  });
});
