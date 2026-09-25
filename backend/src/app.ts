import Fastify, { type FastifyServerOptions } from 'fastify';
import { AuthServiceError } from './auth/service.js';
import { AuthRateLimitError } from './auth/rateLimit.js';
import type { PlatformDependencies } from './platform.js';
import { type AuthRouteDependencies, registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoute } from './routes/health.js';
import { type ProfileRouteDependencies, registerProfileRoutes } from './routes/profile.js';
import { type SyncRouteDependencies, registerSyncRoutes } from './routes/sync.js';
import { SyncPayloadError, SyncScopeRequiredError } from './routes/sync.js';
import { SyncMembershipRequiredError, SyncScopeInvalidError } from './sync/repository.js';
import { type PantryLotRouteDependencies, registerPantryLotRoutes } from './routes/pantryLots.js';
import { type ShoppingListRouteDependencies, registerShoppingListRoutes } from './routes/shoppingList.js';
import { type ActivityRouteDependencies, registerActivityRoutes } from './routes/activity.js';
import { type RecipePreferenceRouteDependencies, registerRecipePreferenceRoutes } from './routes/recipePreferences.js';
import { type DietProfileRouteDependencies, registerDietProfileRoutes } from './routes/dietProfile.js';
import { type RecipeNutritionRouteDependencies, registerRecipeNutritionRoutes } from './routes/recipeNutrition.js';
import { type AiRecipeRouteDependencies, registerAiRecipeRoutes } from './routes/aiRecipes.js';
import { type HouseRouteDependencies, registerHouseRoutes } from './routes/house.js';

export type { PlatformDependencies } from './platform.js';

export interface ExtendedPlatformDependencies extends PlatformDependencies {
  auth?: AuthRouteDependencies;
  profile?: ProfileRouteDependencies;
  sync?: SyncRouteDependencies;
  pantryLots?: PantryLotRouteDependencies;
  shoppingList?: ShoppingListRouteDependencies;
  activity?: ActivityRouteDependencies;
  recipePreferences?: RecipePreferenceRouteDependencies;
  dietProfile?: DietProfileRouteDependencies;
  recipeNutrition?: RecipeNutritionRouteDependencies;
  aiRecipes?: AiRecipeRouteDependencies;
  house?: HouseRouteDependencies;
}

export const createApp = (
  dependencies: ExtendedPlatformDependencies,
  options: Pick<FastifyServerOptions, 'logger' | 'trustProxy'> = {},
) => {
  const app = Fastify({
    logger: options.logger ?? false,
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SyncPayloadError || error instanceof SyncScopeInvalidError || error instanceof SyncScopeRequiredError || error instanceof SyncMembershipRequiredError) {
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    if (error instanceof AuthServiceError) {
      if (error instanceof AuthRateLimitError && error.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }
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
  if (dependencies.dietProfile !== undefined) app.register(registerDietProfileRoutes(dependencies.dietProfile));
  if (dependencies.recipeNutrition !== undefined) app.register(registerRecipeNutritionRoutes(dependencies.recipeNutrition));
  if (dependencies.aiRecipes !== undefined) app.register(registerAiRecipeRoutes(dependencies.aiRecipes));
  if (dependencies.house !== undefined) app.register(registerHouseRoutes(dependencies.house));
  return app;
};
