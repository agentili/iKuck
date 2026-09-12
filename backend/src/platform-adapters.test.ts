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
      quit: vi.fn().mockImplementation(async () => { isOpen = false; }),
    };
    const cache = createCacheWithClient(client);

    await cache.ping();
    await cache.close();
    await cache.close();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.quit).toHaveBeenCalledTimes(1);
  });
});
