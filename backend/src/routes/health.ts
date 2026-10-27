import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { PlatformDependencies } from '../platform.js';

export const registerHealthRoute = (dependencies: PlatformDependencies): FastifyPluginAsync => async (app) => {
  const health = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await Promise.all([dependencies.database.ping(), dependencies.cache.ping()]);
      return { status: 'ok' };
    } catch (error) {
      app.log.warn(
        { dependencyError: error instanceof Error ? error.name : 'unknown' },
        'Platform health check failed',
      );
      return reply.code(503).send({ status: 'degraded' });
    }
  };

  app.get('/healthz', health);
  app.get('/v1/health', health);
};
