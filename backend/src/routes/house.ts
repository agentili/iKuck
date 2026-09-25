import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import type { HouseRole } from '@ikuck/shared/contracts';
import type { HouseService } from '../house/service.js';
import { pantryLotSchema } from '../pantry/validation.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface HouseRouteDependencies {
  service: HouseService;
  authService: AuthService;
  appOrigin: string;
}

const createHouseSchema = z.object({ name: z.string() }).strict();
const addMemberSchema = z.object({ email: z.string() }).strict();
const roleSchema = z.object({ role: z.enum(['admin', 'member']) }).strict();
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

export const registerHouseRoutes = ({ service, authService, appOrigin }: HouseRouteDependencies): FastifyPluginAsync => async (app) => {
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
