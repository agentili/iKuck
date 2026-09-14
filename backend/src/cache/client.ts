import { createClient } from 'redis';
import type { PlatformProbe } from '../platform.js';

export interface CacheProbeClient {
  readonly isOpen: boolean;
  connect: () => Promise<unknown>;
  ping: () => Promise<string>;
  quit: () => Promise<unknown>;
  incr?: (key: string) => Promise<number>;
  expire?: (key: string, seconds: number) => Promise<unknown>;
  eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
}

export interface CacheAdapter extends PlatformProbe {
  close: () => Promise<void>;
  incrementWithExpiry: (key: string, seconds: number) => Promise<number>;
  reserveWithExpiry: (key: string, limit: number, seconds: number) => Promise<{ allowed: boolean; used: number }>;
  releaseReservation: (key: string) => Promise<number>;
}

const reserveScript = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if current >= limit then return { 0, current } end
local next = redis.call('INCR', KEYS[1])
if next == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return { 1, next }
`;

const releaseScript = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then redis.call('DEL', KEYS[1]); return 0 end
return redis.call('DECR', KEYS[1])
`;

const parseScriptResult = (result: unknown): [boolean, number] => {
  if (!Array.isArray(result) || result.length !== 2) throw new Error('Redis quota reservation returned an invalid result');
  const allowed = Number(result[0]) === 1;
  const used = Number(result[1]);
  if (!Number.isInteger(used) || used < 0) throw new Error('Redis quota reservation returned an invalid count');
  return [allowed, used];
};

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
  reserveWithExpiry: async (key, limit, seconds) => {
    if (!client.isOpen) await client.connect();
    if (client.eval === undefined) throw new Error('Redis scripting commands are unavailable');
    const [allowed, used] = parseScriptResult(await client.eval(reserveScript, {
      keys: [key],
      arguments: [String(limit), String(seconds)],
    }));
    return { allowed, used };
  },
  releaseReservation: async (key) => {
    if (!client.isOpen) await client.connect();
    if (client.eval === undefined) throw new Error('Redis scripting commands are unavailable');
    const result = Number(await client.eval(releaseScript, { keys: [key], arguments: [] }));
    if (!Number.isInteger(result) || result < 0) throw new Error('Redis quota release returned an invalid count');
    return result;
  },
  close: async () => {
    if (client.isOpen) await client.quit();
  },
});

export const createCache = (url: string): CacheAdapter => createCacheWithClient(createClient({ url }));
