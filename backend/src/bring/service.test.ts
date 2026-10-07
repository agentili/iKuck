import { describe, expect, it, vi } from 'vitest';
import { BRING_NAME_MAX_LENGTH, BRING_SPEC_MAX_LENGTH } from '@ikuck/shared/bring';
import { createBringService } from './service.js';
import { createMemoryBringRepository } from './repository.js';
import { createSessionCipher } from './sessionCipher.js';
import type { BringGateway, RawItems } from './gateway.js';
import type { BringRepository } from './repository.js';

const listId = '11111111-1111-4111-8111-111111111111';
const session = { userId: 'bring-user', accessToken: 'synthetic-access' };

const fixture = () => {
  let raw: RawItems = { uuid: listId, status: 'REGISTERED', purchase: [], recently: [] };
  const gateway: BringGateway = {
    authenticate: vi.fn(async () => session),
    lists: vi.fn(async () => [{ id: listId, name: 'Lista Prova' }]),
    items: vi.fn(async () => structuredClone(raw)),
    catalog: vi.fn(async () => [{ itemId: 'Milch', name: 'Latte' }]),
    change: vi.fn(async () => undefined),
  };
  const repository = createMemoryBringRepository();
  const cipher = createSessionCipher('11'.repeat(32));
  const service = createBringService({ repository, gateway, cipher });
  return { service, gateway, repository, cipher, setRaw: (next: RawItems) => { raw = next; } };
};

describe('Bring service', () => {
  it('connects and persists only the encrypted session', async () => {
    const { service, gateway, repository, cipher } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    expect(connected).toMatchObject({
      enabled: true,
      connected: true,
      lists: [{ id: listId, name: 'Lista Prova' }],
    });
    expect(connected.connectionId!).toMatch(/^[0-9a-f-]{36}$/i);
    const row = await repository.withUser('owner-a', (unit) => unit.get());
    expect(row?.connectionId).toBe(connected.connectionId!);
    expect(row?.encryptedSession).not.toContain('synthetic-password');
    expect(cipher.open('owner-a', row!.encryptedSession)).toBe(JSON.stringify(session));
    expect(await service.status('owner-a')).toEqual({
      enabled: true,
      connected: true,
      connectionId: connected.connectionId!,
    });
    expect(gateway.authenticate).toHaveBeenCalledTimes(1);
  });

  it('rejects a gateway session with credential fields before persisting it', async () => {
    const { service, gateway, repository } = fixture();
    vi.mocked(gateway.authenticate).mockResolvedValueOnce({
      ...session,
      password: 'synthetic-password',
    } as never);

    await expect(service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    })).rejects.toMatchObject({ code: 'bring_unavailable', status: 503 });
    await expect(repository.withUser('owner-a', (unit) => unit.get())).resolves.toBeNull();
    expect(gateway.lists).not.toHaveBeenCalled();
  });

  it('does not dispatch another upstream request after the operation signal expires', async () => {
    const { service, gateway } = fixture();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.mocked(gateway.authenticate).mockImplementationOnce(async () => {
      controller.abort();
      return session;
    });

    try {
      await expect(service.connect('owner-a', {
        email: 'test@example.com',
        password: 'synthetic-password',
      })).rejects.toMatchObject({ code: 'bring_unavailable', status: 503 });
      expect(gateway.authenticate).toHaveBeenCalledTimes(1);
      expect(gateway.lists).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('keeps the previous connection when a new connection attempt fails', async () => {
    const { service, gateway } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'first-password',
    });
    vi.mocked(gateway.lists).mockRejectedValueOnce(new Error('synthetic list failure'));

    await expect(service.connect('owner-a', {
      email: 'test@example.com',
      password: 'second-password',
    })).rejects.toMatchObject({ code: 'bring_unavailable', status: 503 });

    await expect(service.status('owner-a')).resolves.toMatchObject({
      connected: true,
      connectionId: connected.connectionId!,
    });
    await expect(service.lists('owner-a', connected.connectionId!)).resolves.toMatchObject({
      connectionId: connected.connectionId!,
      lists: [{ id: listId, name: 'Lista Prova' }],
    });
  });

  it('reports disconnected status without contacting Bring', async () => {
    const { service, gateway } = fixture();

    await expect(service.status('owner-a')).resolves.toEqual({
      enabled: true,
      connected: false,
      connectionId: null,
    });
    expect(gateway.authenticate).not.toHaveBeenCalled();
    expect(gateway.lists).not.toHaveBeenCalled();
  });

  it('rejects reads using a connection revision replaced by reconnect', async () => {
    const { service, gateway } = fixture();
    const first = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'first-password',
    });
    const second = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'second-password',
    });
    expect(second.connectionId!).not.toBe(first.connectionId!);

    await expect(service.lists('owner-a', first.connectionId!)).rejects.toMatchObject({
      code: 'bring_stale_connection',
      status: 409,
    });
    await expect(service.read('owner-a', first.connectionId!, listId)).rejects.toMatchObject({
      code: 'bring_stale_connection',
      status: 409,
    });
    await expect(service.disconnect('owner-a', first.connectionId!)).rejects.toMatchObject({
      code: 'bring_stale_connection',
      status: 409,
    });
    await expect(service.status('owner-a')).resolves.toMatchObject({
      connectionId: second.connectionId!,
    });
    expect(gateway.lists).toHaveBeenCalledTimes(2);
    expect(gateway.items).not.toHaveBeenCalled();
  });

  it('reports disconnect as failed when repository read-back still finds the connection', async () => {
    const { gateway } = fixture();
    const backing = createMemoryBringRepository();
    const repository: BringRepository = {
      withUser: (userId, work) => backing.withUser(userId, (unit) => work({
        get: unit.get,
        put: unit.put,
        remove: async () => undefined,
      })),
    };
    const service = createBringService({
      repository,
      gateway,
      cipher: createSessionCipher('11'.repeat(32)),
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.disconnect('owner-a', connected.connectionId!)).rejects.toMatchObject({
      code: 'bring_unavailable',
      status: 503,
    });
    await expect(service.status('owner-a')).resolves.toMatchObject({
      connected: true,
      connectionId: connected.connectionId!,
    });
  });

  it('disconnects locally, verifies removal, and is idempotent when already disconnected', async () => {
    const { service, repository } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await service.disconnect('owner-a', connected.connectionId!);

    await expect(repository.withUser('owner-a', (unit) => unit.get())).resolves.toBeNull();
    await expect(service.status('owner-a')).resolves.toEqual({
      enabled: true,
      connected: false,
      connectionId: null,
    });
    await expect(service.disconnect('owner-a', connected.connectionId!)).resolves.toBeUndefined();
  });

  it('reads authorized items with Italian labels and exact remote names', async () => {
    const { service, gateway, setRaw } = fixture();
    const raw: RawItems = {
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '2 l' }],
      recently: [{ name: 'custom & item', specification: 'nota + bio' }],
    };
    setRaw(raw);
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.read('owner-a', connected.connectionId!, listId)).resolves.toEqual({
      connectionId: connected.connectionId!,
      listId,
      labelsAvailable: true,
      items: [
        { name: 'Milch', label: 'Latte', specification: '2 l', state: 'purchase', mutable: true },
        { name: 'custom & item', label: 'custom & item', specification: 'nota + bio', state: 'recently', mutable: true },
      ],
    });
    expect(gateway.items).toHaveBeenCalledWith(session, listId, expect.any(AbortSignal));
    expect(gateway.catalog).toHaveBeenCalledTimes(1);
  });

  it('keeps raw items readable when the Italian catalog is unavailable', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'custom-item', specification: '' }],
      recently: [],
    });
    vi.mocked(gateway.catalog).mockRejectedValueOnce(new Error('synthetic catalog failure'));
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.read('owner-a', connected.connectionId!, listId)).resolves.toMatchObject({
      labelsAvailable: false,
      items: [{ name: 'custom-item', label: 'custom-item', specification: '', state: 'purchase', mutable: true }],
    });
  });

  it('keeps duplicate and oversized remote rows read-only', async () => {
    const { service, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [
        { name: 'duplicate', specification: 'one' },
        { name: 'duplicate', specification: 'two' },
        { name: 'x'.repeat(BRING_NAME_MAX_LENGTH + 1), specification: '' },
        { name: 'long specification', specification: 'x'.repeat(BRING_SPEC_MAX_LENGTH + 1) },
        { name: 'Milch', specification: '2 l' },
      ],
      recently: [],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    const snapshot = await service.read('owner-a', connected.connectionId!, listId);
    expect(snapshot.items.map(({ name, mutable }) => [name, mutable])).toEqual([
      ['duplicate', false],
      ['duplicate', false],
      ['x'.repeat(BRING_NAME_MAX_LENGTH + 1), false],
      ['long specification', false],
      ['Milch', true],
    ]);
  });

  it('rejects a list not returned for the saved Bring session before reading its items', async () => {
    const { service, gateway } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.read('owner-a', connected.connectionId!, 'foreign-list')).rejects.toMatchObject({
      code: 'bring_list_not_found',
      status: 404,
    });
    expect(gateway.items).not.toHaveBeenCalled();
    expect(gateway.catalog).not.toHaveBeenCalled();
  });

  it('lists the saved account connection without authenticating again', async () => {
    const { service, gateway } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.lists('owner-a', connected.connectionId!)).resolves.toEqual({
      connectionId: connected.connectionId!,
      lists: [{ id: listId, name: 'Lista Prova' }],
    });
    expect(gateway.authenticate).toHaveBeenCalledTimes(1);
    expect(gateway.lists).toHaveBeenCalledTimes(2);
    await expect(service.lists('owner-b', connected.connectionId!)).rejects.toMatchObject({
      code: 'bring_not_connected',
      status: 409,
    });
    expect(gateway.lists).toHaveBeenCalledTimes(2);
  });
});
