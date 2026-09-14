import { createHash } from 'node:crypto';
import type { CacheAdapter } from '../cache/client.js';
import { AuthServiceError } from './service.js';

export const AUTH_RATE_LIMITS = {
  login: { windowSeconds: 15 * 60, ipLimit: 30, emailLimit: 10 },
  register: { windowSeconds: 60 * 60, ipLimit: 10, emailLimit: 3 },
  resendVerification: { windowSeconds: 60 * 60, ipLimit: 10, emailLimit: 5 },
  requestPasswordReset: { windowSeconds: 60 * 60, ipLimit: 10, emailLimit: 5 },
} as const;

export type AuthRateLimitAction = keyof typeof AUTH_RATE_LIMITS;

export interface AuthRateLimiter {
  enforce: (action: AuthRateLimitAction, input: { ip: string; email: string }) => Promise<void>;
}

export class AuthRateLimitError extends AuthServiceError {
  constructor(
    code: 'rate_limited' | 'rate_limit_unavailable',
    status: 429 | 503,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code, status, message);
    this.name = 'AuthRateLimitError';
  }
}

interface RedisAuthRateLimiterOptions {
  incrementWithExpiry: CacheAdapter['incrementWithExpiry'];
}

const hashKeyPart = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalizeEmailForKey = (email: string): string => email.trim().toLowerCase();

export const createRedisAuthRateLimiter = ({ incrementWithExpiry }: RedisAuthRateLimiterOptions): AuthRateLimiter => ({
  enforce: async (action, input) => {
    const limits = AUTH_RATE_LIMITS[action];
    const dimensions = [
      { name: 'ip', value: input.ip.trim(), limit: limits.ipLimit },
      { name: 'email', value: normalizeEmailForKey(input.email), limit: limits.emailLimit },
    ];

    try {
      for (const dimension of dimensions) {
        const key = `ikuck:auth-rate-limit:${action}:${dimension.name}:${hashKeyPart(dimension.value)}`;
        const count = await incrementWithExpiry(key, limits.windowSeconds);
        if (count > dimension.limit) {
          throw new AuthRateLimitError(
            'rate_limited',
            429,
            'Too many authentication attempts. Please try again later.',
            limits.windowSeconds,
          );
        }
      }
    } catch (error) {
      if (error instanceof AuthRateLimitError) throw error;
      throw new AuthRateLimitError('rate_limit_unavailable', 503, 'Authentication is temporarily unavailable');
    }
  },
});
