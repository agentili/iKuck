import type { SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import { processedSyncMutations, syncItems } from '../db/schema.js';
import { assertSyncMutation } from './validation.js';

export interface StoredSyncItem {
  entityType: SyncMutation['entityType'];
  entityId: string;
  deviceId: string;
  payload: unknown | null;
  deleted: boolean;
  clientUpdatedAt: Date;
  serverUpdatedAt: Date;
  mutationId: string;
  serverSequence: number;
}

export interface AppliedSyncMutation {
  applied: boolean;
  change: SyncChange | null;
}

export interface SyncRepositoryLogger {
  warn: (message: string) => void;
}

export interface SyncRepositoryOptions {
  clock?: () => Date;
  logger?: SyncRepositoryLogger;
  maxClientClockSkewMs?: number;
}

export const DEFAULT_MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface SyncRepository {
  applyMutation: (userId: string, mutation: SyncMutation) => Promise<AppliedSyncMutation>;
  readChanges: (userId: string, cursor: number, limit: number) => Promise<SyncChange[]>;
  readAll: (userId: string) => Promise<SyncChange[]>;
  readEntity: (userId: string, entityType: SyncMutation['entityType'], entityId: string) => Promise<StoredSyncItem | null>;
}

const entityKey = (userId: string, entityType: SyncMutation['entityType'], entityId: string): string =>
  `${userId}:${entityType}:${entityId}`;

interface PreparedMutation {
  mutation: SyncMutation;
  serverUpdatedAt: Date;
}

const resolveOptions = (options: SyncRepositoryOptions): Required<SyncRepositoryOptions> => ({
  clock: options.clock ?? (() => new Date()),
  logger: options.logger ?? { warn: (message) => console.warn(message) },
  maxClientClockSkewMs: options.maxClientClockSkewMs ?? DEFAULT_MAX_CLIENT_CLOCK_SKEW_MS,
});

const prepareMutation = (mutation: SyncMutation, options: Required<SyncRepositoryOptions>): PreparedMutation => {
  const validMutation = assertSyncMutation(mutation);
  const serverUpdatedAt = options.clock();
  const clientUpdatedAt = new Date(validMutation.clientUpdatedAt);
  const isFutureSkewed = clientUpdatedAt.getTime() > serverUpdatedAt.getTime() + options.maxClientClockSkewMs;
  if (isFutureSkewed) options.logger.warn('Sync client timestamp exceeded the configured clock skew tolerance');

  return {
    mutation: isFutureSkewed
      ? { ...validMutation, clientUpdatedAt: serverUpdatedAt.toISOString() }
      : validMutation,
    serverUpdatedAt,
  };
};

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

const wins = (incoming: PreparedMutation, existing: StoredSyncItem): boolean => {
  const incomingTime = new Date(incoming.mutation.clientUpdatedAt).getTime();
  const existingTime = existing.clientUpdatedAt.getTime();
  if (incomingTime !== existingTime) return incomingTime > existingTime;

  const incomingServerTime = incoming.serverUpdatedAt.getTime();
  const existingServerTime = existing.serverUpdatedAt.getTime();
  if (incomingServerTime !== existingServerTime) return incomingServerTime > existingServerTime;
  if (incoming.mutation.deviceId !== existing.deviceId) return incoming.mutation.deviceId > existing.deviceId;
  return incoming.mutation.mutationId > existing.mutationId;
};

export const createMemorySyncRepository = (repositoryOptions: SyncRepositoryOptions = {}): SyncRepository & {
  readEntity: SyncRepository['readEntity'];
} => {
  const options = resolveOptions(repositoryOptions);
  const entities = new Map<string, StoredSyncItem>();
  const processed = new Set<string>();
  let sequence = 0;

  return {
    applyMutation: async (userId, mutation) => {
      const prepared = prepareMutation(mutation, options);
      if (processed.has(`${userId}:${prepared.mutation.mutationId}`)) return { applied: false, change: null };
      processed.add(`${userId}:${prepared.mutation.mutationId}`);
      const key = entityKey(userId, prepared.mutation.entityType, prepared.mutation.entityId);
      const existing = entities.get(key);
      if (existing !== undefined && !wins(prepared, existing)) return { applied: false, change: null };
      const item: StoredSyncItem = {
        entityType: prepared.mutation.entityType,
        entityId: prepared.mutation.entityId,
        deviceId: prepared.mutation.deviceId,
        payload: prepared.mutation.payload,
        deleted: prepared.mutation.operation === 'delete',
        clientUpdatedAt: new Date(prepared.mutation.clientUpdatedAt),
        serverUpdatedAt: prepared.serverUpdatedAt,
        mutationId: prepared.mutation.mutationId,
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
  serverUpdatedAt: item.updatedAt,
  mutationId: item.mutationId,
  serverSequence: item.serverSequence,
});

export const createDrizzleSyncRepository = (
  database: ApplicationDatabase['db'],
  repositoryOptions: SyncRepositoryOptions = {},
): SyncRepository => {
  const options = resolveOptions(repositoryOptions);

  return {
    applyMutation: async (userId, mutation) => {
      const prepared = prepareMutation(mutation, options);
      return database.transaction(async (transaction) => {
        const validMutation = prepared.mutation;
        const [alreadyProcessed] = await transaction.select({ id: processedSyncMutations.id })
          .from(processedSyncMutations)
          .where(and(
            eq(processedSyncMutations.userId, userId),
            eq(processedSyncMutations.mutationId, validMutation.mutationId),
          ))
          .limit(1);
        if (alreadyProcessed !== undefined) return { applied: false, change: null };

        await transaction.insert(processedSyncMutations).values({ userId, mutationId: validMutation.mutationId });
        const [existingRow] = await transaction.select().from(syncItems).where(and(
          eq(syncItems.userId, userId),
          eq(syncItems.entityType, validMutation.entityType),
          eq(syncItems.entityId, validMutation.entityId),
        )).limit(1);
        const existing = existingRow === undefined ? null : fromDatabaseItem(existingRow);
        if (existing !== null && !wins(prepared, existing)) return { applied: false, change: null };

        const values = {
          userId,
          entityType: validMutation.entityType,
          entityId: validMutation.entityId,
          deviceId: validMutation.deviceId,
          payload: validMutation.operation === 'delete' ? null : validMutation.payload,
          deleted: validMutation.operation === 'delete',
          clientUpdatedAt: new Date(validMutation.clientUpdatedAt),
          updatedAt: prepared.serverUpdatedAt,
          mutationId: validMutation.mutationId,
        };
        const [saved] = existing === null
          ? await transaction.insert(syncItems).values(values).returning()
          : await transaction.update(syncItems).set({
            ...values,
            serverSequence: sql`nextval('sync_server_sequence')`,
            updatedAt: prepared.serverUpdatedAt,
          }).where(eq(syncItems.id, existingRow!.id)).returning();
        const item = fromDatabaseItem(saved);
        return { applied: true, change: toChange(item) };
      });
    },

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
  };
};
