import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BRING_NAME_MAX_LENGTH, BRING_SPEC_MAX_LENGTH, type BringMutation } from '@ikuck/shared/bring';
import type { AuthService } from '../auth/service.js';
import type { AuthRateLimiter } from '../auth/rateLimit.js';
import { BringError } from '../bring/errors.js';
import type { BringService } from '../bring/service.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface BringRouteDependencies {
  service?: BringService;
  authService: AuthService;
  appOrigin: string;
  rateLimiter: AuthRateLimiter;
}

const prefix = '/v1/integrations/bring';
const statusQuerySchema = z.object({}).strict();
const connectionSchema = z.object({ connectionId: z.string().uuid() }).strict();
const readSchema = connectionSchema.extend({ listId: z.string().uuid() }).strict();
const mutationSchema = readSchema.extend({
  action: z.enum(['add', 'update', 'complete', 'restore', 'remove']),
  name: z.string().min(1).max(BRING_NAME_MAX_LENGTH),
  specification: z.string().max(BRING_SPEC_MAX_LENGTH),
  expectedSpecification: z.string().max(10000).optional(),
}).strict().superRefine((value, context) => {
  if (value.name.trim().length === 0 || (value.action !== 'add' && value.expectedSpecification === undefined)) {
    context.addIssue({ code: 'custom', message: 'Invalid item operation' });
  }
});
const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
  confirmExternalAccess: z.literal(true),
}).strict();

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BringError('bring_invalid_payload', 400);
  return parsed.data;
};

export const registerBringRoutes = ({ service, authService, appOrigin, rateLimiter }: BringRouteDependencies): FastifyPluginAsync => async (app) => {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store').header('vary', 'Cookie');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BringError) return reply.code(error.status).send({ code: error.code, message: error.code });
    throw error;
  });
  const enabled = (): BringService => {
    if (service === undefined) throw new BringError('bring_disabled', 503);
    return service;
  };

  app.get(prefix, async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    parse(statusQuerySchema, request.query);
    return service === undefined
      ? { enabled: false, connected: false, connectionId: null }
      : service.status(session.userId);
  });

  app.post(`${prefix}/connection`, async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const input = parse(credentialsSchema, request.body);
    const current = enabled();
    await rateLimiter.enforce('bringConnect', { ip: request.ip, email: input.email, actorId: session.userId });
    return current.connect(session.userId, { email: input.email, password: input.password });
  });

  app.delete(`${prefix}/connection`, async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { connectionId } = parse(connectionSchema, request.body);
    const current = enabled();
    await rateLimiter.enforce('bringWrite', { ip: request.ip, email: session.email, actorId: session.userId });
    await current.disconnect(session.userId, connectionId);
    return reply.code(204).send();
  });

  app.get(`${prefix}/lists`, async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    const { connectionId } = parse(connectionSchema, request.query);
    const current = enabled();
    await rateLimiter.enforce('bringRead', { ip: request.ip, email: session.email, actorId: session.userId });
    return current.lists(session.userId, connectionId);
  });

  app.get(`${prefix}/items`, async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    const input = parse(readSchema, request.query);
    const current = enabled();
    await rateLimiter.enforce('bringRead', { ip: request.ip, email: session.email, actorId: session.userId });
    return current.read(session.userId, input.connectionId, input.listId);
  });

  app.post(`${prefix}/items`, async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const input: BringMutation = parse(mutationSchema, request.body);
    const current = enabled();
    await rateLimiter.enforce('bringWrite', { ip: request.ip, email: session.email, actorId: session.userId });
    return current.write(session.userId, input);
  });
};
