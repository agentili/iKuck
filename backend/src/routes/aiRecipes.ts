import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AiConsent, DietProfilePayload, GeneratedRecipe, GeneratedRecipeDraft, SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { isGeneratedRecipeCompatible, isAiConsent, isGeneratedRecipe, parseGeneratedRecipeDraft, generatedRecipeSchema } from '../ai/validation.js';
import type { GenerationRateLimiter, GenerationRateReservation } from '../ai/rateLimit.js';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { dietProfilePayloadSchema } from '../diet/validation.js';
import type { RecipeGenerationProvider } from '../providers/types.js';
import type { SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface AiRecipeRouteDependencies {
  provider: RecipeGenerationProvider;
  limiter: GenerationRateLimiter;
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const consentRequestSchema = z.object({ enabled: z.boolean() }).strict();

const saveRequestSchema = z.object({ recipe: generatedRecipeSchema }).strict();

const generationRequestSchema = z.object({
  ingredients: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  constraints: z.array(z.string().trim().min(1).max(240)).max(20),
  dietProfile: dietProfilePayloadSchema,
}).strict();

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');

const defaultConsent = (): AiConsent => ({ enabled: false, updatedAt: new Date().toISOString() });

const readConsent = async (repository: SyncRepository, userId: string): Promise<AiConsent> => {
  const stored = await repository.readEntity(userId, 'ai_consent', 'profile');
  return stored !== null && !stored.deleted && isAiConsent(stored.payload) ? stored.payload : defaultConsent();
};

const readRecipes = async (repository: SyncRepository, userId: string): Promise<GeneratedRecipe[]> => {
  const changes = await repository.readAll(userId);
  return changes
    .filter((change): change is SyncChange & { payload: GeneratedRecipe } => (
      change.entityType === 'generated_recipe'
      && change.operation === 'upsert'
      && isGeneratedRecipe(change.payload)
    ))
    .map((change) => change.payload)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

const readRecipe = async (repository: SyncRepository, userId: string, recipeId: string): Promise<GeneratedRecipe | null> => {
  const stored = await repository.readEntity(userId, 'generated_recipe', recipeId);
  return stored !== null && !stored.deleted && isGeneratedRecipe(stored.payload) ? stored.payload : null;
};

const createMutation = (
  entityType: Extract<SyncMutation['entityType'], 'ai_consent' | 'generated_recipe'>,
  entityId: string,
  operation: SyncMutation['operation'],
  payload: AiConsent | GeneratedRecipe | null,
  clientUpdatedAt: string,
): SyncMutation => ({
  mutationId: randomUUID(),
  deviceId: 'api-ai-recipes',
  entityType,
  entityId,
  operation,
  payload: operation === 'delete' ? null : payload,
  clientUpdatedAt,
});

const parseConsent = (body: unknown): boolean => {
  const result = consentRequestSchema.safeParse(body);
  if (!result.success) throw invalidPayload();
  return result.data.enabled;
};

const parseSavableRecipe = (body: unknown): GeneratedRecipe => {
  const result = saveRequestSchema.safeParse(body);
  if (!result.success) throw invalidPayload();
  return result.data.recipe;
};

const reserveGeneration = async (limiter: GenerationRateLimiter, userId: string): Promise<GenerationRateReservation> => {
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

export const registerAiRecipeRoutes = ({
  provider,
  limiter,
  repository,
  authService,
  appOrigin,
}: AiRecipeRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/ai-recipes/consent', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return { consent: await readConsent(repository, session.userId) };
  });

  app.put('/v1/ai-recipes/consent', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const now = new Date().toISOString();
    const consent: AiConsent = { enabled: parseConsent(request.body), updatedAt: now };
    await repository.applyMutation(session.userId, createMutation('ai_consent', 'profile', 'upsert', consent, now));
    return { consent: await readConsent(repository, session.userId) };
  });

  app.get('/v1/ai-recipes', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return { recipes: await readRecipes(repository, session.userId) };
  });

  app.post('/v1/ai-recipes', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const parsed = generationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw invalidPayload();

    const consent = await readConsent(repository, session.userId);
    if (!consent.enabled) throw new AuthServiceError('ai_consent_required', 403, 'AI recipe consent is required');

    let reservation: GenerationRateReservation;
    try {
      reservation = await reserveGeneration(limiter, session.userId);
    } catch {
      throw new AuthServiceError('provider_unavailable', 503, 'AI recipe provider is unavailable');
    }
    const { quota } = reservation;
    if (!quota.allowed) {
      throw new AuthServiceError('ai_daily_limit_reached', 429, 'Daily AI recipe limit reached');
    }

    let draft: GeneratedRecipeDraft | null;
    try {
      draft = parseGeneratedRecipeDraft(await provider.generate({
        ingredients: parsed.data.ingredients,
        constraints: parsed.data.constraints,
        dietProfile: parsed.data.dietProfile as DietProfilePayload,
      }));
    } catch {
      await releaseGeneration(reservation);
      throw new AuthServiceError('provider_unavailable', 503, 'AI recipe provider is unavailable');
    }
    if (draft === null) {
      await releaseGeneration(reservation);
      throw new AuthServiceError('provider_unavailable', 503, 'AI recipe provider is unavailable');
    }
    if (!isGeneratedRecipeCompatible(draft, parsed.data.dietProfile)) {
      await releaseGeneration(reservation);
      throw new AuthServiceError('ai_recipe_incompatible', 422, 'Generated recipe does not match the active dietary profile');
    }

    const now = new Date().toISOString();
    const recipe: GeneratedRecipe = {
      ...draft,
      id: randomUUID(),
      source: 'ai',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await reservation.commit();
    } catch (error) {
      await releaseGeneration(reservation);
      throw error;
    }
    return reply.code(201).send({ recipe, quota });
  });

  app.post('/v1/ai-recipes/save', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const recipe = parseSavableRecipe(request.body);
    const now = new Date().toISOString();
    await repository.applyMutation(session.userId, createMutation('generated_recipe', recipe.id, 'upsert', recipe, now));
    return { recipe };
  });

  app.delete('/v1/ai-recipes/:recipeId', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const recipeId = (request.params as { recipeId: string }).recipeId;
    const existing = await readRecipe(repository, session.userId, recipeId);
    if (existing !== null) {
      const now = new Date().toISOString();
      await repository.applyMutation(session.userId, createMutation('generated_recipe', recipeId, 'delete', null, now));
    }
    return reply.code(204).send();
  });
};
