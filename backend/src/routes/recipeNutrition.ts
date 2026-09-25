import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { estimateRecipeNutrition, type RecipeNutritionLookup } from '../nutrition/recipeNutrition.js';
import type { NutritionProvider } from '../providers/types.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface RecipeNutritionRouteDependencies {
  provider: NutritionProvider;
  authService: AuthService;
  appOrigin: string;
}

const lookupSchema = z.object({
  query: z.string().trim().min(1).max(120),
  grams: z.number().finite().positive().nullable(),
}).strict();

const requestSchema = z.object({
  ingredients: z.array(lookupSchema).min(1).max(30),
}).strict();

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');

export const registerRecipeNutritionRoutes = ({ provider, authService, appOrigin }: RecipeNutritionRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/recipes/nutrition', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) throw invalidPayload();

    try {
      return { nutrition: await estimateRecipeNutrition(parsed.data.ingredients as RecipeNutritionLookup[], provider) };
    } catch {
      throw new AuthServiceError('provider_unavailable', 503, 'Nutrition provider is unavailable');
    }
  });
};
