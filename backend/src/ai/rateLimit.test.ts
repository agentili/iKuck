import { describe, expect, it, vi } from 'vitest';
import { createRedisGenerationRateLimiter } from './rateLimit.js';

describe('AI generation rate limiter', () => {
  it('allows five generations and rejects the sixth with a stable remaining count', async () => {
    let used = 0;
    const incrementWithExpiry = vi.fn(async () => used += 1);
    const limiter = createRedisGenerationRateLimiter({
      incrementWithExpiry,
      clock: () => new Date('2026-09-13T12:00:00.000Z'),
    });

    await expect(limiter.consume('user-1')).resolves.toEqual({ allowed: true, used: 1, remaining: 4 });
    await limiter.consume('user-1');
    await limiter.consume('user-1');
    await limiter.consume('user-1');
    await expect(limiter.consume('user-1')).resolves.toEqual({ allowed: true, used: 5, remaining: 0 });
    await expect(limiter.consume('user-1')).resolves.toEqual({ allowed: false, used: 6, remaining: 0 });
    expect(incrementWithExpiry).toHaveBeenCalledWith(expect.stringContaining('2026-09-13'), expect.any(Number));
  });

  it('uses a new UTC key on the next day', async () => {
    const incrementWithExpiry = vi.fn().mockResolvedValue(1);
    const limiter = createRedisGenerationRateLimiter({
      incrementWithExpiry,
      clock: () => new Date('2026-09-13T23:59:59.000Z'),
    });

    await limiter.consume('user-1');

    expect(incrementWithExpiry.mock.calls[0]?.[0]).toContain('2026-09-13');
    expect(incrementWithExpiry.mock.calls[0]?.[1]).toBeGreaterThan(0);
  });
});
