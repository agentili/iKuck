import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { ensureCsrf, ensureSameOrigin, requireSession } from './auth.js';
import type { SyncRepository } from '../sync/repository.js';
import { syncMutationSchema } from '../sync/validation.js';

export interface SyncRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const syncSchema = z.object({
  deviceId: z.string().min(1).max(128),
  cursor: z.number().int().min(0),
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

export const registerSyncRoutes = ({ repository, authService, appOrigin }: SyncRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/sync', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const parsedBody = syncSchema.safeParse(request.body);
    if (!parsedBody.success) throw new SyncPayloadError();
    const body = parsedBody.data;
    if (body.mutations.some((mutation) => mutation.deviceId !== body.deviceId)) {
      throw new SyncPayloadError();
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
