import type { FastifyPluginAsync } from 'fastify';
import type { DietProfile, DietProfilePayload } from '@ikuck/shared/contracts';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { ensureCsrf, ensureSameOrigin, requireSession } from './auth.js';
import type { SyncRepository } from '../sync/repository.js';
import { DEFAULT_DIET_PROFILE, isDietProfile, parseDietProfilePayload } from '../diet/validation.js';

export interface DietProfileRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const defaultProfile = (): DietProfile => ({
  ...DEFAULT_DIET_PROFILE,
  excludedAllergens: [...DEFAULT_DIET_PROFILE.excludedAllergens],
  nutrition: { ...DEFAULT_DIET_PROFILE.nutrition },
  updatedAt: new Date().toISOString(),
});

const createMutationId = (): string => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const readProfile = async (repository: SyncRepository, userId: string): Promise<DietProfile> => {
  const stored = await repository.readEntity(userId, 'diet_profile', 'profile');
  return stored !== null && !stored.deleted && isDietProfile(stored.payload) ? stored.payload : defaultProfile();
};

const parsePayload = (value: unknown): DietProfilePayload => {
  const parsed = parseDietProfilePayload(value);
  if (parsed === null) throw new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
  return parsed;
};

export const registerDietProfileRoutes = ({ repository, authService, appOrigin }: DietProfileRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/profile/preferences', async (request) => {
    const { session } = await requireSession(request, authService);
    return { profile: await readProfile(repository, session.userId) };
  });

  app.put('/v1/profile/preferences', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const updatedAt = new Date().toISOString();
    const profile: DietProfile = { ...parsePayload(request.body), updatedAt };
    await repository.applyMutation(session.userId, {
      mutationId: createMutationId(),
      deviceId: `api:${session.userId}`,
      entityType: 'diet_profile',
      entityId: 'profile',
      operation: 'upsert',
      payload: profile,
      clientUpdatedAt: updatedAt,
    });
    return { profile: await readProfile(repository, session.userId) };
  });
};
