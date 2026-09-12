import type { SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import { processedSyncMutations, syncItems } from '../db/schema.js';

export interface StoredSyncItem {
  entityType: SyncMutation['entityType'];
  entityId: string;
  deviceId: string;
  payload: unknown | null;
  deleted: boolean;
  clientUpdatedAt: Date;
  mutationId: string;
  serverSequence: number;
}

export interface AppliedSyncMutation {
  applied: boolean;
  change: SyncChange | null;
}

export interface SyncRepository {
  applyMutation: (userId: string, mutation: SyncMutation) => Promise<AppliedSyncMutation>;
  readChanges: (userId: string, cursor: number, limit: number) => Promise<SyncChange[]>;
  readAll: (userId: string) => Promise<SyncChange[]>;
  readEntity: (userId: string, entityType: SyncMutation['entityType'], entityId: string) => Promise<StoredSyncItem | null>;
}

const entityKey = (userId: string, entityType: SyncMutation['entityType'], entityId: string): string =>
  `${userId}:${entityType}:${entityId}`;

const toChange = (item: StoredSyncItem): SyncChange => ({
  mutationId: item.mutationId,
  deviceId: item.deviceId,
  entityType: item.entityType,
  entityId: item.entityId,
  operation: item.deleted ? 'delete' : 'upsert',
  payload: item.deleted ? null : item.payload,
  clientUpdatedAt: item.clientUpdatedAt.toISOString(),
  serverSequence: item.serverSequence,
});

const wins = (incoming: SyncMutation, existing: StoredSyncItem): boolean => {
  const incomingTime = new Date(incoming.clientUpdatedAt).getTime();
  const existingTime = existing.clientUpdatedAt.getTime();
  return incomingTime > existingTime
    || (incomingTime === existingTime && incoming.mutationId > existing.mutationId);
};

export const createMemorySyncRepository = (): SyncRepository & {
  readEntity: SyncRepository['readEntity'];
} => {
  const entities = new Map<string, StoredSyncItem>();
  const processed = new Set<string>();
  let sequence = 0;

  return {
    applyMutation: async (userId, mutation) => {
      if (processed.has(`${userId}:${mutation.mutationId}`)) return { applied: false, change: null };
      processed.add(`${userId}:${mutation.mutationId}`);
      const key = entityKey(userId, mutation.entityType, mutation.entityId);
      const existing = entities.get(key);
      if (existing !== undefined && !wins(mutation, existing)) return { applied: false, change: null };
      const item: StoredSyncItem = {
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        deviceId: mutation.deviceId,
        payload: mutation.payload,
        deleted: mutation.operation === 'delete',
        clientUpdatedAt: new Date(mutation.clientUpdatedAt),
        mutationId: mutation.mutationId,
        serverSequence: ++sequence,
      };
      entities.set(key, item);
      return { applied: true, change: toChange(item) };
    },
    readChanges: async (userId, cursor, limit) => [...entities.entries()]
      .filter(([key, item]) => key.startsWith(`${userId}:`) && item.serverSequence > cursor)
      .map(([, item]) => item)
      .sort((left, right) => left.serverSequence - right.serverSequence)
      .slice(0, limit)
      .map(toChange),
    readAll: async (userId) => [...entities.entries()]
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([, item]) => item)
      .sort((left, right) => left.serverSequence - right.serverSequence)
      .map(toChange),
    readEntity: async (userId, entityType, entityId) => entities.get(entityKey(userId, entityType, entityId)) ?? null,
  };
};

const fromDatabaseItem = (item: typeof syncItems.$inferSelect): StoredSyncItem => ({
  entityType: item.entityType as SyncMutation['entityType'],
  entityId: item.entityId,
  deviceId: item.deviceId,
  payload: item.payload,
  deleted: item.deleted,
  clientUpdatedAt: item.clientUpdatedAt,
  mutationId: item.mutationId,
  serverSequence: item.serverSequence,
});

export const createDrizzleSyncRepository = (database: ApplicationDatabase['db']): SyncRepository => ({
  applyMutation: async (userId, mutation) => database.transaction(async (transaction) => {
    const [alreadyProcessed] = await transaction.select({ id: processedSyncMutations.id })
      .from(processedSyncMutations)
      .where(and(
        eq(processedSyncMutations.userId, userId),
        eq(processedSyncMutations.mutationId, mutation.mutationId),
      ))
      .limit(1);
    if (alreadyProcessed !== undefined) return { applied: false, change: null };

    await transaction.insert(processedSyncMutations).values({ userId, mutationId: mutation.mutationId });
    const [existingRow] = await transaction.select().from(syncItems).where(and(
      eq(syncItems.userId, userId),
      eq(syncItems.entityType, mutation.entityType),
      eq(syncItems.entityId, mutation.entityId),
    )).limit(1);
    const existing = existingRow === undefined ? null : fromDatabaseItem(existingRow);
    if (existing !== null && !wins(mutation, existing)) return { applied: false, change: null };

    const values = {
      userId,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      deviceId: mutation.deviceId,
      payload: mutation.operation === 'delete' ? null : mutation.payload,
      deleted: mutation.operation === 'delete',
      clientUpdatedAt: new Date(mutation.clientUpdatedAt),
      mutationId: mutation.mutationId,
    };
    const [saved] = existing === null
      ? await transaction.insert(syncItems).values(values).returning()
      : await transaction.update(syncItems).set({
        ...values,
        serverSequence: sql`nextval('sync_server_sequence')`,
        updatedAt: new Date(),
      }).where(eq(syncItems.id, existingRow!.id)).returning();
    const item = fromDatabaseItem(saved);
    return { applied: true, change: toChange(item) };
  }),

  readChanges: async (userId, cursor, limit) => {
    const rows = await database.select().from(syncItems).where(and(
      eq(syncItems.userId, userId),
      gt(syncItems.serverSequence, cursor),
    )).orderBy(asc(syncItems.serverSequence)).limit(limit);
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  },

  readAll: async (userId) => {
    const rows = await database.select().from(syncItems)
      .where(eq(syncItems.userId, userId))
      .orderBy(asc(syncItems.serverSequence));
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  },

  readEntity: async (userId, entityType, entityId) => {
    const [row] = await database.select().from(syncItems).where(and(
      eq(syncItems.userId, userId),
      eq(syncItems.entityType, entityType),
      eq(syncItems.entityId, entityId),
    )).limit(1);
    return row === undefined ? null : fromDatabaseItem(row);
  },
});
