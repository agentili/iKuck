export type SyncEntityType = 'pantry_item' | 'pantry_lot' | 'staple_preference' | 'shopping_list_item';

export type SyncOperation = 'upsert' | 'delete';

export interface SyncMutation {
  mutationId: string;
  deviceId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: unknown | null;
  clientUpdatedAt: string;
}

export interface SyncChange extends SyncMutation {
  serverSequence: number;
}

export interface SyncChangeSet {
  changes: SyncChange[];
  nextCursor: number;
}

export interface AccountSummary {
  id: string;
  email: string;
  emailVerifiedAt: string;
}

export type PantryUnit = 'g' | 'kg' | 'ml' | 'l' | 'piece' | 'pack';

export interface PantryLotPayload {
  ingredientId: string;
  label: string;
  known: boolean;
  quantity: number | null;
  unit: PantryUnit | null;
  expiresAt: string | null;
}

export interface PantryLot extends PantryLotPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingListItemPayload {
  ingredientId: string;
  label: string;
  quantity: number | null;
  unit: PantryUnit | null;
  note: string | null;
  purchased: boolean;
  sourceRecipeId: string | null;
}

export interface ShoppingListItem extends ShoppingListItemPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
}
