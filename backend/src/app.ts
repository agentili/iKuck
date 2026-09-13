import Fastify, { type FastifyServerOptions } from 'fastify';
import { AuthServiceError } from './auth/service.js';
import type { PlatformDependencies } from './platform.js';
import { type AuthRouteDependencies, registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoute } from './routes/health.js';
import { type ProfileRouteDependencies, registerProfileRoutes } from './routes/profile.js';
import { type SyncRouteDependencies, registerSyncRoutes } from './routes/sync.js';
import { type PantryLotRouteDependencies, registerPantryLotRoutes } from './routes/pantryLots.js';
import { type ShoppingListRouteDependencies, registerShoppingListRoutes } from './routes/shoppingList.js';
import { type ActivityRouteDependencies, registerActivityRoutes } from './routes/activity.js';
import { type RecipePreferenceRouteDependencies, registerRecipePreferenceRoutes } from './routes/recipePreferences.js';

export type { PlatformDependencies } from './platform.js';

export interface ExtendedPlatformDependencies extends PlatformDependencies {
  auth?: AuthRouteDependencies;
  profile?: ProfileRouteDependencies;
  sync?: SyncRouteDependencies;
  pantryLots?: PantryLotRouteDependencies;
  shoppingList?: ShoppingListRouteDependencies;
  activity?: ActivityRouteDependencies;
  recipePreferences?: RecipePreferenceRouteDependencies;
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
  if (dependencies.profile !== undefined) app.register(registerProfileRoutes(dependencies.profile));
  if (dependencies.sync !== undefined) app.register(registerSyncRoutes(dependencies.sync));
  if (dependencies.pantryLots !== undefined) app.register(registerPantryLotRoutes(dependencies.pantryLots));
  if (dependencies.shoppingList !== undefined) app.register(registerShoppingListRoutes(dependencies.shoppingList));
  if (dependencies.activity !== undefined) app.register(registerActivityRoutes(dependencies.activity));
  if (dependencies.recipePreferences !== undefined) app.register(registerRecipePreferenceRoutes(dependencies.recipePreferences));
  return app;
};
