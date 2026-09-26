import { describe, expect, it, vi } from 'vitest';
import { createRedisGenerationRateLimiter } from './rateLimit.js';

describe('AI generation rate limiter', () => {
  it('allows many generations with high remaining count', async () => {
    let used = 0;
    const incrementWithExpiry = vi.fn(async () => used += 1);
    const limiter = createRedisGenerationRateLimiter({
      incrementWithExpiry,
      clock: () => new Date('2026-09-13T12:00:00.000Z'),
    });

    await expect(limiter.consume('user-1')).resolves.toEqual({ allowed: true, used: 1, remaining: 9999 });
    await limiter.consume('user-1');
    await limiter.consume('user-1');
    await limiter.consume('user-1');
    await expect(limiter.consume('user-1')).resolves.toEqual({ allowed: true, used: 5, remaining: 9995 });
    await expect(limiter.consume('user-1')).resolves.toEqual({ allowed: true, used: 6, remaining: 9994 });
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

  it('reserves atomically and commits without releasing a successful slot', async () => {
    const reserveWithExpiry = vi.fn().mockResolvedValue({ allowed: true, used: 1 });
    const releaseReservation = vi.fn().mockResolvedValue(0);
    const limiter = createRedisGenerationRateLimiter({
      incrementWithExpiry: vi.fn(),
      reserveWithExpiry,
      releaseReservation,
      clock: () => new Date('2026-09-13T12:00:00.000Z'),
    });

    const reservation = await limiter.reserve?.('user-1');

    expect(reservation?.quota).toEqual({ allowed: true, used: 1, remaining: 9999 });
    await reservation?.commit();
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(reserveWithExpiry).toHaveBeenCalledWith(expect.stringContaining('2026-09-13'), 10000, expect.any(Number));
  });

  it('releases a reserved slot when generation fails', async () => {
    const releaseReservation = vi.fn().mockResolvedValue(0);
    const reservation = await createRedisGenerationRateLimiter({
      incrementWithExpiry: vi.fn(),
      reserveWithExpiry: vi.fn().mockResolvedValue({ allowed: true, used: 1 }),
      releaseReservation,
    }).reserve?.('user-1');

    await reservation?.release();
    await reservation?.release();

    expect(reservation?.quota).toMatchObject({ allowed: true, used: 1 });
    expect(releaseReservation).toHaveBeenCalledOnce();
  });
});
