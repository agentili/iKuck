import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { SyncMutation } from '@ikuck/shared/contracts';
import type { AuthService } from '../auth/service.js';
import { ensureCsrf, ensureSameOrigin, requireSession } from './auth.js';
import type { SyncRepository } from '../sync/repository.js';

export interface SyncRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const mutationSchema = z.object({
  mutationId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  entityType: z.enum(['pantry_item', 'staple_preference']),
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
      await repository.applyMutation(session.userId, mutation);
    }

    const changes = await repository.readChanges(session.userId, body.cursor, 200);
    return {
      changes,
      nextCursor: changes.reduce((cursor, change) => Math.max(cursor, change.serverSequence), body.cursor),
    };
  });
};
