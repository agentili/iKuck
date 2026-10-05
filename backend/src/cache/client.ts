import { Buffer } from 'node:buffer';
import { createClient } from 'redis';
import type { PlatformProbe } from '../platform.js';

export interface CacheProbeClient {
  readonly isOpen: boolean;
  readonly isReady?: boolean;
  connect: () => Promise<unknown>;
  ping: () => Promise<string | Buffer>;
  quit: () => Promise<unknown>;
  destroy: () => unknown;
  incr?: (key: string) => Promise<number | `${number}`>;
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

export const createCacheWithClient = (client: CacheProbeClient, options: { connectOnDemand?: boolean; connectOnCreate?: boolean; reconnectOnDemand?: boolean; reconnectCooldownMs?: number } = {}): CacheAdapter => {
  const connectOnDemand = options.connectOnDemand !== false;
  const reconnectOnDemand = options.reconnectOnDemand === true;
  const reconnectCooldownMs = Math.max(0, options.reconnectCooldownMs ?? 1000);
  let closed = false;
  let connectionAttempted = false;
  let reconnectAfter = 0;
  let connectionPromise: Promise<unknown> | undefined;
  const connect = () => {
    if (closed) return Promise.reject(new Error('Redis client is closed'));
    if (connectionPromise === undefined) {
      const pending = Promise.resolve().then(() => {
        if (closed) throw new Error('Redis client is closed');
        connectionAttempted = true;
        return client.connect();
      });
      connectionPromise = pending;
      const connected = () => {
        if (connectionPromise !== pending) return;
        connectionPromise = undefined;
        reconnectAfter = 0;
      };
      const failed = () => {
        if (connectionPromise !== pending) return;
        connectionPromise = undefined;
        reconnectAfter = Date.now() + reconnectCooldownMs;
      };
      void pending.then(connected, failed);
    }
    return connectionPromise;
  };
  if (options.connectOnCreate) void connect().catch(() => undefined);
  const isReady = () => client.isReady === true || client.isReady === undefined && client.isOpen;
  const ensureReady = async () => {
    if (closed) throw new Error('Redis client is closed');
    if (isReady()) return;
    if (connectionPromise !== undefined) {
      await connectionPromise;
      if (!isReady()) throw new Error('Redis is not ready');
      return;
    }
    if (client.isOpen || !(connectOnDemand || reconnectOnDemand && connectionAttempted)) throw new Error('Redis is not ready');
    if (reconnectOnDemand && connectionAttempted && Date.now() < reconnectAfter) throw new Error('Redis is not ready');
    await connect();
    if (!isReady()) throw new Error('Redis is not ready');
  };

  return {
  ping: async () => {
    await ensureReady();

    const response = await client.ping();
    if ((Buffer.isBuffer(response) ? response.toString('utf8') : response) !== 'PONG') throw new Error('Redis did not acknowledge PING');
  },
  incrementWithExpiry: async (key, seconds) => {
    await ensureReady();
    if (client.incr === undefined || client.expire === undefined) throw new Error('Redis counter commands are unavailable');
    const count = Number(await client.incr(key));
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Redis counter returned an invalid count');
    if (count === 1) await client.expire(key, seconds);
    return count;
  },
  reserveWithExpiry: async (key, limit, seconds) => {
    await ensureReady();
    if (client.eval === undefined) throw new Error('Redis scripting commands are unavailable');
    const [allowed, used] = parseScriptResult(await client.eval(reserveScript, {
      keys: [key],
      arguments: [String(limit), String(seconds)],
    }));
    return { allowed, used };
  },
  releaseReservation: async (key) => {
    await ensureReady();
    if (client.eval === undefined) throw new Error('Redis scripting commands are unavailable');
    const result = Number(await client.eval(releaseScript, { keys: [key], arguments: [] }));
    if (!Number.isInteger(result) || result < 0) throw new Error('Redis quota release returned an invalid count');
    return result;
  },
  close: async () => {
    if (closed) return;
    closed = true;
    if (!client.isOpen) return;
    client.destroy();
  },
  };
};

export interface CacheCreationOptions {
  connectOnDemand?: boolean;
  disableOfflineQueue?: boolean;
  connectOnCreate?: boolean;
  reconnectOnDemand?: boolean;
}

export const createCache = (url: string, options: CacheCreationOptions = {}): CacheAdapter => {
  const recoveryEnabled = options.reconnectOnDemand === true;
  const client = createClient({
    url,
    disableOfflineQueue: options.disableOfflineQueue,
    ...(recoveryEnabled ? {
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: (retries: number) => retries < 2 ? 100 * (retries + 1) : false,
      },
    } : {}),
  });
  if (options.connectOnCreate) client.on('error', () => undefined);
  return createCacheWithClient(client, {
    connectOnDemand: options.connectOnDemand,
    connectOnCreate: options.connectOnCreate,
    reconnectOnDemand: options.reconnectOnDemand,
  });
};
