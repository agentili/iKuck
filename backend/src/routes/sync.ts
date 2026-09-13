import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { SyncMutation } from '@ikuck/shared/contracts';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { ensureCsrf, ensureSameOrigin, requireSession } from './auth.js';
import type { SyncRepository } from '../sync/repository.js';
import { isPantryLot } from '../pantry/validation.js';
import { isShoppingListItem } from '../shopping/validation.js';
import { isCookEvent, isRecipePreference } from '../activity/validation.js';
import { isDietProfile } from '../diet/validation.js';
import { isAiConsent, isGeneratedRecipe } from '../ai/validation.js';

export interface SyncRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const mutationSchema = z.object({
  mutationId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  entityType: z.enum([
    'pantry_item',
    'pantry_lot',
    'staple_preference',
    'shopping_list_item',
    'cook_event',
    'recipe_preference',
    'diet_profile',
    'ai_consent',
    'generated_recipe',
  ]),
  entityId: z.string().min(1).max(128),
  operation: z.enum(['upsert', 'delete']),
  payload: z.unknown().nullable(),
  clientUpdatedAt: z.string().datetime({ offset: true }),
});

const syncSchema = z.object({
  deviceId: z.string().min(1).max(128),
  cursor: z.number().int().min(0),
  mutations: z.array(mutationSchema).max(100),
});

export const registerSyncRoutes = ({ repository, authService, appOrigin }: SyncRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/sync', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const body = syncSchema.parse(request.body) as {
      deviceId: string;
      cursor: number;
      mutations: SyncMutation[];
    };
    if (body.mutations.some((mutation) => mutation.deviceId !== body.deviceId)) {
      throw new Error('Mutation device does not match request device');
    }

    for (const mutation of body.mutations) {
      if (mutation.entityType === 'pantry_lot' && mutation.operation === 'upsert'
        && (!isPantryLot(mutation.payload) || mutation.payload.id !== mutation.entityId)) {
        throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
      }
      if (mutation.entityType === 'shopping_list_item' && mutation.operation === 'upsert'
        && (!isShoppingListItem(mutation.payload) || mutation.payload.id !== mutation.entityId)) {
        throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
      }
      if (mutation.entityType === 'cook_event' && mutation.operation === 'upsert'
        && (!isCookEvent(mutation.payload) || mutation.payload.id !== mutation.entityId)) {
        throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
      }
      if (mutation.entityType === 'recipe_preference' && mutation.operation === 'upsert'
        && (!isRecipePreference(mutation.payload) || mutation.payload.recipeId !== mutation.entityId)) {
        throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
      }
      if (mutation.entityType === 'diet_profile'
        && (mutation.entityId !== 'profile'
          || (mutation.operation === 'upsert' && !isDietProfile(mutation.payload)))) {
        throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
      }
      if (mutation.entityType === 'ai_consent'
        && (mutation.entityId !== 'profile'
          || (mutation.operation === 'upsert' && !isAiConsent(mutation.payload)))) {
        throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
      }
      if (mutation.entityType === 'generated_recipe'
        && (mutation.operation === 'upsert'
          && (!isGeneratedRecipe(mutation.payload) || mutation.payload.id !== mutation.entityId))) {
        throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
      }
    }

    for (const mutation of body.mutations) {
      await repository.applyMutation(session.userId, mutation);
    }

    const changes = await repository.readChanges(session.userId, body.cursor, 200);
    return {
      changes,
      nextCursor: changes.reduce((cursor, change) => Math.max(cursor, change.serverSequence), body.cursor),
    };
  });
};
