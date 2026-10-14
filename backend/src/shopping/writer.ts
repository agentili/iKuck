import { randomUUID } from 'node:crypto';
import type { ShoppingListItem, SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import type { SyncRepository } from '../sync/repository.js';
import { isShoppingListItem } from './validation.js';

export const readShoppingListItems = async (repository: SyncRepository, userId: string): Promise<ShoppingListItem[]> => {
  const changes = await repository.readAll(userId);
  return changes
    .filter((change): change is SyncChange & { payload: ShoppingListItem } => change.entityType === 'shopping_list_item' && change.operation === 'upsert' && isShoppingListItem(change.payload))
    .map((change) => change.payload);
};

export const createShoppingListMutation = (item: ShoppingListItem, operation: SyncMutation['operation']): SyncMutation => ({
  mutationId: randomUUID(),
  deviceId: 'api-resource',
  entityType: 'shopping_list_item',
  entityId: item.id,
  operation,
  payload: operation === 'delete' ? null : item,
  clientUpdatedAt: item.updatedAt,
});
