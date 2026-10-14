import { describe, expect, it, vi } from 'vitest';
import { BRING_NAME_MAX_LENGTH, BRING_SPEC_MAX_LENGTH } from '@ikuck/shared/bring';
import { createBringService } from './service.js';
import { createMemoryBringRepository } from './repository.js';
import { createSessionCipher } from './sessionCipher.js';
import type { BringMutation } from '@ikuck/shared/bring';
import type { BringGateway, RawItems } from './gateway.js';
import type { BringRepository } from './repository.js';
import { createMemorySyncRepository } from '../sync/repository.js';
import { createShoppingListMutation, readShoppingListItems } from '../shopping/writer.js';
import { BringError } from './errors.js';

const listId = '11111111-1111-4111-8111-111111111111';
const session = { userId: 'bring-user', accessToken: 'synthetic-access' };

const fixture = (allowedListIds: readonly string[] = []) => {
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
  const shoppingRepository = createMemorySyncRepository();
  const service = createBringService({ repository, gateway, cipher, allowedListIds, shoppingRepository });
  return { service, gateway, repository, cipher, shoppingRepository, setRaw: (next: RawItems) => { raw = next; } };
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
      allowedListIds: [listId],
      shoppingRepository: createMemorySyncRepository(),
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

  it('rejects the designated test list when the connected account cannot see it before reading its items', async () => {
    const { service, gateway } = fixture();
    vi.mocked(gateway.lists).mockResolvedValue([{ id: '22222222-2222-4222-8222-222222222222', name: 'Altra lista' }]);
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.read('owner-a', connected.connectionId!, listId)).rejects.toMatchObject({
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

  it('adds a catalog item only after the remote read-back confirms it', async () => {
    const { service, gateway, setRaw } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    const mutation: BringMutation = {
      connectionId: connected.connectionId!,
      listId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    };
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      expect(input).toEqual({ listId, name: 'Milch', specification: '2 l', action: 'add' });
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [{ name: input.name, specification: input.specification }],
        recently: [],
      });
    });

    await expect(service.write('owner-a', mutation)).resolves.toMatchObject({
      connectionId: connected.connectionId!,
      listId,
      items: [{ name: 'Milch', label: 'Latte', specification: '2 l', state: 'purchase', mutable: true }],
    });
    expect(gateway.change).toHaveBeenCalledTimes(1);
    expect(gateway.items).toHaveBeenCalledTimes(2);
  });

  it('updates a purchase item only when its expected specification still matches', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '2 l' }],
      recently: [],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [{ name: input.name, specification: input.specification }],
        recently: [],
      });
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'update',
      name: 'Milch',
      specification: '3 l',
      expectedSpecification: '2 l',
    })).resolves.toMatchObject({
      items: [{ name: 'Milch', specification: '3 l', state: 'purchase' }],
    });
    expect(gateway.change).toHaveBeenCalledWith(session, {
      listId,
      name: 'Milch',
      specification: '3 l',
      action: 'update',
    }, expect.any(AbortSignal));
  });

  it('completes a purchase item only after it appears in recently', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'custom & item', specification: 'nota + bio' }],
      recently: [],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [],
        recently: [{ name: input.name, specification: input.specification }],
      });
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'complete',
      name: 'custom & item',
      specification: 'nota + bio',
      expectedSpecification: 'nota + bio',
    })).resolves.toMatchObject({
      items: [{ name: 'custom & item', specification: 'nota + bio', state: 'recently' }],
    });
    expect(gateway.change).toHaveBeenCalledWith(session, {
      listId,
      name: 'custom & item',
      specification: 'nota + bio',
      action: 'complete',
    }, expect.any(AbortSignal));
  });

  it('restores a recently completed item only after it returns to purchase', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [],
      recently: [{ name: 'custom & item', specification: 'nota + bio' }],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [{ name: input.name, specification: input.specification }],
        recently: [],
      });
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'restore',
      name: 'custom & item',
      specification: 'nota + bio',
      expectedSpecification: 'nota + bio',
    })).resolves.toMatchObject({
      items: [{ name: 'custom & item', specification: 'nota + bio', state: 'purchase' }],
    });
    expect(gateway.change).toHaveBeenCalledWith(session, {
      listId,
      name: 'custom & item',
      specification: 'nota + bio',
      action: 'restore',
    }, expect.any(AbortSignal));
  });

  it('removes a raw remote identity only after both remote groups no longer contain it', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'custom & item', specification: 'nota + bio' }],
      recently: [],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      setRaw({ uuid: listId, status: 'REGISTERED', purchase: [], recently: [] });
      expect(input.name).toBe('custom & item');
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'remove',
      name: 'custom & item',
      specification: 'nota + bio',
      expectedSpecification: 'nota + bio',
    })).resolves.toMatchObject({ items: [] });
    expect(gateway.change).toHaveBeenCalledWith(session, {
      listId,
      name: 'custom & item',
      specification: 'nota + bio',
      action: 'remove',
    }, expect.any(AbortSignal));
  });

  it('reports an uncertain upstream mutation without retrying or dropping the connection', async () => {
    const { service, gateway, setRaw } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [{ name: 'Milch', specification: input.specification }],
        recently: [],
      });
      throw new BringError('bring_unavailable', 503);
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_write_unconfirmed', status: 503 });
    expect(gateway.change).toHaveBeenCalledTimes(1);
    await expect(service.status('owner-a')).resolves.toMatchObject({
      connected: true,
      connectionId: connected.connectionId!,
    });
  });

  it('does not accept an upstream write response without matching read-back state', async () => {
    const { service, gateway } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_write_unconfirmed', status: 503 });
    expect(gateway.change).toHaveBeenCalledTimes(1);
    expect(gateway.items).toHaveBeenCalledTimes(2);
  });

  it('rejects updates with a stale expected specification before dispatch', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '2 l' }],
      recently: [],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'update',
      name: 'Milch',
      specification: '3 l',
      expectedSpecification: '1 l',
    })).rejects.toMatchObject({ code: 'bring_item_changed', status: 409 });
    expect(gateway.change).not.toHaveBeenCalled();
    expect(gateway.items).toHaveBeenCalledTimes(1);
  });

  it('rejects a post-write duplicate even when one purchase row matches', async () => {
    const { service, gateway, setRaw } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      const duplicate = { name: input.name, specification: input.specification };
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [duplicate],
        recently: [{ ...duplicate }],
      });
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_write_unconfirmed', status: 503 });
    expect(gateway.change).toHaveBeenCalledTimes(1);
    expect(gateway.items).toHaveBeenCalledTimes(2);
  });

  it('does not let add overwrite an existing remote item with a different specification', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '1 l' }],
      recently: [],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_item_exists', status: 409 });
    expect(gateway.change).not.toHaveBeenCalled();
    expect(gateway.items).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate pre-write identity before dispatch', async () => {
    const { service, gateway, setRaw } = fixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [
        { name: 'Milch', specification: '1 l' },
        { name: 'Milch', specification: '2 l' },
      ],
      recently: [],
    });
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'update',
      name: 'Milch',
      specification: '3 l',
      expectedSpecification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_ambiguous_item', status: 409 });
    expect(gateway.change).not.toHaveBeenCalled();
    expect(gateway.items).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale connection revision before attempting a remote write', async () => {
    const { service, gateway } = fixture();
    const first = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'first-password',
    });
    await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'second-password',
    });

    await expect(service.write('owner-a', {
      connectionId: first.connectionId!,
      listId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_stale_connection', status: 409 });
    expect(gateway.change).not.toHaveBeenCalled();
    expect(gateway.items).not.toHaveBeenCalled();
  });

  it('does not add when the catalog needed to resolve its remote identity is unavailable', async () => {
    const { service, gateway } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    vi.mocked(gateway.catalog).mockRejectedValueOnce(new Error('synthetic catalog failure'));

    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_unavailable', status: 503 });
    expect(gateway.change).not.toHaveBeenCalled();
    expect(gateway.catalog).toHaveBeenCalledTimes(1);
  });

  it('does not retry a write when the signal expires before read-back', async () => {
    const { service, gateway, setRaw } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [{ name: 'Milch', specification: input.specification }],
        recently: [],
      });
      controller.abort();
    });

    try {
      await expect(service.write('owner-a', {
        connectionId: connected.connectionId!,
        listId,
        action: 'add',
        name: 'Latte',
        specification: '2 l',
      })).rejects.toMatchObject({ code: 'bring_write_unconfirmed', status: 503 });
      expect(gateway.change).toHaveBeenCalledTimes(1);
      expect(gateway.items).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it('marks a timed-out read-back unconfirmed without retrying the mutation', async () => {
    const { service, gateway, setRaw } = fixture();
    const connected = await service.connect('owner-a', {
      email: 'test@example.com',
      password: 'synthetic-password',
    });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    vi.mocked(gateway.items)
      .mockImplementationOnce(async () => ({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [],
        recently: [],
      }))
      .mockImplementationOnce((_storedSession, _requestedListId, signal) => new Promise<RawItems>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('synthetic read-back timeout')), { once: true });
        abortTimer = setTimeout(() => controller.abort(), 0);
      }));
    vi.mocked(gateway.change).mockImplementationOnce(async (_storedSession, input) => {
      setRaw({
        uuid: listId,
        status: 'REGISTERED',
        purchase: [{ name: input.name, specification: input.specification }],
        recently: [],
      });
    });

    try {
      await expect(service.write('owner-a', {
        connectionId: connected.connectionId!,
        listId,
        action: 'add',
        name: 'Latte',
        specification: '2 l',
      })).rejects.toMatchObject({ code: 'bring_write_unconfirmed', status: 503 });
      expect(gateway.change).toHaveBeenCalledTimes(1);
      expect(gateway.items).toHaveBeenCalledTimes(2);
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      timeout.mockRestore();
    }
  });
});

describe('Bring optional list restriction', () => {
  const otherListId = '22222222-2222-4222-8222-222222222222';
  const credentials = { email: 'test@example.com', password: 'synthetic-password' };

  it('allows every list of the connected account when no restriction is configured', async () => {
    const { service, gateway, setRaw } = fixture();
    vi.mocked(gateway.lists).mockResolvedValue([
      { id: otherListId, name: 'Spesa di famiglia' },
      { id: listId, name: 'Lista Prova' },
    ]);
    setRaw({
      uuid: otherListId,
      status: 'REGISTERED',
      purchase: [{ name: 'Pane', specification: '1 kg' }],
      recently: [],
    });
    const connected = await service.connect('owner-a', credentials);

    expect(connected).toMatchObject({
      enabled: true,
      connected: true,
      lists: [
        { id: otherListId, name: 'Spesa di famiglia' },
        { id: listId, name: 'Lista Prova' },
      ],
    });
    await expect(service.read('owner-a', connected.connectionId!, otherListId)).resolves.toEqual({
      connectionId: connected.connectionId!,
      listId: otherListId,
      labelsAvailable: true,
      items: [{ name: 'Pane', label: 'Pane', specification: '1 kg', state: 'purchase', mutable: true }],
    });
  });

  it('refuses to read, write or import every list outside the configured restriction', async () => {
    const { service, gateway } = fixture([listId]);
    const connected = await service.connect('owner-a', credentials);
    vi.mocked(gateway.items).mockClear();
    vi.mocked(gateway.lists).mockClear();

    await expect(service.read('owner-a', connected.connectionId!, otherListId))
      .rejects.toMatchObject({ code: 'bring_list_not_allowed', status: 403 });
    await expect(service.write('owner-a', {
      connectionId: connected.connectionId!,
      listId: otherListId,
      action: 'add',
      name: 'Latte',
      specification: '2 l',
    })).rejects.toMatchObject({ code: 'bring_list_not_allowed', status: 403 });
    await expect(service.importList('owner-a', connected.connectionId!, otherListId))
      .rejects.toMatchObject({ code: 'bring_list_not_allowed', status: 403 });
    expect(gateway.lists).not.toHaveBeenCalled();
    expect(gateway.items).not.toHaveBeenCalled();
    expect(gateway.catalog).not.toHaveBeenCalled();
    expect(gateway.change).not.toHaveBeenCalled();
  });

  it('keeps a restricted list fully operable and importable', async () => {
    const { service, gateway, setRaw, shoppingRepository } = fixture([listId]);
    const connected = await service.connect('owner-a', credentials);
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '2 l' }],
      recently: [],
    });
    vi.mocked(gateway.items).mockClear();

    await expect(service.read('owner-a', connected.connectionId!, listId)).resolves.toMatchObject({
      connectionId: connected.connectionId!,
      listId,
      items: [{ name: 'Milch', state: 'purchase' }],
    });
    await expect(service.importList('owner-a', connected.connectionId!, listId))
      .resolves.toEqual({ imported: 1, skipped: 0, recently: 0 });
    await expect(readShoppingListItems(shoppingRepository, 'owner-a')).resolves.toMatchObject([{ label: 'Latte' }]);
    expect(gateway.items).toHaveBeenCalledWith(session, listId, expect.any(AbortSignal));
  });
});

describe('Bring one-shot import', () => {
  const credentials = { email: 'test@example.com', password: 'synthetic-password' };

  const connectedFixture = async (allowedListIds: readonly string[] = []) => {
    const state = fixture(allowedListIds);
    const connected = await state.service.connect('owner-a', credentials);
    const connectionId = connected.connectionId;
    if (connectionId === null) throw new Error('Bring connection was not created');
    return { ...state, connectionId };
  };

  it('copies purchase items into the iKuck shopping list with the exact mapping', async () => {
    const { service, gateway, shoppingRepository, setRaw, connectionId } = await connectedFixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [
        { name: 'Milch', specification: '2 l bio' },
        { name: 'custom-item', specification: '  nota con spazi  ' },
        { name: 'no-note', specification: '' },
      ],
      recently: [],
    });
    vi.mocked(gateway.items).mockClear();
    vi.mocked(gateway.catalog).mockClear();

    await expect(service.importList('owner-a', connectionId, listId))
      .resolves.toEqual({ imported: 3, skipped: 0, recently: 0 });

    const items = await readShoppingListItems(shoppingRepository, 'owner-a');
    expect(items.map((item) => item.label)).toEqual(['Latte', 'custom-item', 'no-note']);
    expect(items[0]).toMatchObject({
      ingredientId: 'custom:latte',
      quantity: null,
      unit: null,
      note: '2 l bio',
      purchased: false,
      sourceRecipeId: null,
    });
    expect(items[1]).toMatchObject({
      ingredientId: 'custom:custom-item',
      label: 'custom-item',
      quantity: null,
      unit: null,
      note: 'nota con spazi',
      purchased: false,
      sourceRecipeId: null,
    });
    expect(items[2]).toMatchObject({ ingredientId: 'custom:no-note', quantity: null, unit: null, note: null });
    for (const item of items) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
      expect(item.createdAt).toBe(item.updatedAt);
    }
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    expect(gateway.lists).toHaveBeenCalledWith(session, expect.any(AbortSignal));
    expect(gateway.items).toHaveBeenCalledTimes(1);
    expect(gateway.catalog).toHaveBeenCalledTimes(1);
    expect(gateway.change).not.toHaveBeenCalled();
  });

  it('truncates long specifications and skips labels the iKuck list cannot store', async () => {
    const { service, shoppingRepository, setRaw, connectionId } = await connectedFixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [
        { name: 'Milch', specification: `${'x'.repeat(200)}` },
        { name: '   ', specification: 'senza etichetta' },
        { name: 'z'.repeat(121), specification: '' },
        { name: 'Caffè', specification: ' 1 kg ' },
      ],
      recently: [],
    });

    await expect(service.importList('owner-a', connectionId, listId))
      .resolves.toEqual({ imported: 2, skipped: 2, recently: 0 });

    const items = await readShoppingListItems(shoppingRepository, 'owner-a');
    expect(items.map((item) => item.label)).toEqual(['Latte', 'Caffè']);
    expect(items[0]?.note).toBe('x'.repeat(120));
    expect(items[1]?.note).toBe('1 kg');
  });

  it('counts recently purchased items without importing them', async () => {
    const { service, shoppingRepository, setRaw, connectionId } = await connectedFixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '1 l' }],
      recently: [{ name: 'Yogurt', specification: '2' }],
    });

    await expect(service.importList('owner-a', connectionId, listId))
      .resolves.toEqual({ imported: 1, skipped: 0, recently: 1 });
    await expect(readShoppingListItems(shoppingRepository, 'owner-a')).resolves.toHaveLength(1);
  });

  it('skips labels already pending in iKuck and duplicates inside the same import', async () => {
    const { service, shoppingRepository, setRaw, connectionId } = await connectedFixture();
    const now = new Date().toISOString();
    const pending = {
      id: 'existing-latte',
      ingredientId: 'custom:latte',
      label: 'Latte',
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
      createdAt: now,
      updatedAt: now,
    };
    await shoppingRepository.applyMutation('owner-a', createShoppingListMutation(pending, 'upsert'));
    await shoppingRepository.applyMutation('owner-a', createShoppingListMutation({
      ...pending,
      id: 'purchased-pane',
      ingredientId: 'custom:pane',
      label: 'Pane',
      purchased: true,
    }, 'upsert'));
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [
        { name: 'Milch', specification: '1 l' },
        { name: 'pane', specification: '1 kg' },
        { name: 'Pane', specification: '1 kg' },
      ],
      recently: [],
    });

    await expect(service.importList('owner-a', connectionId, listId))
      .resolves.toEqual({ imported: 1, skipped: 2, recently: 0 });

    const items = await readShoppingListItems(shoppingRepository, 'owner-a');
    expect(items.map((item) => item.label)).toEqual(['Latte', 'Pane', 'pane']);
  });

  it('imports raw remote names when the Italian catalog is unavailable', async () => {
    const { service, gateway, shoppingRepository, setRaw, connectionId } = await connectedFixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '1 l' }],
      recently: [],
    });
    vi.mocked(gateway.catalog).mockRejectedValueOnce(new Error('synthetic catalog failure'));

    await expect(service.importList('owner-a', connectionId, listId))
      .resolves.toEqual({ imported: 1, skipped: 0, recently: 0 });
    await expect(readShoppingListItems(shoppingRepository, 'owner-a'))
      .resolves.toMatchObject([{ label: 'Milch', ingredientId: 'custom:milch' }]);
  });

  it('does not duplicate items on a second import', async () => {
    const { service, shoppingRepository, setRaw, connectionId } = await connectedFixture();
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '1 l' }],
      recently: [{ name: 'Yogurt', specification: '2' }],
    });

    await expect(service.importList('owner-a', connectionId, listId))
      .resolves.toEqual({ imported: 1, skipped: 0, recently: 1 });
    await expect(service.importList('owner-a', connectionId, listId))
      .resolves.toEqual({ imported: 0, skipped: 1, recently: 1 });
    await expect(readShoppingListItems(shoppingRepository, 'owner-a')).resolves.toHaveLength(1);
  });

  it('reports a disconnected account without touching the iKuck shopping list', async () => {
    const { service, gateway, shoppingRepository } = fixture();
    const connectionId = '550e8400-e29b-41d4-a716-446655440000';

    await expect(service.importList('owner-a', connectionId, listId))
      .rejects.toMatchObject({ code: 'bring_not_connected', status: 409 });
    await expect(readShoppingListItems(shoppingRepository, 'owner-a')).resolves.toEqual([]);
    expect(gateway.items).not.toHaveBeenCalled();
  });

  it('reports a connection revision replaced by reconnect without importing anything', async () => {
    const { service, shoppingRepository, setRaw } = fixture();
    const first = await service.connect('owner-a', credentials);
    await service.connect('owner-a', credentials);
    setRaw({
      uuid: listId,
      status: 'REGISTERED',
      purchase: [{ name: 'Milch', specification: '1 l' }],
      recently: [],
    });

    await expect(service.importList('owner-a', first.connectionId!, listId))
      .rejects.toMatchObject({ code: 'bring_stale_connection', status: 409 });
    await expect(readShoppingListItems(shoppingRepository, 'owner-a')).resolves.toEqual([]);
  });
});
