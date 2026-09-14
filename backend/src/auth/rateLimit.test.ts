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
