import Fastify from 'fastify';
import type { PlatformDependencies } from './platform.js';
import { registerHealthRoute } from './routes/health.js';

export type { PlatformDependencies } from './platform.js';

export const createApp = (dependencies: PlatformDependencies) => {
  const app = Fastify({ logger: false });
  app.register(registerHealthRoute(dependencies));
  return app;
};
