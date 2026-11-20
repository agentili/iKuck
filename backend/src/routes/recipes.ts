import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  AiRecipeProvider,
  DietProfilePayload,
  GeneratedRecipeDraft,
  PantryIngredientReview,
  SyncChange,
  SyncMutationScope,
} from '@ikuck/shared/contracts';
import { AI_RECIPE_MAX_GENERATION_INGREDIENTS, RECIPE_MAX_INGREDIENTS } from '@ikuck/shared/limits';
import { RECIPES } from '@ikuck/shared/recipeCatalog';
import { getIngredient } from '@ikuck/shared/ingredients';
import { CHEF_PREPARATION_RULES, renderChefPreparation } from '../ai/chefPreparation.js';
import { chefCoverage, chefIngredientIdentity, evaluatePantryRecipeDraft, evaluateProviderPantryRecipeDraft, reviewPantryIngredients } from '../ai/pantryRecipe.js';
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
import { AiConsentRequiredError, SyncMembershipRequiredError, SyncScopeInvalidError, type SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';
import type { RecipeGenerationProvider } from '../providers/types.js';

const generationRequestSchema = z.object({
  ingredients: z
    .array(z.string().trim().min(1).max(120))
    .min(1)
    .max(AI_RECIPE_MAX_GENERATION_INGREDIENTS),
  dietProfile: dietProfilePayloadSchema,
  mode: z.literal('chef_coverage').optional(),
  confirmedReferences: z.literal(true).optional(),
  syncScope: z.custom<SyncMutationScope>((value) => typeof value === 'string' && /^(account|house):[^\s:]{1,128}$/.test(value)).optional(),
}).strict().refine(({ mode, confirmedReferences, syncScope }) => mode === 'chef_coverage'
  ? confirmedReferences === true && syncScope !== undefined
  : confirmedReferences === undefined && syncScope === undefined);

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
    const strictCoverage = parsed.data.mode === 'chef_coverage';
    if (strictCoverage && new Set(ingredients.map(chefIngredientIdentity)).size > RECIPE_MAX_INGREDIENTS + 1) {
      return { kind: 'none_available', message: 'La dispensa supera il numero di ingredienti utilizzabili in una singola ricetta.' };
    }

    let savedRecipes: { title: string; ingredients: { name: string; amount: string }[] }[];
    try {
      const changes = await repository.readAll(session.userId, parsed.data.syncScope);
      savedRecipes = changes
        .filter(isSavedRecipeReference)
        .map((change) => change.payload);
    } catch (error) {
      if (error instanceof SyncMembershipRequiredError || error instanceof SyncScopeInvalidError) {
        throw new AuthServiceError('sync_scope_changed', 409, 'The active pantry scope changed');
      }
      throw new AuthServiceError('provider_unavailable', 503, 'Saved recipes are unavailable');
    }

    const knownReferences: RecipeReference[] = uniqueRecipeReferences([
      ...savedRecipes.map(({ title, ingredients }) => ({ title, ingredients })),
      ...(strictCoverage ? RECIPES.map(({ title, ingredients }) => ({
        title,
        ingredients: ingredients.map(({ name, amount, ingredientId }) => ({ name: name ?? getIngredient(ingredientId)?.label ?? ingredientId, amount })),
      })) : []),
    ]);
    if (strictCoverage && knownReferences.length > MAX_NOVELTY_REFERENCES_IN_PROMPT) {
      return { kind: 'none_available', message: 'Il ricettario è troppo grande per essere inviato per intero al servizio AI.' };
    }

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
    let ingredientReview: PantryIngredientReview | null = null;
    let noveltyConflict: ReturnType<typeof findRecipeNoveltyConflict> = null;
    const rejectedRecipes: RecipeReference[] = [];
    let partial: { recipe: GeneratedRecipeDraft; review: PantryIngredientReview; omitted: string } | null = null;
    const requestAbort = createReplyAbortSignal(reply);
    try {
      for (let attempt = 0; attempt < MAX_NOVELTY_GENERATION_ATTEMPTS; attempt += 1) {
        const existingRecipes = strictCoverage ? knownReferences : uniqueRecipeReferences([
          ...rejectedRecipes.slice(-10),
          ...knownReferences.slice(0, MAX_NOVELTY_REFERENCES_IN_PROMPT),
        ]).slice(0, MAX_NOVELTY_REFERENCES_IN_PROMPT);

        draft = await repository.withAiConsentDispatch(session.userId, { kind: 'home', provider: recipeProvider }, async () => {
          try {
            const generated = await provider.generate({
              ingredients,
              constraints: strictCoverage ? [
                'Usa tutti gli ingredienti distinti della dispensa, oppure omettine al massimo uno. Non aggiungere ingredienti fuori elenco. Usa ogni ingrediente dichiarato nel procedimento.',
                'La ricetta deve essere diversa da tutte quelle indicate e rispettare dieta e allergeni.',
                ...CHEF_PREPARATION_RULES,
              ] : [],
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

        if (strictCoverage) {
          const coverage = chefCoverage(ingredients, draft);
          const preparation = coverage === null ? null : renderChefPreparation(draft);
          const evaluated = preparation === null ? null : evaluateProviderPantryRecipeDraft(ingredients, preparation, dietProfile);
          if (coverage !== null && evaluated?.recipe != null
            && isGeneratedRecipeCompatible(evaluated.recipe, dietProfile)
            && findRecipeNoveltyConflict(evaluated.recipe, knownReferences) === null) {
            if (coverage.omitted === undefined) {
              draft = evaluated.recipe;
              ingredientReview = evaluated.ingredientReview;
              partial = null;
              break;
            }
            partial ??= { recipe: evaluated.recipe, review: evaluated.ingredientReview, omitted: coverage.omitted };
          }
          draft = null;
          continue;
        }

        if (!isGeneratedRecipeCompatible(draft, dietProfile)) {
          throw new AuthServiceError('ai_recipe_incompatible', 422, 'Generated recipe does not match the active dietary profile');
        }

        const providerEvaluation = evaluateProviderPantryRecipeDraft(ingredients, draft, dietProfile);
        if (providerEvaluation.recipe === null) {
          draft = null;
          noveltyConflict = null;
          break;
        }
        draft = providerEvaluation.recipe;
        ingredientReview = providerEvaluation.ingredientReview;

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
      if (strictCoverage) {
        await releaseGeneration(reservation);
        if (error instanceof AiConsentRequiredError) throw new AuthServiceError('ai_consent_required', 403, 'Valid AI recipe consent is required');
        if (code === 'ai_dispatch_aborted' || code === 'ai_dispatch_capacity') throw new AuthServiceError('provider_unavailable', 503, 'Recipe provider is unavailable');
        throw error;
      }
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

    if (strictCoverage && draft === null && partial !== null) {
      draft = partial.recipe;
      ingredientReview = partial.review;
    }

    if (!strictCoverage && (draft === null || noveltyConflict !== null)) {
      const fallback = evaluatePantryRecipeDraft(ingredients, knownReferences, Math.random, dietProfile);
      ingredientReview = fallback.ingredientReview;
      draft = fallback.recipe === null ? null : parseGeneratedRecipeDraft(fallback.recipe);
      if (draft !== null && !isGeneratedRecipeCompatible(draft, dietProfile)) draft = null;
      noveltyConflict = null;
    }

    if (draft === null) {
      await releaseGeneration(reservation);
      return {
        kind: 'none_available',
        message: strictCoverage ? 'Non ho trovato una ricetta nuova che usi tutti gli ingredienti o tutti tranne uno.' : 'Non ho trovato ingredienti sufficienti per proporre una ricetta nuova.',
        ingredientReview: ingredientReview ?? reviewPantryIngredients(ingredients, dietProfile),
      };
    }

    if (noveltyConflict !== null) {
      await releaseGeneration(reservation);
      return {
        kind: 'none_available',
        message: 'Non sono riuscito a creare una ricetta diversa da quelle già nel ricettario.',
        ingredientReview: ingredientReview ?? reviewPantryIngredients(ingredients, dietProfile),
      };
    }

    try {
      await reservation.commit();
    } catch (error) {
      await releaseGeneration(reservation);
      throw error;
    }

    return {
      kind: 'candidate',
      recipe: draft,
      ...(partial === null ? {} : { omittedIngredient: partial.omitted }),
      ingredientReview: ingredientReview ?? reviewPantryIngredients(ingredients, dietProfile),
    };
  });
};
