import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { PantryLot, PantryLotPayload, SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { isPantryLot, parsePantryLotDetails, parsePantryLotPatch } from '../pantry/validation.js';
import type { SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface PantryLotRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');

const parseDetails = (body: unknown): PantryLotPayload => {
  const details = parsePantryLotDetails(body);
  if (details === null) throw invalidPayload();
  return details;
};

const parsePatch = (body: unknown): Partial<PantryLotPayload> => {
  const details = parsePantryLotPatch(body);
  if (details === null) throw invalidPayload();
  return details;
};

const readLots = async (repository: SyncRepository, userId: string): Promise<PantryLot[]> => {
  const changes = await repository.readAll(userId);
  return changes
    .filter((change): change is SyncChange & { payload: PantryLot } => change.entityType === 'pantry_lot' && change.operation === 'upsert' && isPantryLot(change.payload))
    .map((change) => change.payload);
};

const createMutation = (lot: PantryLot, operation: SyncMutation['operation']): SyncMutation => ({
  mutationId: randomUUID(),
  deviceId: 'api-resource',
  entityType: 'pantry_lot',
  entityId: lot.id,
  operation,
  payload: operation === 'delete' ? null : lot,
  clientUpdatedAt: lot.updatedAt,
});

const notFound = () => new AuthServiceError('invalid_payload', 404, 'Pantry lot not found');

const readLot = async (repository: SyncRepository, userId: string, lotId: string): Promise<PantryLot> => {
  const stored = await repository.readEntity(userId, 'pantry_lot', lotId);
  if (stored === null || stored.deleted || !isPantryLot(stored.payload)) throw notFound();
  return stored.payload;
};

export const registerPantryLotRoutes = ({ repository, authService, appOrigin }: PantryLotRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/pantry-lots', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return { lots: await readLots(repository, session.userId) };
  });

  app.post('/v1/pantry-lots', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const details = parseDetails(request.body);
    const now = new Date().toISOString();
    const lot: PantryLot = { ...details, id: randomUUID(), createdAt: now, updatedAt: now };
    await repository.applyMutation(session.userId, createMutation(lot, 'upsert'));
    return reply.code(201).send({ lot: await readLot(repository, session.userId, lot.id) });
  });

  app.patch('/v1/pantry-lots/:lotId', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const existing = await readLot(repository, session.userId, (request.params as { lotId: string }).lotId);
    const details = { ...existing, ...parsePatch(request.body), updatedAt: new Date().toISOString() };
    const validated = parseDetails({
      ingredientId: details.ingredientId,
      label: details.label,
      known: details.known,
      quantity: details.quantity,
      unit: details.unit,
      expiresAt: details.expiresAt,
    });
    const lot: PantryLot = { ...validated, id: existing.id, createdAt: existing.createdAt, updatedAt: details.updatedAt };
    await repository.applyMutation(session.userId, createMutation(lot, 'upsert'));
    return { lot: await readLot(repository, session.userId, lot.id) };
  });

  app.delete('/v1/pantry-lots/:lotId', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const existing = await readLot(repository, session.userId, (request.params as { lotId: string }).lotId);
    await repository.applyMutation(session.userId, createMutation(existing, 'delete'));
    return reply.code(204).send();
  });
};
