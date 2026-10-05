import { createHash } from 'node:crypto';
import type { CacheAdapter } from '../cache/client.js';

const hashKey = (kind: 'credential' | 'presented' | 'ip', value: string) => createHash('sha256').update(value).digest('hex');

export const createRedisS2sRateLimiter = (cache: Pick<CacheAdapter, 'reserveWithExpiry'>, timeoutMs = 1000, maxConcurrentChecks = 64) => {
  let inFlight = 0;
  return {
  async allow(credentialId: string | null, ip: string, options: { includeIp?: boolean; bucket?: 'credential' | 'presented' } = {}): Promise<boolean> {
    if (inFlight >= maxConcurrentChecks) throw new Error('S2S rate limiter is busy');
    inFlight += 1;
    const includeIp = options.includeIp !== false;
    const credentialBucket = options.bucket ?? 'credential';
    const checks = [
      ...(credentialId === null ? [] : [{ key: `s2s:rate:${credentialBucket}:${hashKey(credentialBucket, credentialId)}`, limit: 10 }]),
      ...(includeIp ? [{ key: `s2s:rate:ip:${hashKey('ip', ip)}`, limit: 30 }] : []),
    ];
    const commandPromises = checks.map(({ key, limit }) => Promise.resolve().then(() => cache.reserveWithExpiry(key, limit, 60)));
    const operation = Promise.all(commandPromises.map(async (pending) => (await pending).allowed));
    void Promise.allSettled(commandPromises).then(() => { inFlight -= 1; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const allowed = await Promise.race([
        operation,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('S2S Redis rate limit timeout')), timeoutMs); }),
      ]);
      return allowed.every(Boolean);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
  };
};
