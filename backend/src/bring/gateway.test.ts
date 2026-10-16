import { describe, expect, it, vi } from 'vitest';
import { BRING_MAX_ITEMS } from '@ikuck/shared/bring';
import { createBringGateway } from './gateway.js';

const session = { userId: '22222222-2222-4222-8222-222222222222', accessToken: 'synthetic-access', userName: 'Test' };

describe('Bring SDK gateway', () => {
  it('stores only the minimal authenticated session', async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      uuid: session.userId,
      name: session.userName,
      access_token: session.accessToken,
      refresh_token: 'synthetic-refresh',
    }));
    const gateway = createBringGateway(fakeFetch);

    await expect(gateway.authenticate(
      { email: 'test@example.com', password: 'synthetic-password' },
      AbortSignal.timeout(1000),
    )).resolves.toEqual(session);
  });

  it.each([401, 403])('maps invalid authentication HTTP %i separately', async (upstreamStatus) => {
    const gateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: 'synthetic-error', message: 'secret upstream text' },
      { status: upstreamStatus },
    )));
    const error = await gateway.authenticate(
      { email: 'test@example.com', password: 'synthetic-password' },
      AbortSignal.timeout(1000),
    ).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: 'bring_invalid_credentials', status: 401, message: 'bring_invalid_credentials' });
    expect(String(error)).not.toContain('secret upstream text');
    expect(error).not.toHaveProperty('cause');
  });

  it('maps list ids without changing the remote identity', async () => {
    const listId = 'list-id-as-issued-by-bring';
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      lists: [{ listUuid: listId, name: 'Casa', theme: 'green' }],
    }));
    const gateway = createBringGateway(fakeFetch);

    await expect(gateway.lists(session, AbortSignal.timeout(1000))).resolves.toEqual([
      { id: listId, name: 'Casa' },
    ]);
  });

  it('preserves raw remote item names and specifications', async () => {
    const raw = {
      uuid: 'list-a',
      status: 'REGISTERED',
      purchase: [{ name: 'Sale & pepe + limone', specification: '2 & 3 + bio' }],
      recently: [],
    };
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(raw));
    const gateway = createBringGateway(fakeFetch);
    const signal = AbortSignal.timeout(1000);

    await expect(gateway.items(session, 'list-a', signal)).resolves.toEqual(raw);
    expect(fakeFetch.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it('preserves the upstream check-off timestamp on recently items when available', async () => {
    const checkedOffAt = '2026-10-15T09:00:00.000Z';
    const raw = {
      uuid: 'list-a',
      status: 'REGISTERED',
      purchase: [],
      recently: [{ name: 'Milch', specification: '1 l', updatedAt: checkedOffAt }],
    };
    const gateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(raw)));

    await expect(gateway.items(session, 'list-a', AbortSignal.timeout(1000))).resolves.toEqual(raw);
  });

  it('maps all five actions to the real SDK operations', async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const gateway = createBringGateway(fakeFetch);
    const signal = AbortSignal.timeout(1000);
    const common = { listId: 'remote-list', name: 'Sale & pepe + limone', specification: '2 & 3 + bio' };

    for (const action of ['add', 'update', 'complete', 'restore', 'remove'] as const) {
      await gateway.change(session, { ...common, action }, signal);
    }

    const forms = fakeFetch.mock.calls.map((call) => call[1]?.body as URLSearchParams);
    expect(forms).toHaveLength(5);
    expect(forms.map((form) => [form.get('purchase'), form.get('recently'), form.get('remove')])).toEqual([
      ['Sale & pepe + limone', '', ''],
      ['Sale & pepe + limone', '', ''],
      ['', 'Sale & pepe + limone', ''],
      ['Sale & pepe + limone', '', ''],
      ['', '', 'Sale & pepe + limone'],
    ]);
    expect(forms.map((form) => form.get('specification'))).toEqual([
      '2 & 3 + bio',
      '2 & 3 + bio',
      '',
      '2 & 3 + bio',
      '',
    ]);
    expect(fakeFetch.mock.calls.map((call) => call[1]?.signal)).toEqual(Array(5).fill(signal));
  });

  it('flattens catalog sections without changing catalog identities', async () => {
    const catalog = {
      language: 'it-IT',
      catalog: { sections: [{
        sectionId: 'produce',
        name: 'Verdura',
        items: [{ itemId: 'item:with-punctuation+', name: 'Pomodoro' }],
      }] },
    };
    const gateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog)));

    await expect(gateway.catalog(AbortSignal.timeout(1000))).resolves.toEqual([
      { itemId: 'item:with-punctuation+', name: 'Pomodoro' },
    ]);
  });

  it.each([
    [401, 'bring_reconnect_required', 409],
    [403, 'bring_list_not_found', 404],
    [500, 'bring_unavailable', 503],
  ] as const)('maps operation HTTP %i to a neutral application error', async (upstreamStatus, code, status) => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: 'synthetic-error', message: 'secret upstream text' },
      { status: upstreamStatus },
    ));
    const gateway = createBringGateway(fakeFetch);
    const error = await gateway.lists(session, AbortSignal.timeout(1000)).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code, status, message: code });
    expect(String(error)).not.toContain('secret upstream text');
    expect(error).not.toHaveProperty('cause');
  });

  it('rejects oversized upstream list and item snapshots', async () => {
    const tooManyLists = {
      lists: Array.from({ length: 1001 }, (_, index) => ({ listUuid: `list-${index}`, name: 'Casa', theme: 'green' })),
    };
    const listGateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(tooManyLists)));
    await expect(listGateway.lists(session, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'bring_unavailable', status: 503,
    });

    const tooManyItems = {
      uuid: 'list-a',
      status: 'REGISTERED',
      purchase: Array.from({ length: BRING_MAX_ITEMS + 1 }, () => ({ name: 'Latte', specification: '' })),
      recently: [],
    };
    const itemGateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(tooManyItems)));
    await expect(itemGateway.items(session, 'list-a', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'bring_unavailable', status: 503,
    });
  });

  it('bounds metadata strings in lists, items, and the catalog', async () => {
    const oversizedList = {
      lists: [{ listUuid: 'list-a', name: 'Casa', theme: 't'.repeat(129) }],
    };
    const listGateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(oversizedList)));
    await expect(listGateway.lists(session, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'bring_unavailable', status: 503,
    });

    const oversizedItems = {
      uuid: 'u'.repeat(129),
      status: 'REGISTERED',
      purchase: [],
      recently: [],
    };
    const itemGateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(oversizedItems)));
    await expect(itemGateway.items(session, 'list-a', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'bring_unavailable', status: 503,
    });

    const oversizedCatalog = {
      language: 'l'.repeat(129),
      catalog: { sections: [] },
    };
    const catalogGateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(oversizedCatalog)));
    await expect(catalogGateway.catalog(AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'bring_unavailable', status: 503,
    });
  });

  it('hides network and malformed response causes', async () => {
    const networkGateway = createBringGateway(vi.fn<typeof fetch>().mockRejectedValue(new Error('secret network cause')));
    const networkError = await networkGateway.lists(session, AbortSignal.timeout(1000))
      .catch((failure: unknown) => failure);
    const malformedGateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ lists: 'not-an-array' })));
    const malformedError = await malformedGateway.lists(session, AbortSignal.timeout(1000))
      .catch((failure: unknown) => failure);

    for (const error of [networkError, malformedError]) {
      expect(error).toMatchObject({ code: 'bring_unavailable', status: 503, message: 'bring_unavailable' });
      expect(String(error)).not.toContain('secret');
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('rejects catalog snapshots over the total item bound', async () => {
    const itemsPerSection = Math.floor(BRING_MAX_ITEMS / 2) + 1;
    const catalog = {
      language: 'it-IT',
      catalog: { sections: Array.from({ length: 2 }, (_, sectionIndex) => ({
        sectionId: `section-${sectionIndex}`,
        name: 'Prodotti',
        items: Array.from({ length: itemsPerSection }, (_, itemIndex) => ({
          itemId: `item-${sectionIndex}-${itemIndex}`,
          name: 'Latte',
        })),
      })) },
    };
    const gateway = createBringGateway(vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog)));
    const error = await gateway.catalog(AbortSignal.timeout(1000))
      .then(() => undefined, (failure: unknown) => failure);

    expect(error).toMatchObject({ code: 'bring_unavailable', status: 503 });
  });
});
