import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { CookEvent, CookEventPayload, SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { isCookEvent, parseCookEventDetails } from '../activity/validation.js';
import type { SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireSession } from './auth.js';

export interface ActivityRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
const notFound = (): AuthServiceError => new AuthServiceError('invalid_payload', 404, 'Cooking event not found');

const parseDetails = (body: unknown): CookEventPayload => {
  const details = parseCookEventDetails(body);
  if (details === null) throw invalidPayload();
  return details;
};

const readEvents = async (repository: SyncRepository, userId: string): Promise<CookEvent[]> => {
  const changes = await repository.readAll(userId);
  return changes
    .filter((change): change is SyncChange & { payload: CookEvent } => (
      change.entityType === 'cook_event'
      && change.operation === 'upsert'
      && isCookEvent(change.payload)
    ))
    .map((change) => change.payload)
    .sort((left, right) => right.cookedAt.localeCompare(left.cookedAt));
};

const createMutation = (event: CookEvent, operation: SyncMutation['operation']): SyncMutation => ({
  mutationId: randomUUID(),
  deviceId: 'api-resource',
  entityType: 'cook_event',
  entityId: event.id,
  operation,
  payload: operation === 'delete' ? null : event,
  clientUpdatedAt: operation === 'delete' ? new Date().toISOString() : event.updatedAt,
});

const readEvent = async (repository: SyncRepository, userId: string, eventId: string): Promise<CookEvent> => {
  const stored = await repository.readEntity(userId, 'cook_event', eventId);
  if (stored === null || stored.deleted || !isCookEvent(stored.payload)) throw notFound();
  return stored.payload;
};

export const registerActivityRoutes = ({ repository, authService, appOrigin }: ActivityRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/activity', async (request) => {
    const { session } = await requireSession(request, authService);
    return { events: await readEvents(repository, session.userId) };
  });

  app.post('/v1/activity', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const details = parseDetails(request.body);
    const now = new Date().toISOString();
    const event: CookEvent = { ...details, id: randomUUID(), createdAt: now, updatedAt: now };
    await repository.applyMutation(session.userId, createMutation(event, 'upsert'));
    return reply.code(201).send({ event: await readEvent(repository, session.userId, event.id) });
  });

  app.delete('/v1/activity/:eventId', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const event = await readEvent(repository, session.userId, (request.params as { eventId: string }).eventId);
    await repository.applyMutation(session.userId, createMutation(event, 'delete'));
    return reply.code(204).send();
  });

  app.delete('/v1/activity', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const events = await readEvents(repository, session.userId);
    await Promise.all(events.map((event) => repository.applyMutation(session.userId, createMutation(event, 'delete'))));
    return reply.code(204).send();
  });
};
