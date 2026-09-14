import { describe, expect, it, vi } from 'vitest';
import { createCacheWithClient } from './cache/client.js';
import { createDatabaseWithClient } from './db/client.js';

describe('platform adapters', () => {
  it('uses a constant PostgreSQL readiness query', async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const end = vi.fn().mockResolvedValue(undefined);
    const database = createDatabaseWithClient({ unsafe, end });

    await database.ping();
    await database.close();

    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe).toHaveBeenCalledWith('SELECT 1');
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('connects Redis before probing and closes each adapter safely', async () => {
    let isOpen = false;
    const client = {
      get isOpen() {
        return isOpen;
      },
      connect: vi.fn().mockImplementation(async () => { isOpen = true; }),
      ping: vi.fn().mockResolvedValue('PONG'),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockImplementation(async () => { isOpen = false; }),
    };
    const cache = createCacheWithClient(client);

    await cache.ping();
    await expect(cache.incrementWithExpiry('ikuck:test', 120)).resolves.toBe(1);
    await cache.close();
    await cache.close();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.incr).toHaveBeenCalledWith('ikuck:test');
    expect(client.expire).toHaveBeenCalledWith('ikuck:test', 120);
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it('uses atomic Redis scripts for quota reservation and release', async () => {
    let isOpen = true;
    const evalScript = vi.fn()
      .mockResolvedValueOnce([1, 2])
      .mockResolvedValueOnce(1);
    const client = {
      get isOpen() {
        return isOpen;
      },
      connect: vi.fn(),
      ping: vi.fn().mockResolvedValue('PONG'),
      eval: evalScript,
      quit: vi.fn().mockImplementation(async () => { isOpen = false; }),
    };
    const cache = createCacheWithClient(client);

    await expect(cache.reserveWithExpiry('quota-key', 5, 120)).resolves.toEqual({ allowed: true, used: 2 });
    await expect(cache.releaseReservation('quota-key')).resolves.toBe(1);

    expect(evalScript).toHaveBeenCalledTimes(2);
    expect(evalScript.mock.calls[0]?.[1]).toEqual({ keys: ['quota-key'], arguments: ['5', '120'] });
    expect(evalScript.mock.calls[1]?.[1]).toEqual({ keys: ['quota-key'], arguments: [] });
  });
});
