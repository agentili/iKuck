import type { FastifyPluginAsync } from 'fastify';
import type { PlatformDependencies } from '../platform.js';

export const registerHealthRoute = (dependencies: PlatformDependencies): FastifyPluginAsync => async (app) => {
  app.get('/healthz', async (_request, reply) => {
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
  });
};
