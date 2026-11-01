import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SYNC_ENTITY_TYPES } from '@ikuck/shared/contracts';
import type { SyncMutation } from '@ikuck/shared/contracts';
import type { AuthService } from '../auth/service.js';
import type { AuthRateLimiter } from '../auth/rateLimit.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';
import { syncMutationSchema } from '../sync/validation.js';
import { PlanCommandRequiredError } from '../mealPlan/validation.js';
import { MealPlanCapabilityUnavailableError } from './mealPlan.js';
import { isSharedEntityType, SyncScopeInvalidError, type SyncRepository } from '../sync/repository.js';

export interface SyncRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
  rateLimiter?: AuthRateLimiter;
}

const legacyEntityTypes = [
  'pantry_item', 'pantry_lot', 'staple_preference', 'shopping_list_item', 'cook_event',
  'recipe_preference', 'diet_profile', 'ai_consent', 'generated_recipe', 'dinner_entry', 'saved_recipe',
] as const satisfies readonly SyncMutation['entityType'][];

const syncSchema = z.object({
  deviceId: z.string().min(1).max(128),
  cursor: z.number().int().min(0),
  syncScope: z.string().regex(/^(account|house):[^:]+$/).optional(),
  mutations: z.array(syncMutationSchema).max(100),
  supportedEntityTypes: z.array(z.enum(SYNC_ENTITY_TYPES)).max(SYNC_ENTITY_TYPES.length).optional(),
  mealPlanReadVersion: z.literal(2).optional(),
});

export class SyncPayloadError extends Error {
  readonly code = 'INVALID_SYNC_PAYLOAD';
  readonly status = 400;

  constructor() {
    super('Request payload is invalid');
    this.name = 'SyncPayloadError';
  }
}

export class SyncScopeRequiredError extends Error {
  readonly code = 'sync_scope_required';
  readonly status = 400;

  constructor() {
    super('A scope is required for shared data mutations');
    this.name = 'SyncScopeRequiredError';
  }
}

export const registerSyncRoutes = ({ repository, authService, appOrigin }: SyncRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/sync', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const parsedBody = syncSchema.safeParse(request.body);
    if (!parsedBody.success) throw new SyncPayloadError();
    const body = parsedBody.data as unknown as {
      deviceId: string;
      cursor: number;
      syncScope?: SyncMutation['syncScope'];
      mutations: SyncMutation[];
      supportedEntityTypes?: SyncMutation['entityType'][];
      mealPlanReadVersion?: 2;
    };
    if (body.mutations.some((mutation) => mutation.entityType === 'meal_plan_entry')) throw new PlanCommandRequiredError();
    if (body.mealPlanReadVersion === 2 && !await repository.isMealPlanV2Enabled()) throw new MealPlanCapabilityUnavailableError();
    if (body.mutations.some((mutation) => isSharedEntityType(mutation.entityType) && mutation.syncScope === undefined)) {
      throw new SyncScopeRequiredError();
    }
    if (body.mutations.some((mutation) => mutation.syncScope?.startsWith('house:') && !isSharedEntityType(mutation.entityType))) {
      throw new SyncScopeInvalidError();
    }
    const requestedEntityTypes = body.supportedEntityTypes ?? (body.mealPlanReadVersion === 2
      ? [...legacyEntityTypes, 'meal_plan_entry' as const]
      : legacyEntityTypes);
    const supportedEntityTypes = requestedEntityTypes.filter((type) => type !== 'meal_plan_entry' || body.mealPlanReadVersion === 2);
    // Server-generated legacy defaults mix personal and shared entity types; only a client-declared list is a scope claim.
    const validateSupportedTypesForScope = body.supportedEntityTypes !== undefined;
    if (body.syncScope !== undefined) {
      await repository.readChanges(session.userId, body.cursor, 1, body.syncScope, supportedEntityTypes, validateSupportedTypesForScope);
    }
    if (body.mutations.some((mutation) => mutation.deviceId !== body.deviceId)) {
      throw new SyncPayloadError();
    }

    for (const mutation of body.mutations) {
      await repository.applyMutation(session.userId, mutation);
    }

    const changes = await repository.readChanges(session.userId, body.cursor, 200, body.syncScope, supportedEntityTypes, validateSupportedTypesForScope);
    return {
      changes,
      nextCursor: changes.reduce((cursor, change) => Math.max(cursor, change.serverSequence), body.cursor),
    };
  });
};
