import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_RATE_LIMITS,
  AuthRateLimitError,
  createRedisAuthRateLimiter,
} from './rateLimit.js';

describe('Redis-backed auth rate limiter', () => {
  it('uses separate hashed IP and normalized email keys', async () => {
    const incrementWithExpiry = vi.fn().mockResolvedValue(1);
    const limiter = createRedisAuthRateLimiter({ incrementWithExpiry });

    await limiter.enforce('login', { ip: '203.0.113.10', email: ' User@Example.COM ' });

    expect(incrementWithExpiry).toHaveBeenCalledTimes(2);
    const keys = incrementWithExpiry.mock.calls.map(([key]) => key as string);
    expect(keys.every((key) => !key.includes('User') && !key.includes('203.0.113.10'))).toBe(true);
    expect(keys[0]).toContain('ikuck:auth-rate-limit:login:ip:');
    expect(keys[1]).toContain('ikuck:auth-rate-limit:login:email:');
    expect(incrementWithExpiry.mock.calls.map(([, seconds]) => seconds)).toEqual([
      AUTH_RATE_LIMITS.login.windowSeconds,
      AUTH_RATE_LIMITS.login.windowSeconds,
    ]);
  });

  it.each([
    ['bringConnect', 15 * 60],
    ['bringRead', 60],
    ['bringWrite', 60],
  ] as const)('uses hashed IP, email, and actor keys for %s', async (action, windowSeconds) => {
    const incrementWithExpiry = vi.fn().mockResolvedValue(1);
    const limiter = createRedisAuthRateLimiter({ incrementWithExpiry });

    await limiter.enforce(action, { ip: '203.0.113.10', email: ' User@Example.COM ', actorId: 'user-123' });

    expect(incrementWithExpiry).toHaveBeenCalledTimes(3);
    const keys = incrementWithExpiry.mock.calls.map(([key]) => key as string);
    expect(keys.map((key) => key.split(':').at(-2))).toEqual(['ip', 'email', 'actor']);
    expect(keys.every((key) => !key.includes('203.0.113.10') && !key.includes('User') && !key.includes('user-123'))).toBe(true);
    expect(keys.every((key) => /^[a-f0-9]{64}$/.test(key.split(':').at(-1) ?? ''))).toBe(true);
    expect(incrementWithExpiry.mock.calls.map(([, seconds]) => seconds)).toEqual(Array(3).fill(windowSeconds));
  });

  it.each(['bringConnect', 'bringRead', 'bringWrite'] as const)('fails closed when %s has no actor id', async (action) => {
    const incrementWithExpiry = vi.fn().mockResolvedValue(1);
    const limiter = createRedisAuthRateLimiter({ incrementWithExpiry });

    await expect(limiter.enforce(action, { ip: '203.0.113.10', email: 'user@example.com' }))
      .rejects.toMatchObject({ code: 'rate_limit_unavailable', status: 503 });
    expect(incrementWithExpiry).not.toHaveBeenCalled();
  });

  it.each([
    ['bringConnect', 'ip', 30],
    ['bringConnect', 'email', 10],
    ['bringConnect', 'actor', 10],
    ['bringRead', 'ip', 300],
    ['bringRead', 'email', 120],
    ['bringRead', 'actor', 120],
    ['bringWrite', 'ip', 120],
    ['bringWrite', 'email', 60],
    ['bringWrite', 'actor', 60],
  ] as const)('enforces the exact %s %s threshold', async (action, dimension, limit) => {
    let targetedCount = limit;
    const incrementWithExpiry = vi.fn(async (key: string) => key.includes(`:${dimension}:`) ? targetedCount : 1);
    const limiter = createRedisAuthRateLimiter({ incrementWithExpiry });
    const input = { ip: '203.0.113.10', email: 'user@example.com', actorId: 'user-123' };

    await limiter.enforce(action, input);
    targetedCount = limit + 1;
    await expect(limiter.enforce(action, input)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterSeconds: AUTH_RATE_LIMITS[action].windowSeconds,
    });
  });

  it('rejects a request when either dimension exceeds its limit', async () => {
    const incrementWithExpiry = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(AUTH_RATE_LIMITS.login.emailLimit + 1);
    const limiter = createRedisAuthRateLimiter({ incrementWithExpiry });

    await expect(limiter.enforce('login', { ip: '203.0.113.10', email: 'user@example.com' }))
      .rejects.toMatchObject({
        code: 'rate_limited',
        status: 429,
        retryAfterSeconds: AUTH_RATE_LIMITS.login.windowSeconds,
      });
  });

  it('allows a new window after the backing counter has expired', async () => {
    let count = 0;
    const incrementWithExpiry = vi.fn(async () => {
      count += 1;
      return count;
    });
    const limiter = createRedisAuthRateLimiter({ incrementWithExpiry });

    await limiter.enforce('register', { ip: '203.0.113.10', email: 'user@example.com' });
    count = 0;
    await limiter.enforce('register', { ip: '203.0.113.10', email: 'user@example.com' });

    expect(incrementWithExpiry).toHaveBeenCalledTimes(4);
  });

  it('throttles house member lookup per authenticated actor and IP even when target emails rotate', async () => {
    const incrementWithExpiry = vi.fn()
      .mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(AUTH_RATE_LIMITS.houseAddMember.actorLimit + 1);
    const limiter = createRedisAuthRateLimiter({ incrementWithExpiry });
    const input = { ip: '203.0.113.10', email: 'first@example.com', actorId: 'admin-1' };
    await limiter.enforce('houseAddMember', input);
    await expect(limiter.enforce('houseAddMember', { ...input, ip: '198.51.100.20', email: 'second@example.com' }))
      .rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    const keys = incrementWithExpiry.mock.calls.map(([key]) => key as string);
    expect(keys.every((key) => !key.includes('admin-1') && !key.includes('first@example.com'))).toBe(true);
    expect(keys[2]).toBe(keys[5]);
  });

  it('fails closed when Redis is unavailable', async () => {
    const limiter = createRedisAuthRateLimiter({
      incrementWithExpiry: vi.fn().mockRejectedValue(new Error('Redis is unavailable')),
    });

    await expect(limiter.enforce('requestPasswordReset', { ip: '203.0.113.10', email: 'user@example.com' }))
      .rejects.toBeInstanceOf(AuthRateLimitError);
    await expect(limiter.enforce('requestPasswordReset', { ip: '203.0.113.10', email: 'user@example.com' }))
      .rejects.toMatchObject({ code: 'rate_limit_unavailable', status: 503 });
  });
});
