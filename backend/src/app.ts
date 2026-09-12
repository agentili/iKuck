import Fastify, { type FastifyServerOptions } from 'fastify';
import { AuthServiceError } from './auth/service.js';
import type { PlatformDependencies } from './platform.js';
import { type AuthRouteDependencies, registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoute } from './routes/health.js';

export type { PlatformDependencies } from './platform.js';

export interface ExtendedPlatformDependencies extends PlatformDependencies {
  auth?: AuthRouteDependencies;
}

export const createApp = (
  dependencies: ExtendedPlatformDependencies,
  options: Pick<FastifyServerOptions, 'logger'> = {},
) => {
  const app = Fastify({ logger: options.logger ?? false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthServiceError) {
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    app.log.error({ error: error instanceof Error ? error.name : 'unknown' }, 'Unhandled request error');
    return reply.code(500).send({ code: 'internal_error', message: 'Internal server error' });
  });
  app.register(registerHealthRoute(dependencies));
  if (dependencies.auth !== undefined) app.register(registerAuthRoutes(dependencies.auth));
  return app;
};
