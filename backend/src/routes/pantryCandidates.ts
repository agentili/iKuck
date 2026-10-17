import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import type { PantryCandidateService } from '../pantry/candidatesService.js';
import type { AuthRateLimiter } from '../auth/rateLimit.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface PantryCandidateRouteDependencies {
  service: PantryCandidateService;
  authService: AuthService;
  rateLimiter: AuthRateLimiter;
  appOrigin: string;
}

const querySchema = z.object({}).strict();
const batchSchema = z.object({ ids: z.array(z.string().min(1).max(160)).min(1).max(100) }).strict();

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
  return result.data;
};

export const registerPantryCandidateRoutes = ({ service, authService, rateLimiter, appOrigin }: PantryCandidateRouteDependencies): FastifyPluginAsync => async (app) => {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store').header('vary', 'Cookie');
  });

  app.get('/v1/pantry/candidates', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    parse(querySchema, request.query);
    await rateLimiter.enforce('bringRead', { ip: request.ip, email: session.email, actorId: session.userId });
    return service.list(session.userId);
  });

  app.post('/v1/pantry/candidates/accept', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { ids } = parse(batchSchema, request.body);
    await rateLimiter.enforce('bringWrite', { ip: request.ip, email: session.email, actorId: session.userId });
    return service.accept(session.userId, ids);
  });

  app.post('/v1/pantry/candidates/ignore', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { ids } = parse(batchSchema, request.body);
    await rateLimiter.enforce('bringWrite', { ip: request.ip, email: session.email, actorId: session.userId });
    return service.ignore(session.userId, ids);
  });
};
