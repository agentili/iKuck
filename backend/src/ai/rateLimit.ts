import type { CacheAdapter } from '../cache/client.js';

export interface GenerationRateLimitResult {
  allowed: boolean;
  used: number;
  remaining: number;
}

export interface GenerationRateReservation {
  quota: GenerationRateLimitResult;
  commit: () => Promise<void>;
  release: () => Promise<void>;
}

export interface GenerationRateLimiter {
  consume: (userId: string) => Promise<GenerationRateLimitResult>;
  reserve?: (userId: string) => Promise<GenerationRateReservation>;
}

interface RedisGenerationRateLimiterOptions {
  incrementWithExpiry: CacheAdapter['incrementWithExpiry'];
  reserveWithExpiry?: CacheAdapter['reserveWithExpiry'];
  releaseReservation?: CacheAdapter['releaseReservation'];
  clock?: () => Date;
}

/** Maximum daily AI recipe generations per user. Set high to effectively disable the limit. */
const MAX_GENERATIONS_PER_DAY = 10000;

const utcDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const secondsUntilNextUtcDay = (date: Date): number => {
  const nextDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return Math.max(1, Math.ceil((nextDay.getTime() - date.getTime()) / 1000) + 60);
};

export const createRedisGenerationRateLimiter = ({
  incrementWithExpiry,
  reserveWithExpiry,
  releaseReservation,
  clock = () => new Date(),
}: RedisGenerationRateLimiterOptions): GenerationRateLimiter => ({
  consume: async (userId) => {
    const now = clock();
    const count = await incrementWithExpiry(`ikuck:ai-generations:${userId}:${utcDayKey(now)}`, secondsUntilNextUtcDay(now));
    return {
      allowed: count <= MAX_GENERATIONS_PER_DAY,
      used: count,
      remaining: Math.max(0, MAX_GENERATIONS_PER_DAY - count),
    };
  },
  reserve: async (userId) => {
    const now = clock();
    const key = `ikuck:ai-generations:${userId}:${utcDayKey(now)}`;
    const ttl = secondsUntilNextUtcDay(now);
    const result = reserveWithExpiry === undefined
      ? await incrementWithExpiry(key, ttl).then((used) => ({
        allowed: used <= MAX_GENERATIONS_PER_DAY,
        used,
      }))
      : await reserveWithExpiry(key, MAX_GENERATIONS_PER_DAY, ttl);
    const quota = {
      allowed: result.allowed,
      used: result.used,
      remaining: Math.max(0, MAX_GENERATIONS_PER_DAY - result.used),
    };
    let state: 'reserved' | 'committed' | 'released' = result.allowed ? 'reserved' : 'released';
    return {
      quota,
      commit: async () => {
        if (state === 'reserved') state = 'committed';
      },
      release: async () => {
        if (state !== 'reserved') return;
        state = 'released';
        if (releaseReservation !== undefined) await releaseReservation(key);
      },
    };
  },
});
