import { createClient } from 'redis';
import type { PlatformProbe } from '../platform.js';

export interface CacheProbeClient {
  readonly isOpen: boolean;
  connect: () => Promise<unknown>;
  ping: () => Promise<string>;
  quit: () => Promise<unknown>;
  incr?: (key: string) => Promise<number>;
  expire?: (key: string, seconds: number) => Promise<unknown>;
}

export interface CacheAdapter extends PlatformProbe {
  close: () => Promise<void>;
  incrementWithExpiry: (key: string, seconds: number) => Promise<number>;
}

export const createCacheWithClient = (client: CacheProbeClient): CacheAdapter => ({
  ping: async () => {
    if (!client.isOpen) await client.connect();

    const response = await client.ping();
    if (response !== 'PONG') throw new Error('Redis did not acknowledge PING');
  },
  incrementWithExpiry: async (key, seconds) => {
    if (!client.isOpen) await client.connect();
    if (client.incr === undefined || client.expire === undefined) throw new Error('Redis counter commands are unavailable');
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, seconds);
    return count;
  },
  close: async () => {
    if (client.isOpen) await client.quit();
  },
});

export const createCache = (url: string): CacheAdapter => createCacheWithClient(createClient({ url }));
