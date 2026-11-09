import { PushError } from './push/errors.js';
import { registerPushRoutes, type PushRouteDependencies } from './routes/push.js';
import Fastify, { LogController, type FastifyServerOptions } from 'fastify';
import { AuthServiceError } from './auth/service.js';
import { AuthRateLimitError } from './auth/rateLimit.js';
import type { PlatformDependencies } from './platform.js';
import { type AuthRouteDependencies, registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoute } from './routes/health.js';
import { type ProfileRouteDependencies, registerProfileRoutes } from './routes/profile.js';
import { type SyncRouteDependencies, registerSyncRoutes } from './routes/sync.js';
import { registerMealPlanRoutes, MealPlanCapabilityUnavailableError } from './routes/mealPlan.js';
import {
  PlanCommandRequiredError,
  PlanCommandValidationError,
  PlanOperationIdReusedError,
  PlanReadValidationError,
  PlanRecoveryNotFoundError,
  PlanRecoveryRevisionConflictError,
  PlanRecoveryResolutionReusedError,
  PlanScopeInvalidError,
} from './mealPlan/validation.js';
import { SyncPayloadError, SyncScopeRequiredError } from './routes/sync.js';
import { SyncDiaryRecipeLimitError, SyncMembershipRequiredError, SyncScopeInvalidError, HouseMigrationPendingError, PlanMigrationQuarantinedError } from './sync/repository.js';
import { DinnerConsumptionConflictError, DinnerConsumptionInputError } from './pantry/consumptionService.js';
import { type PantryLotRouteDependencies, registerPantryLotRoutes } from './routes/pantryLots.js';
import { type ShoppingListRouteDependencies, registerShoppingListRoutes } from './routes/shoppingList.js';
import { type ActivityRouteDependencies, registerActivityRoutes } from './routes/activity.js';
import { type RecipePreferenceRouteDependencies, registerRecipePreferenceRoutes } from './routes/recipePreferences.js';
import { type DietProfileRouteDependencies, registerDietProfileRoutes } from './routes/dietProfile.js';
import { type RecipeNutritionRouteDependencies, registerRecipeNutritionRoutes } from './routes/recipeNutrition.js';
import { type AiRecipeRouteDependencies, registerAiRecipeRoutes } from './routes/aiRecipes.js';
import { registerChefChatRoutes, type ChefChatDependencies } from './routes/chefChat.js';
import { type HouseRouteDependencies, registerHouseRoutes } from './routes/house.js';
import { type DinnerDiaryRecipeRouteDependencies, registerDinnerDiaryRecipeRoutes } from './routes/dinnerDiaryRecipes.js';
import { type DinnerConsumptionRouteDependencies, registerDinnerConsumptionRoutes } from './routes/dinnerConsumption.js';
import { registerBringRoutes, type BringRouteDependencies } from './routes/bring.js';
import { registerPantryCandidateRoutes, type PantryCandidateRouteDependencies } from './routes/pantryCandidates.js';
import { BringError } from './bring/errors.js';
import { type S2sDinnerContextService } from './s2s/dinnerContext.js';
import { registerS2sDinnerContextRoutes } from './routes/s2sDinnerContext.js';
import { shouldDisableRequestLogging } from './serverLogging.js';

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
  chefChat?: ChefChatDependencies;
  push?: PushRouteDependencies;
  house?: HouseRouteDependencies;
  dinnerDiary?: DinnerDiaryRecipeRouteDependencies;
  dinnerConsumption?: DinnerConsumptionRouteDependencies;
  bring?: BringRouteDependencies;
  pantryCandidates?: PantryCandidateRouteDependencies;
  s2sDinnerContext?: S2sDinnerContextService;
}

export const createApp = (
  dependencies: ExtendedPlatformDependencies,
  options: Pick<FastifyServerOptions, 'logger' | 'trustProxy' | 'logController'> = {},
) => {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: options.logController ?? new LogController({ disableRequestLogging: shouldDisableRequestLogging }),
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] === '/v1/chef-chat') reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return reply;
    if (request.url.split('?')[0] === '/v1/chef-chat' && !(error instanceof AuthServiceError)) {
      if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
        return reply.code(400).send({ code: 'invalid_payload', message: 'Request payload is invalid' });
      }
      return reply.code(503).send({ code: 'provider_unavailable', message: 'AI chat is unavailable' });
    }
    if (request.url.split('?')[0] === '/v1/s2s/dinner-context') {
      reply.header('cache-control', 'no-store').header('vary', 'Authorization');
      if (dependencies.s2sDinnerContext?.isRequestExpired(request.raw)) {
        return reply.code(503).send({ code: 'service_unavailable' });
      }
      if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
        return reply.code(400).send({ code: 'invalid_request' });
      }
      app.log.error({ error: error instanceof Error ? error.name : 'unknown' }, 'S2S request failed');
      return reply.code(503).send({ code: 'service_unavailable' });
    }
    if (error instanceof PlanCommandRequiredError || error instanceof PlanCommandValidationError || error instanceof PlanOperationIdReusedError || error instanceof PlanReadValidationError || error instanceof PlanRecoveryNotFoundError || error instanceof PlanRecoveryRevisionConflictError || error instanceof PlanRecoveryResolutionReusedError || error instanceof PlanScopeInvalidError || error instanceof MealPlanCapabilityUnavailableError || error instanceof PlanMigrationQuarantinedError) {
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    if (error instanceof HouseMigrationPendingError) {
      return reply.code(error.status).header('retry-after', String(error.retryAfterSeconds)).send({ code: error.code, message: error.message, retryable: true });
    }
    if (error instanceof SyncPayloadError || error instanceof SyncScopeInvalidError || error instanceof SyncScopeRequiredError || error instanceof SyncMembershipRequiredError || error instanceof SyncDiaryRecipeLimitError || error instanceof DinnerConsumptionInputError || error instanceof DinnerConsumptionConflictError) {
      return reply.code(error.status).send({ code: error.code, message: error.message });
    }
    if (error instanceof PushError) return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof BringError) {
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
  if (dependencies.auth !== undefined) {
    app.register(registerAuthRoutes(dependencies.auth));
    app.register(registerChefChatRoutes(dependencies.chefChat ?? { authService: dependencies.auth.service, appOrigin: dependencies.auth.appOrigin }));
  }
  if (dependencies.push !== undefined) app.register(registerPushRoutes(dependencies.push));
  if (dependencies.profile !== undefined) app.register(registerProfileRoutes(dependencies.profile));
  if (dependencies.sync !== undefined) {
    app.register(registerSyncRoutes(dependencies.sync));
    app.register(registerMealPlanRoutes(dependencies.sync));
  }
  if (dependencies.pantryLots !== undefined) app.register(registerPantryLotRoutes(dependencies.pantryLots));
  if (dependencies.shoppingList !== undefined) app.register(registerShoppingListRoutes(dependencies.shoppingList));
  if (dependencies.activity !== undefined) app.register(registerActivityRoutes(dependencies.activity));
  if (dependencies.recipePreferences !== undefined) app.register(registerRecipePreferenceRoutes(dependencies.recipePreferences));
  if (dependencies.dietProfile !== undefined) app.register(registerDietProfileRoutes(dependencies.dietProfile));
  if (dependencies.recipeNutrition !== undefined) app.register(registerRecipeNutritionRoutes(dependencies.recipeNutrition));
  if (dependencies.aiRecipes !== undefined) app.register(registerAiRecipeRoutes(dependencies.aiRecipes));
  if (dependencies.house !== undefined) app.register(registerHouseRoutes(dependencies.house));
  if (dependencies.dinnerDiary !== undefined) app.register(registerDinnerDiaryRecipeRoutes(dependencies.dinnerDiary));
  if (dependencies.dinnerConsumption !== undefined) app.register(registerDinnerConsumptionRoutes(dependencies.dinnerConsumption));
  if (dependencies.bring !== undefined) app.register(registerBringRoutes(dependencies.bring));
  if (dependencies.pantryCandidates !== undefined) app.register(registerPantryCandidateRoutes(dependencies.pantryCandidates));
  app.register(async (s2sScope) => {
    s2sScope.setNotFoundHandler((_request, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(404).send({ code: 'not_found' });
    });
    if (dependencies.s2sDinnerContext !== undefined) {
      s2sScope.register(registerS2sDinnerContextRoutes(dependencies.s2sDinnerContext));
    }
  }, { prefix: '/v1/s2s' });
  return app;
};
