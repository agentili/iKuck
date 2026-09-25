import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { SyncMutation } from '@ikuck/shared/contracts';
import type { AuthService } from '../auth/service.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';
import { syncMutationSchema } from '../sync/validation.js';
import { isSharedEntityType, SyncScopeInvalidError, type SyncRepository } from '../sync/repository.js';

export interface SyncRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const syncSchema = z.object({
  deviceId: z.string().min(1).max(128),
  cursor: z.number().int().min(0),
  syncScope: z.string().regex(/^(account|house):[^:]+$/).optional(),
  mutations: z.array(syncMutationSchema).max(100),
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
    };
    if (body.mutations.some((mutation) => isSharedEntityType(mutation.entityType) && mutation.syncScope === undefined)) {
      throw new SyncScopeRequiredError();
    }
    if (body.mutations.some((mutation) => mutation.syncScope?.startsWith('house:') && !isSharedEntityType(mutation.entityType))) {
      throw new SyncScopeInvalidError();
    }
    if (body.mutations.some((mutation) => mutation.deviceId !== body.deviceId)) {
      throw new SyncPayloadError();
    }

    for (const mutation of body.mutations) {
      await repository.applyMutation(session.userId, mutation);
    }

    const changes = await repository.readChanges(session.userId, body.cursor, 200, body.syncScope);
    return {
      changes,
      nextCursor: changes.reduce((cursor, change) => Math.max(cursor, change.serverSequence), body.cursor),
    };
  });
};
