import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AiRecipeProvider, DietProfilePayload, GeneratedRecipeDraft, SyncChange } from '@ikuck/shared/contracts';
import { AI_RECIPE_MAX_GENERATION_INGREDIENTS } from '@ikuck/shared/limits';
import { generatePantryRecipeDraft } from '../ai/pantryRecipe.js';
import {
  MAX_NOVELTY_GENERATION_ATTEMPTS,
  MAX_NOVELTY_REFERENCES_IN_PROMPT,
  findRecipeNoveltyConflict,
  recipeReferenceKey,
  type RecipeReference,
} from '../ai/recipeNovelty.js';
import type { GenerationRateLimiter, GenerationRateReservation } from '../ai/rateLimit.js';
import { isGeneratedRecipeCompatible, parseGeneratedRecipeDraft } from '../ai/validation.js';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { dietProfilePayloadSchema } from '../diet/validation.js';
import { AiConsentRequiredError, type SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';
import type { RecipeGenerationProvider } from '../providers/types.js';

const generationRequestSchema = z.object({
  ingredients: z
    .array(z.string().trim().min(1).max(120))
    .min(1)
    .max(AI_RECIPE_MAX_GENERATION_INGREDIENTS),
  dietProfile: dietProfilePayloadSchema,
}).strict();

const invalidPayload = (): AuthServiceError =>
  new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');

const reserveGeneration = async (
  limiter: GenerationRateLimiter,
  userId: string,
): Promise<GenerationRateReservation> => {
  if (limiter.reserve !== undefined) return limiter.reserve(userId);
  const quota = await limiter.consume(userId);
  return {
    quota,
    commit: async () => undefined,
    release: async () => undefined,
  };
};

const releaseGeneration = async (reservation: GenerationRateReservation): Promise<void> => {
  await reservation.release().catch(() => undefined);
};

const createReplyAbortSignal = (reply: FastifyReply): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const abortOnClose = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  reply.raw.once('close', abortOnClose);
  return {
    signal: controller.signal,
    dispose: () => reply.raw.off('close', abortOnClose),
  };
};

const uniqueRecipeReferences = (recipes: RecipeReference[]): RecipeReference[] => {
  const seen = new Set<string>();
  return recipes.filter((recipe) => {
    const key = recipeReferenceKey(recipe);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const isSavedRecipeReference = (
  change: SyncChange,
): change is SyncChange & { payload: { title: string; ingredients: { name: string; amount: string }[] } } =>
  (change.entityType === 'generated_recipe' || change.entityType === 'saved_recipe')
  && change.operation === 'upsert'
  && change.payload !== null
  && typeof change.payload === 'object'
  && 'title' in change.payload
  && typeof change.payload.title === 'string'
  && 'ingredients' in change.payload
  && Array.isArray(change.payload.ingredients);

export interface RecipeRouteDependencies {
  provider: RecipeGenerationProvider;
  recipeProvider: AiRecipeProvider;
  limiter: GenerationRateLimiter;
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

export const registerRecipeRoutes = ({
  provider,
  recipeProvider,
  limiter,
  repository,
  authService,
  appOrigin,
}: RecipeRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/recipes/generate', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);

    const parsed = generationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw invalidPayload();

    const ingredients = parsed.data.ingredients;
    const dietProfile = parsed.data.dietProfile as DietProfilePayload;

    let savedRecipes: { title: string; ingredients: { name: string; amount: string }[] }[];
    try {
      const changes = await repository.readAll(session.userId);
      savedRecipes = changes
        .filter(isSavedRecipeReference)
        .map((change) => change.payload);
    } catch {
      throw new AuthServiceError('provider_unavailable', 503, 'Saved recipes are unavailable');
    }

    const knownReferences: RecipeReference[] = uniqueRecipeReferences(
      savedRecipes.map(({ title, ingredients }) => ({ title, ingredients })),
    );

    let reservation: GenerationRateReservation;
    try {
      reservation = await reserveGeneration(limiter, session.userId);
    } catch {
      throw new AuthServiceError('provider_unavailable', 503, 'Recipe provider is unavailable');
    }
    const { quota } = reservation;
    if (!quota.allowed) {
      throw new AuthServiceError('ai_daily_limit_reached', 429, 'Daily recipe limit reached');
    }

    let draft: GeneratedRecipeDraft | null = null;
    let noveltyConflict: ReturnType<typeof findRecipeNoveltyConflict> = null;
    const rejectedRecipes: RecipeReference[] = [];
    const requestAbort = createReplyAbortSignal(reply);
    try {
      for (let attempt = 0; attempt < MAX_NOVELTY_GENERATION_ATTEMPTS; attempt += 1) {
        const existingRecipes = uniqueRecipeReferences([
          ...rejectedRecipes.slice(-10),
          ...knownReferences.slice(0, MAX_NOVELTY_REFERENCES_IN_PROMPT),
        ]).slice(0, MAX_NOVELTY_REFERENCES_IN_PROMPT);

        draft = await repository.withAiConsentDispatch(session.userId, { kind: 'home', provider: recipeProvider }, async () => {
          try {
            const generated = await provider.generate({
              ingredients,
              constraints: [],
              dietProfile,
              existingRecipes,
              signal: requestAbort.signal,
            });
            const validated = parseGeneratedRecipeDraft(generated);
            if (validated === null) throw new Error('Recipe provider returned an invalid draft');
            return validated;
          } catch {
            throw new AuthServiceError('provider_unavailable', 503, 'Recipe provider is unavailable');
          }
        }, requestAbort.signal);

        if (draft === null) {
          throw new AuthServiceError('provider_unavailable', 503, 'Recipe provider is unavailable');
        }

        if (!isGeneratedRecipeCompatible(draft, dietProfile)) {
          throw new AuthServiceError('ai_recipe_incompatible', 422, 'Generated recipe does not match the active dietary profile');
        }

        noveltyConflict = findRecipeNoveltyConflict(draft, knownReferences);
        if (noveltyConflict === null) break;
        rejectedRecipes.push({ title: draft.title, ingredients: draft.ingredients });
      }
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      const canUseLocalFallback = error instanceof AiConsentRequiredError
        || error instanceof AuthServiceError && error.code === 'provider_unavailable'
        || code === 'ai_dispatch_capacity';
      if (canUseLocalFallback) {
        draft = null;
        noveltyConflict = null;
      } else {
        await releaseGeneration(reservation);
        if (code === 'ai_dispatch_aborted') {
          throw new AuthServiceError('provider_unavailable', 503, 'Recipe provider is unavailable');
        }
        throw error;
      }
    } finally {
      requestAbort.dispose();
    }

    if (draft === null || noveltyConflict !== null) {
      const fallback = generatePantryRecipeDraft(ingredients, knownReferences, Math.random, dietProfile);
      draft = fallback === null ? null : parseGeneratedRecipeDraft(fallback);
      if (draft !== null && !isGeneratedRecipeCompatible(draft, dietProfile)) draft = null;
      noveltyConflict = null;
    }

    if (draft === null) {
      await releaseGeneration(reservation);
      return {
        kind: 'none_available',
        message: 'Non ho trovato ingredienti sufficienti per proporre una ricetta nuova.',
      };
    }

    if (noveltyConflict !== null) {
      await releaseGeneration(reservation);
      return {
        kind: 'none_available',
        message: 'Non sono riuscito a creare una ricetta diversa da quelle già nel ricettario.',
      };
    }

    try {
      await reservation.commit();
    } catch (error) {
      await releaseGeneration(reservation);
      throw error;
    }

    return { kind: 'candidate', recipe: draft };
  });
};
