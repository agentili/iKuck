import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { PushError } from '../push/errors.js';
import type { AuthRateLimiter } from '../auth/rateLimit.js';
import type { PushRepository } from '../push/repository.js';
import type { PushTransport } from '../push/transport.js';
import { pushStatusCode } from '../push/transport.js';
import { preferencesSchema, subscriptionSchema } from '../push/validation.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface PushRouteDependencies {
  enabled: boolean; publicKey: string | null; repository: PushRepository;
  authService: AuthService; appOrigin: string; rateLimiter: AuthRateLimiter; send: PushTransport;
}
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);
  if (!result.success) throw new PushError('invalid_payload', 400, 'Invalid push payload');
  return result.data;
};
export const registerPushRoutes = (dependencies: PushRouteDependencies): FastifyPluginAsync => async (app) => {
  const { authService, appOrigin, repository, rateLimiter } = dependencies;
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.get('/v1/push', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return { enabled: dependencies.enabled, publicKey: dependencies.publicKey, ...await repository.status(session.userId) };
  });
  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET') return;
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    if (!dependencies.enabled && request.method !== 'DELETE' && request.url !== '/v1/push/preferences') throw new PushError('push_disabled', 503, 'Push is disabled');
    await rateLimiter.enforce(request.url.endsWith('/test') ? 'pushTest' : 'pushWrite', { ip: request.ip, email: session.email, actorId: session.userId });
  });
  app.put('/v1/push/preferences', async (request, reply) => {
    const { session } = await requireVerifiedSession(request, authService);
    await repository.savePreferences(session.userId, parse(preferencesSchema, request.body));
    return reply.code(204).send();
  });
  app.get('/v1/push/subscriptions', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return repository.subscriptions(session.userId, session.id);
  });
  app.post('/v1/push/subscriptions', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return repository.subscribe(session.userId, session.id, parse(subscriptionSchema, request.body));
  });
  app.delete('/v1/push/subscriptions/:id', async (request, reply) => {
    const { session } = await requireVerifiedSession(request, authService);
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    await repository.unsubscribe(session.userId, session.id, id);
    return reply.code(204).send();
  });
  app.post('/v1/push/subscriptions/:id/test', async (request, reply) => {
    const { session } = await requireVerifiedSession(request, authService);
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    const subscription = await repository.testSubscription(session.userId, session.id, id);
    if (!subscription) return reply.code(404).send({ code: 'subscription_not_found' });
    try {
      await dependencies.send(subscription, { accountId: session.userId, title: 'Notifiche iKuck attive', body: 'Riceverai un promemoria il venerdì se il piano è da completare.', url: '/profile', tag: 'ikuck-push-test', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    } catch (error) {
      if ([404, 410].includes(pushStatusCode(error))) {
        await repository.unsubscribe(session.userId, session.id, id);
        throw new PushError('push_subscription_expired', 410, 'Push subscription expired');
      }
      throw new PushError('push_delivery_failed', 503, 'Push delivery failed');
    }
    return reply.code(204).send();
  });
};
