import { createClient } from 'redis';
import type { PlatformProbe } from '../platform.js';

export interface CacheProbeClient {
  readonly isOpen: boolean;
  connect: () => Promise<unknown>;
  ping: () => Promise<string>;
  quit: () => Promise<unknown>;
}

export interface CacheAdapter extends PlatformProbe {
  close: () => Promise<void>;
}

export const createCacheWithClient = (client: CacheProbeClient): CacheAdapter => ({
  ping: async () => {
    if (!client.isOpen) await client.connect();

    const response = await client.ping();
    if (response !== 'PONG') throw new Error('Redis did not acknowledge PING');
  },
  close: async () => {
    if (client.isOpen) await client.quit();
  },
});

export const createCache = (url: string): CacheAdapter => createCacheWithClient(createClient({ url }));
