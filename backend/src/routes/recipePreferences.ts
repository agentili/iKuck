import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { RecipePreference, RecipePreferencePayload, SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { isEmptyRecipePreference, isRecipePreference, parseRecipePreferenceDetails } from '../activity/validation.js';
import type { SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface RecipePreferenceRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');

const parseDetails = (body: unknown): RecipePreferencePayload => {
  const details = parseRecipePreferenceDetails(body);
  if (details === null) throw invalidPayload();
  return details;
};

const readPreferences = async (repository: SyncRepository, userId: string): Promise<RecipePreference[]> => {
  const changes = await repository.readAll(userId);
  return changes
    .filter((change): change is SyncChange & { payload: RecipePreference } => (
      change.entityType === 'recipe_preference'
      && change.operation === 'upsert'
      && isRecipePreference(change.payload)
    ))
    .map((change) => change.payload)
    .sort((left, right) => left.recipeId.localeCompare(right.recipeId));
};

const createMutation = (preference: RecipePreference, operation: SyncMutation['operation']): SyncMutation => ({
  mutationId: randomUUID(),
  deviceId: 'api-resource',
  entityType: 'recipe_preference',
  entityId: preference.recipeId,
  operation,
  payload: operation === 'delete' ? null : preference,
  clientUpdatedAt: operation === 'delete' ? new Date().toISOString() : preference.updatedAt,
});

const readPreference = async (repository: SyncRepository, userId: string, recipeId: string): Promise<RecipePreference | null> => {
  const stored = await repository.readEntity(userId, 'recipe_preference', recipeId);
  if (stored === null || stored.deleted || !isRecipePreference(stored.payload)) return null;
  return stored.payload;
};

export const registerRecipePreferenceRoutes = ({ repository, authService, appOrigin }: RecipePreferenceRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/recipes/preferences', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return { preferences: await readPreferences(repository, session.userId) };
  });

  app.put('/v1/recipes/preferences/:recipeId', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const recipeId = (request.params as { recipeId: string }).recipeId;
    const details = parseDetails(request.body);
    if (details.recipeId !== recipeId) throw invalidPayload();
    const existing = await readPreference(repository, session.userId, recipeId);
    if (isEmptyRecipePreference(details)) {
      if (existing !== null) await repository.applyMutation(session.userId, createMutation(existing, 'delete'));
      return reply.code(204).send();
    }
    const now = new Date().toISOString();
    const preference: RecipePreference = {
      ...details,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await repository.applyMutation(session.userId, createMutation(preference, 'upsert'));
    return { preference: (await readPreference(repository, session.userId, recipeId)) ?? preference };
  });

  app.delete('/v1/recipes/preferences/:recipeId', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const recipeId = (request.params as { recipeId: string }).recipeId;
    const existing = await readPreference(repository, session.userId, recipeId);
    if (existing !== null) await repository.applyMutation(session.userId, createMutation(existing, 'delete'));
    return reply.code(204).send();
  });
};
