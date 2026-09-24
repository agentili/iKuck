import type { SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
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
  scopeResolver?: (userId: string) => Promise<SyncScope | null>;
}

export type SyncScope =
  | { kind: 'user'; id: string }
  | { kind: 'house'; id: string };

type ResolvedSyncRepositoryOptions = Required<SyncRepositoryOptions> & {
  scopeResolverConfigured: boolean;
};


const SHARED_ENTITY_TYPES: ReadonlySet<SyncMutation['entityType']> = new Set([
  'pantry_item',
  'pantry_lot',
  'staple_preference',
  'shopping_list_item',
  'cook_event',
  'generated_recipe',
]);

export const isSharedEntityType = (entityType: SyncMutation['entityType']): boolean => SHARED_ENTITY_TYPES.has(entityType);

export const DEFAULT_MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class SyncMembershipRequiredError extends Error {
  readonly code = 'house_membership_required';
  readonly status = 403;

  constructor() {
    super('House membership is required for shared data');
    this.name = 'SyncMembershipRequiredError';
  }
}

export interface SyncRepository {
  applyMutation: (userId: string, mutation: SyncMutation) => Promise<AppliedSyncMutation>;
  readChanges: (userId: string, cursor: number, limit: number) => Promise<SyncChange[]>;
  readAll: (userId: string) => Promise<SyncChange[]>;
  readEntity: (userId: string, entityType: SyncMutation['entityType'], entityId: string) => Promise<StoredSyncItem | null>;
  migrateUserSharedDataToHouse: (userId: string, houseId: string) => Promise<void>;
}

const scopeKey = (scope: SyncScope): string => `${scope.kind}:${scope.id}`;
const userScope = (userId: string): SyncScope => ({ kind: 'user', id: userId });

const entityKey = (scope: SyncScope, entityType: SyncMutation['entityType'], entityId: string): string =>
  `${scopeKey(scope)}:${entityType}:${entityId}`;

const resolveEntityScope = async (
  userId: string,
  entityType: SyncMutation['entityType'],
  options: ResolvedSyncRepositoryOptions,
): Promise<SyncScope | null> => {
  if (!isSharedEntityType(entityType)) return userScope(userId);
  if (!options.scopeResolverConfigured) return userScope(userId);
  return options.scopeResolver(userId);
};

const resolveReadScopes = async (userId: string, options: ResolvedSyncRepositoryOptions): Promise<SyncScope[]> => {
  const scopes: SyncScope[] = [userScope(userId)];
  if (!options.scopeResolverConfigured) return scopes;
  const sharedScope = await options.scopeResolver(userId);
  if (sharedScope !== null) scopes.push(sharedScope);
  return scopes;
};

interface PreparedMutation {
  mutation: SyncMutation;
  serverUpdatedAt: Date;
}

const resolveOptions = (options: SyncRepositoryOptions): ResolvedSyncRepositoryOptions => ({
  clock: options.clock ?? (() => new Date()),
  logger: options.logger ?? { warn: (message) => console.warn(message) },
  maxClientClockSkewMs: options.maxClientClockSkewMs ?? DEFAULT_MAX_CLIENT_CLOCK_SKEW_MS,
  scopeResolver: options.scopeResolver ?? (async () => null),
  scopeResolverConfigured: options.scopeResolver !== undefined,
});

const prepareMutation = (mutation: SyncMutation, options: ResolvedSyncRepositoryOptions): PreparedMutation => {
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
      const scope = await resolveEntityScope(userId, prepared.mutation.entityType, options);
      if (scope === null) throw new SyncMembershipRequiredError();
      const processedKey = `${scopeKey(scope)}:${prepared.mutation.mutationId}`;
      if (processed.has(processedKey)) return { applied: false, change: null };
      processed.add(processedKey);
      const key = entityKey(scope, prepared.mutation.entityType, prepared.mutation.entityId);
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
    readChanges: async (userId, cursor, limit) => {
      const keys = new Set((await resolveReadScopes(userId, options)).map(scopeKey));
      return [...entities.entries()]
        .filter(([key, item]) => [...keys].some((scope) => key.startsWith(`${scope}:`)) && item.serverSequence > cursor)
        .map(([, item]) => item)
        .sort((left, right) => left.serverSequence - right.serverSequence)
        .slice(0, limit)
        .map(toChange);
    },
    readAll: async (userId) => {
      const keys = new Set((await resolveReadScopes(userId, options)).map(scopeKey));
      return [...entities.entries()]
        .filter(([key]) => [...keys].some((scope) => key.startsWith(`${scope}:`)))
        .map(([, item]) => item)
        .sort((left, right) => left.serverSequence - right.serverSequence)
        .map(toChange);
    },
    readEntity: async (userId, entityType, entityId) => {
      const scope = await resolveEntityScope(userId, entityType, options);
      if (scope === null) return null;
      return entities.get(entityKey(scope, entityType, entityId)) ?? null;
    },
    migrateUserSharedDataToHouse: async (userId, houseId) => {
      const personalPrefix = `${scopeKey(userScope(userId))}:`;
      const houseScope: SyncScope = { kind: 'house', id: houseId };
      for (const [key, personalItem] of [...entities.entries()]) {
        if (!key.startsWith(personalPrefix) || !isSharedEntityType(personalItem.entityType)) continue;
        const targetKey = entityKey(houseScope, personalItem.entityType, personalItem.entityId);
        const existing = entities.get(targetKey);
        const incoming: PreparedMutation = {
          mutation: {
            mutationId: personalItem.mutationId,
            deviceId: personalItem.deviceId,
            entityType: personalItem.entityType,
            entityId: personalItem.entityId,
            operation: personalItem.deleted ? 'delete' : 'upsert',
            payload: personalItem.payload,
            clientUpdatedAt: personalItem.clientUpdatedAt.toISOString(),
          },
          serverUpdatedAt: personalItem.serverUpdatedAt,
        };
        if (existing === undefined || wins(incoming, existing)) {
          entities.set(targetKey, { ...personalItem, serverSequence: ++sequence });
        }
        entities.delete(key);
      }
    },
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
      const scope = await resolveEntityScope(userId, prepared.mutation.entityType, options);
      if (scope === null) throw new SyncMembershipRequiredError();
      return database.transaction(async (transaction) => {
        const validMutation = prepared.mutation;
        const [alreadyProcessed] = await transaction.select({ id: processedSyncMutations.id })
          .from(processedSyncMutations)
          .where(and(
            eq(processedSyncMutations.scopeType, scope.kind),
            eq(processedSyncMutations.scopeId, scope.id),
            eq(processedSyncMutations.mutationId, validMutation.mutationId),
          ))
          .limit(1);
        if (alreadyProcessed !== undefined) return { applied: false, change: null };

        await transaction.insert(processedSyncMutations).values({
          userId,
          scopeType: scope.kind,
          scopeId: scope.id,
          mutationId: validMutation.mutationId,
        });
        const [existingRow] = await transaction.select().from(syncItems).where(and(
          eq(syncItems.scopeType, scope.kind),
          eq(syncItems.scopeId, scope.id),
          eq(syncItems.entityType, validMutation.entityType),
          eq(syncItems.entityId, validMutation.entityId),
        )).limit(1);
        const existing = existingRow === undefined ? null : fromDatabaseItem(existingRow);
        if (existing !== null && !wins(prepared, existing)) return { applied: false, change: null };

        const values = {
          userId,
          scopeType: scope.kind,
          scopeId: scope.id,
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
    const scopes = await resolveReadScopes(userId, options);
    const scopeCondition = scopes.length === 1
      ? and(eq(syncItems.scopeType, scopes[0]!.kind), eq(syncItems.scopeId, scopes[0]!.id))
      : or(...scopes.map((scope) => and(eq(syncItems.scopeType, scope.kind), eq(syncItems.scopeId, scope.id))));
    const rows = await database.select().from(syncItems).where(and(
      scopeCondition,
      gt(syncItems.serverSequence, cursor),
    )).orderBy(asc(syncItems.serverSequence)).limit(limit);
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  },

  readAll: async (userId) => {
    const scopes = await resolveReadScopes(userId, options);
    const scopeCondition = scopes.length === 1
      ? and(eq(syncItems.scopeType, scopes[0]!.kind), eq(syncItems.scopeId, scopes[0]!.id))
      : or(...scopes.map((scope) => and(eq(syncItems.scopeType, scope.kind), eq(syncItems.scopeId, scope.id))));
    const rows = await database.select().from(syncItems)
      .where(scopeCondition)
      .orderBy(asc(syncItems.serverSequence));
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  },

  readEntity: async (userId, entityType, entityId) => {
    const scope = await resolveEntityScope(userId, entityType, options);
    if (scope === null) return null;
    const [row] = await database.select().from(syncItems).where(and(
      eq(syncItems.scopeType, scope.kind),
      eq(syncItems.scopeId, scope.id),
      eq(syncItems.entityType, entityType),
      eq(syncItems.entityId, entityId),
    )).limit(1);
    return row === undefined ? null : fromDatabaseItem(row);
  },

  migrateUserSharedDataToHouse: async (userId, houseId) => database.transaction(async (transaction) => {
    const personalRows = await transaction.select().from(syncItems).where(and(
      eq(syncItems.scopeType, 'user'),
      eq(syncItems.scopeId, userId),
      inArray(syncItems.entityType, [...SHARED_ENTITY_TYPES]),
    ));
    for (const personalRow of personalRows) {
      const [houseRow] = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, houseId),
        eq(syncItems.entityType, personalRow.entityType),
        eq(syncItems.entityId, personalRow.entityId),
      )).limit(1);
      const existing = houseRow === undefined ? null : fromDatabaseItem(houseRow);
      const incoming: PreparedMutation = {
        mutation: {
          mutationId: personalRow.mutationId,
          deviceId: personalRow.deviceId,
          entityType: personalRow.entityType as SyncMutation['entityType'],
          entityId: personalRow.entityId,
          operation: personalRow.deleted ? 'delete' : 'upsert',
          payload: personalRow.payload,
          clientUpdatedAt: personalRow.clientUpdatedAt.toISOString(),
        },
        serverUpdatedAt: personalRow.updatedAt,
      };
      if (existing === null || wins(incoming, existing)) {
        const values = {
          userId,
          scopeType: 'house' as const,
          scopeId: houseId,
          entityType: personalRow.entityType,
          entityId: personalRow.entityId,
          deviceId: personalRow.deviceId,
          payload: personalRow.deleted ? null : personalRow.payload,
          deleted: personalRow.deleted,
          clientUpdatedAt: personalRow.clientUpdatedAt,
          updatedAt: personalRow.updatedAt,
          mutationId: personalRow.mutationId,
        };
        if (houseRow === undefined) {
          await transaction.insert(syncItems).values(values);
        } else {
          await transaction.update(syncItems).set({
            ...values,
            serverSequence: sql`nextval('sync_server_sequence')`,
          }).where(eq(syncItems.id, houseRow.id));
        }
      }
      await transaction.delete(syncItems).where(eq(syncItems.id, personalRow.id));
    }
  }),

};
};
