import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ShoppingListItem, ShoppingListItemPayload, SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { isShoppingListItem, parseShoppingListItemDetails, parseShoppingListItemPatch } from '../shopping/validation.js';
import type { SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface ShoppingListRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');

const parseDetails = (body: unknown): ShoppingListItemPayload => {
  const details = parseShoppingListItemDetails(body);
  if (details === null) throw invalidPayload();
  return details;
};

const parsePatch = (body: unknown): Partial<ShoppingListItemPayload> => {
  const details = parseShoppingListItemPatch(body);
  if (details === null) throw invalidPayload();
  return details;
};

const readItems = async (repository: SyncRepository, userId: string): Promise<ShoppingListItem[]> => {
  const changes = await repository.readAll(userId);
  return changes
    .filter((change): change is SyncChange & { payload: ShoppingListItem } => change.entityType === 'shopping_list_item' && change.operation === 'upsert' && isShoppingListItem(change.payload))
    .map((change) => change.payload);
};

const createMutation = (item: ShoppingListItem, operation: SyncMutation['operation']): SyncMutation => ({
  mutationId: randomUUID(),
  deviceId: 'api-resource',
  entityType: 'shopping_list_item',
  entityId: item.id,
  operation,
  payload: operation === 'delete' ? null : item,
  clientUpdatedAt: item.updatedAt,
});

const notFound = () => new AuthServiceError('invalid_payload', 404, 'Shopping list item not found');

const readItem = async (repository: SyncRepository, userId: string, itemId: string): Promise<ShoppingListItem> => {
  const stored = await repository.readEntity(userId, 'shopping_list_item', itemId);
  if (stored === null || stored.deleted || !isShoppingListItem(stored.payload)) throw notFound();
  return stored.payload;
};

export const registerShoppingListRoutes = ({ repository, authService, appOrigin }: ShoppingListRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/shopping-list', async (request) => {
    const { session } = await requireVerifiedSession(request, authService);
    return { items: await readItems(repository, session.userId) };
  });

  app.post('/v1/shopping-list', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const details = parseDetails(request.body);
    const now = new Date().toISOString();
    const item: ShoppingListItem = { ...details, id: randomUUID(), createdAt: now, updatedAt: now };
    await repository.applyMutation(session.userId, createMutation(item, 'upsert'));
    return reply.code(201).send({ item: await readItem(repository, session.userId, item.id) });
  });

  app.patch('/v1/shopping-list/:itemId', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const existing = await readItem(repository, session.userId, (request.params as { itemId: string }).itemId);
    const details = { ...existing, ...parsePatch(request.body), updatedAt: new Date().toISOString() };
    const validated = parseDetails({
      ingredientId: details.ingredientId,
      label: details.label,
      quantity: details.quantity,
      unit: details.unit,
      note: details.note,
      purchased: details.purchased,
      sourceRecipeId: details.sourceRecipeId,
    });
    const item: ShoppingListItem = { ...validated, id: existing.id, createdAt: existing.createdAt, updatedAt: details.updatedAt };
    await repository.applyMutation(session.userId, createMutation(item, 'upsert'));
    return { item: await readItem(repository, session.userId, item.id) };
  });

  app.delete('/v1/shopping-list/:itemId', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const existing = await readItem(repository, session.userId, (request.params as { itemId: string }).itemId);
    await repository.applyMutation(session.userId, createMutation(existing, 'delete'));
    return reply.code(204).send();
  });
};
