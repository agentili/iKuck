import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import type { AuthRateLimiter } from '../auth/rateLimit.js';
import type { HouseRole, SyncMutation } from '@ikuck/shared/contracts';
import { isSharedEntityType, SyncScopeInvalidError } from '../sync/repository.js';
import { syncMutationSchema } from '../sync/validation.js';
import type { HouseService } from '../house/service.js';
import { pantryLotSchema } from '../pantry/validation.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface HouseRouteDependencies {
  service: HouseService;
  authService: AuthService;
  rateLimiter: AuthRateLimiter;
  appOrigin: string;
}

const createHouseSchema = z.object({ name: z.string() }).strict();
const addMemberSchema = z.object({ email: z.string() }).strict();
const roleSchema = z.object({ role: z.enum(['admin', 'member']) }).strict();
const pendingAccountQueueSchema = z.object({ mutations: z.array(syncMutationSchema).min(1).max(100) }).strict();
const guestDietProfileImportSchema = z.object({ mutation: syncMutationSchema }).strict();
const guestPantrySchema = z.object({
  deviceId: z.string().min(1).max(128),
  lots: z.array(pantryLotSchema).max(1000),
  stapleIds: z.array(z.string().trim().min(1).max(128)).max(500),
}).strict();

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidPayload();
  return parsed.data;
};

export const registerHouseRoutes = ({ service, authService, rateLimiter, appOrigin }: HouseRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/house', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return await service.getState(session.userId);
  });

  app.post('/v1/house', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { name } = parseBody(createHouseSchema, request.body);
    const result = await service.createHouse(session.userId, name);
    return reply.code(201).send(result.state);
  });

  app.post('/v1/house/members', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { email } = parseBody(addMemberSchema, request.body);
    await rateLimiter.enforce('houseAddMember', { ip: request.ip, email, actorId: session.userId });
    const member = await service.addMember(session.userId, email);
    return reply.code(201).send({ member });
  });

  app.patch('/v1/house/members/:userId', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { role } = parseBody(roleSchema, request.body);
    const { userId } = request.params as { userId: string };
    await service.changeRole(session.userId, userId, role as HouseRole);
    return { ok: true };
  });

  app.post('/v1/house/import-personal-data', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await service.importPersonalData(session.userId);
    return reply.code(204).send();
  });

  app.post('/v1/house/account-queue/import', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { mutations } = parseBody(pendingAccountQueueSchema, request.body);
    const pending = mutations as SyncMutation[];
    if (pending.some((mutation) => !isSharedEntityType(mutation.entityType)
      || mutation.syncScope !== `account:${session.userId}`)) throw new SyncScopeInvalidError();
    await service.importPendingAccountQueue(session.userId, pending);
    return reply.code(204).send();
  });

  app.post('/v1/house/diet-profile/import', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { mutation } = parseBody(guestDietProfileImportSchema, request.body);
    if (mutation.entityType !== 'diet_profile' || mutation.entityId !== 'profile'
      || mutation.operation !== 'upsert' || mutation.syncScope !== undefined) throw new SyncScopeInvalidError();
    await service.importGuestDietProfile(session.userId, mutation as SyncMutation);
    return reply.code(204).send();
  });

  app.post('/v1/house/pantry/merge', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const input = parseBody(guestPantrySchema, request.body);
    const summary = await service.mergeGuestPantry(session.userId, input);
    return { summary };
  });
  app.post('/v1/house/leave', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await service.leaveHouse(session.userId);
    return reply.code(204).send();
  });

  app.delete('/v1/house/members/:userId', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const { userId } = request.params as { userId: string };
    await service.removeMember(session.userId, userId);
    return reply.code(204).send();
  });
};
