import type { CacheAdapter } from '../cache/client.js';

export interface GenerationRateLimitResult {
  allowed: boolean;
  used: number;
  remaining: number;
}

export interface GenerationRateLimiter {
  consume: (userId: string) => Promise<GenerationRateLimitResult>;
}

interface RedisGenerationRateLimiterOptions {
  incrementWithExpiry: CacheAdapter['incrementWithExpiry'];
  clock?: () => Date;
}

const MAX_GENERATIONS_PER_DAY = 5;

const utcDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const secondsUntilNextUtcDay = (date: Date): number => {
  const nextDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return Math.max(1, Math.ceil((nextDay.getTime() - date.getTime()) / 1000) + 60);
};

export const createRedisGenerationRateLimiter = ({ incrementWithExpiry, clock = () => new Date() }: RedisGenerationRateLimiterOptions): GenerationRateLimiter => ({
  consume: async (userId) => {
    const now = clock();
    const count = await incrementWithExpiry(`ikuck:ai-generations:${userId}:${utcDayKey(now)}`, secondsUntilNextUtcDay(now));
    return {
      allowed: count <= MAX_GENERATIONS_PER_DAY,
      used: count,
      remaining: Math.max(0, MAX_GENERATIONS_PER_DAY - count),
    };
  },
});
