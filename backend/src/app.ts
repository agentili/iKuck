import Fastify, { type FastifyServerOptions } from 'fastify';
import type { PlatformDependencies } from './platform.js';
import { registerHealthRoute } from './routes/health.js';

export type { PlatformDependencies } from './platform.js';

export const createApp = (
  dependencies: PlatformDependencies,
  options: Pick<FastifyServerOptions, 'logger'> = {},
) => {
  const app = Fastify({ logger: options.logger ?? false });
  app.register(registerHealthRoute(dependencies));
  return app;
};
