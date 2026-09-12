import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { clearSessionCookie, ensureCsrf, ensureSameOrigin, requireSession } from './auth.js';
import type { ProfileRepository } from '../profile/repository.js';

export interface ProfileRouteDependencies {
  repository: ProfileRepository;
  authService: AuthService;
  appOrigin: string;
  secureCookies: boolean;
}

const profileSchema = z.object({ displayName: z.string().trim().max(80).nullable() });

const parseProfile = (body: unknown): { displayName: string | null } => {
  const result = profileSchema.safeParse(body);
  if (!result.success) throw new Error('Invalid profile payload');
  return result.data;
};

export const registerProfileRoutes = ({ repository, authService, appOrigin, secureCookies }: ProfileRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/profile', async (request) => {
    const { session } = await requireSession(request, authService);
    return { profile: await repository.getProfile(session.userId) };
  });

  app.patch('/v1/profile', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    return { profile: await repository.updateProfile(session.userId, parseProfile(request.body).displayName) };
  });

  app.get('/v1/profile/export', async (request) => {
    const { session } = await requireSession(request, authService);
    return repository.exportAccount(session.userId);
  });

  app.delete('/v1/profile', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await repository.deleteAccount(session.userId);
    reply.header('set-cookie', clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });
};
