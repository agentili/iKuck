import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRedisS2sRateLimiter } from './rateLimit.js';

describe('S2S rate limiter', () => {
  it('charges only the IP bucket when no valid credential ID exists', async () => {
    const calls: Array<{ key: string; limit: number; seconds: number }> = [];
    const limiter = createRedisS2sRateLimiter({
      reserveWithExpiry: async (key, limit, seconds) => {
        calls.push({ key, limit, seconds });
        return { allowed: true, used: 1 };
      },
    });
    const ip = '198.51.100.20';

    await expect(limiter.allow(null, ip)).resolves.toBe(true);
    expect(calls).toEqual([{
      key: `s2s:rate:ip:${createHash('sha256').update(ip).digest('hex')}`,
      limit: 30,
      seconds: 60,
    }]);
  });
  it('does not charge the IP bucket a second time when checking a credential', async () => {
    const calls: Array<{ key: string; limit: number; seconds: number }> = [];
    const limiter = createRedisS2sRateLimiter({
      reserveWithExpiry: async (key, limit, seconds) => {
        calls.push({ key, limit, seconds });
        return { allowed: true, used: 1 };
      },
    });
    const credentialId = 'key_0123456789abcdef';

    await expect(limiter.allow(credentialId, '198.51.100.20', { includeIp: false })).resolves.toBe(true);
    expect(calls).toEqual([{
      key: `s2s:rate:credential:${createHash('sha256').update(credentialId).digest('hex')}`,
      limit: 10,
      seconds: 60,
    }]);
  });
  it('uses a separate hashed bucket for the complete presented credential', async () => {
    const calls: Array<{ key: string; limit: number }> = [];
    const limiter = createRedisS2sRateLimiter({
      reserveWithExpiry: async (key, limit) => {
        calls.push({ key, limit });
        return { allowed: true, used: 1 };
      },
    });
    const presented = `key_0123456789abcdef.${'x'.repeat(43)}`;

    await expect(limiter.allow(presented, '198.51.100.20', { includeIp: false, bucket: 'presented' })).resolves.toBe(true);
    expect(calls).toEqual([{
      key: `s2s:rate:presented:${createHash('sha256').update(presented).digest('hex')}`,
      limit: 10,
    }]);
  });

  it('caps outstanding Redis checks until timed-out work actually settles', async () => {
    let resolveFirst!: (value: { allowed: boolean; used: number }) => void;
    let calls = 0;
    const limiter = createRedisS2sRateLimiter({
      reserveWithExpiry: async () => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return { allowed: true, used: 1 };
      },
    }, 5, 1);

    await expect(limiter.allow(null, '198.51.100.20')).rejects.toThrow('rate limit timeout');
    await expect(limiter.allow(null, '198.51.100.21')).rejects.toThrow('rate limiter is busy');
    expect(calls).toBe(1);

    resolveFirst({ allowed: true, used: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(limiter.allow(null, '198.51.100.22')).resolves.toBe(true);
  });
});
