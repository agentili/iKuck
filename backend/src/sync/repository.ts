import type { PantryLot, SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import { mergePantryLots, type PantryMergeSummary } from '@ikuck/shared/pantryMerge';
import { and, asc, eq, gt, inArray, like, or, sql } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import { processedSyncMutations, houseMemberships, houses, syncItems } from '../db/schema.js';
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
  syncScope?: SyncMutation['syncScope'];
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


export class SyncScopeInvalidError extends Error {
  readonly code = 'sync_scope_invalid';
  readonly status = 400;

  constructor() {
    super('House scope is only valid for shared data');
    this.name = 'SyncScopeInvalidError';
  }
}

const SHARED_ENTITY_TYPES: ReadonlySet<SyncMutation['entityType']> = new Set([
  'pantry_item',
  'pantry_lot',
  'staple_preference',
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
  readChanges: (userId: string, cursor: number, limit: number, requestedScope?: SyncMutation['syncScope']) => Promise<SyncChange[]>;
  readAll: (userId: string) => Promise<SyncChange[]>;
  readEntity: (userId: string, entityType: SyncMutation['entityType'], entityId: string) => Promise<StoredSyncItem | null>;
  migrateUserSharedDataToHouse: (userId: string, houseId: string) => Promise<void>;
  mergeUserPantryToHouse: (userId: string, houseId: string) => Promise<PantryMergeSummary>;
  mergeGuestPantryToHouse: (userId: string, houseId: string, input: {
    deviceId: string;
    lots: PantryLot[];
    stapleIds: string[];
  }) => Promise<PantryMergeSummary>;
}

const scopeKey = (scope: SyncScope): string => `${scope.kind}:${scope.id}`;
const userScope = (userId: string): SyncScope => ({ kind: 'user', id: userId });

const pantryItemPayload = (value: unknown): value is { id: string; label: string; known: boolean } => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.known === 'boolean';
};

const storedPantryLot = (item: StoredSyncItem): PantryLot | null => {
  if (item.deleted) return null;
  if (item.entityType === 'pantry_lot' && typeof item.payload === 'object' && item.payload !== null) {
    const candidate = item.payload as PantryLot;
    if (typeof candidate.id === 'string' && typeof candidate.ingredientId === 'string'
      && typeof candidate.label === 'string' && typeof candidate.known === 'boolean'
      && (candidate.quantity === null || typeof candidate.quantity === 'number')
      && (candidate.unit === null || typeof candidate.unit === 'string')
      && (candidate.expiresAt === null || typeof candidate.expiresAt === 'string')
      && typeof candidate.createdAt === 'string' && typeof candidate.updatedAt === 'string') {
      return candidate;
    }
  }
  if (item.entityType !== 'pantry_item' || !pantryItemPayload(item.payload)) return null;
  const timestamp = item.clientUpdatedAt.toISOString();
  return {
    id: `legacy:${item.entityId}`,
    ingredientId: item.payload.id,
    label: item.payload.label,
    known: item.payload.known,
    quantity: null,
    unit: null,
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const pantryItemTypes = new Set<SyncMutation['entityType']>(['pantry_item', 'pantry_lot']);
const pantryTypes = new Set<SyncMutation['entityType']>(['pantry_item', 'pantry_lot', 'staple_preference']);

const lotFingerprint = (lot: PantryLot): string => JSON.stringify({
  ingredientId: lot.ingredientId,
  label: lot.label,
  known: lot.known,
  quantity: lot.quantity,
  unit: lot.unit,
  expiresAt: lot.expiresAt,
  createdAt: lot.createdAt,
  updatedAt: lot.updatedAt,
});

const guestMarkerPrefixForItem = (item: Pick<StoredSyncItem, 'entityType' | 'entityId' | 'deviceId'>): string | null => {
  if (item.entityType === 'pantry_lot' || item.entityType === 'pantry_item') return `guest:${item.deviceId}:pantry_lot:${item.entityId}:`;
  if (item.entityType === 'staple_preference') return `guest:${item.deviceId}:staple_preference:${item.entityId}:`;
  return null;
};

const guestMarkerForItem = (item: StoredSyncItem): string | null => {
  const prefix = guestMarkerPrefixForItem(item);
  if (prefix === null) return null;
  if (item.entityType === 'pantry_lot' || item.entityType === 'pantry_item') {
    const lot = storedPantryLot(item);
    return lot === null ? null : `${prefix}${lotFingerprint(lot)}`;
  }
  return `${prefix}${JSON.stringify(item.payload)}`;
};

const guestMarkerForLot = (deviceId: string, lot: PantryLot): string =>
  `guest:${deviceId}:pantry_lot:${lot.id}:${lotFingerprint(lot)}`;

const entityPayloadEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const entityMatches = (
  row: StoredSyncItem | undefined,
  entityType: SyncMutation['entityType'],
  entityId: string,
  payload: unknown,
): boolean => row !== undefined
  && !row.deleted
  && row.entityType === entityType
  && row.entityId === entityId
  && entityPayloadEqual(row.payload, payload);

const lotRevisionTime = (value: string): number => Date.parse(value);

const latestLotsById = (lots: readonly PantryLot[]): PantryLot[] => {
  const distinct = new Map<string, PantryLot>();
  for (const lot of lots) {
    const current = distinct.get(lot.id);
    const nextTime = lotRevisionTime(lot.updatedAt);
    const currentTime = current === undefined ? Number.NEGATIVE_INFINITY : lotRevisionTime(current.updatedAt);
    if (current === undefined || nextTime > currentTime || (nextTime === currentTime && lot.updatedAt >= current.updatedAt)) {
      distinct.set(lot.id, lot);
    }
  }
  return [...distinct.values()];
};

const lotGroupKey = (lot: PantryLot): string => {
  const ingredient = lot.known
    ? `known:${lot.ingredientId}`
    : `custom:${lot.label.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[’']/g, ' ').replace(/[^a-zA-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase()}`;
  return `${ingredient}|${lot.expiresAt ?? 'none'}`;
};

const unitFamily = (unit: PantryLot['unit']): 'mass' | 'volume' | 'piece' | 'pack' | null => {
  if (unit === 'g' || unit === 'kg') return 'mass';
  if (unit === 'ml' || unit === 'l') return 'volume';
  if (unit === 'piece') return 'piece';
  if (unit === 'pack') return 'pack';
  return null;
};

const unitFactor = (unit: PantryLot['unit']): number => {
  if (unit === 'kg' || unit === 'l') return 1000;
  return 1;
};

const sameLotGroup = (left: PantryLot, right: PantryLot): boolean => lotGroupKey(left) === lotGroupKey(right)
  && (left.quantity === null || left.unit === null || right.quantity === null || right.unit === null
    || unitFamily(left.unit) === unitFamily(right.unit));

const removeLotContribution = (existing: PantryLot, contribution: PantryLot): PantryLot | null => {
  if (existing.quantity === null || existing.unit === null || contribution.quantity === null || contribution.unit === null) return existing;
  if (unitFamily(existing.unit) !== unitFamily(contribution.unit)) return existing;
  const remaining = existing.quantity * unitFactor(existing.unit) - contribution.quantity * unitFactor(contribution.unit);
  if (remaining <= 0) return null;
  return { ...existing, quantity: remaining / unitFactor(existing.unit) };
};

const latestGuestLotRevision = (markers: readonly string[], deviceId: string, lotId: string): PantryLot | null => {
  const prefix = `guest:${deviceId}:pantry_lot:${lotId}:`;
  const revisions = markers.flatMap((marker) => {
    if (!marker.startsWith(prefix)) return [];
    try {
      const value = JSON.parse(marker.slice(prefix.length)) as Record<string, unknown>;
      if (typeof value.ingredientId !== 'string' || typeof value.label !== 'string' || typeof value.known !== 'boolean'
        || (value.quantity !== null && typeof value.quantity !== 'number')
        || (value.unit !== null && typeof value.unit !== 'string')
        || (value.expiresAt !== null && typeof value.expiresAt !== 'string')
        || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return [];
      return [{ ...value, id: lotId } as PantryLot];
    } catch {
      return [];
    }
  });
  return latestLotsById(revisions)[0] ?? null;
};

const rekeyCollidingLots = (
  existingLots: readonly PantryLot[],
  incomingLots: readonly PantryLot[],
  sourcePrefix: string,
): PantryLot[] => {
  const usedIds = new Set(existingLots.map((lot) => lot.id));
  const distinctIncoming = latestLotsById(incomingLots);
  return distinctIncoming.map((lot) => {
    let id = lot.id;
    if (usedIds.has(id)) {
      id = `${sourcePrefix}:${lot.id}`;
      let suffix = 2;
      while (usedIds.has(id)) id = `${sourcePrefix}:${lot.id}:${suffix++}`;
    }
    usedIds.add(id);
    return id === lot.id ? lot : { ...lot, id };
  });
};

const entityForMergedLot = (lot: PantryLot, now: Date): StoredSyncItem => ({
  entityType: 'pantry_lot',
  entityId: lot.id,
  deviceId: 'house-pantry-merge',
  payload: lot,
  deleted: false,
  clientUpdatedAt: new Date(lot.updatedAt),
  serverUpdatedAt: now,
  mutationId: `house-pantry-merge:pantry_lot:${lot.id}`,
  serverSequence: 0,
});

const entityForTombstone = (
  entityType: SyncMutation['entityType'],
  entityId: string,
  now: Date,
): StoredSyncItem => ({
  entityType,
  entityId,
  deviceId: 'house-pantry-merge',
  payload: null,
  deleted: true,
  clientUpdatedAt: now,
  serverUpdatedAt: now,
  mutationId: `house-pantry-merge:delete:${entityType}:${entityId}`,
  serverSequence: 0,
});

const entityForMergedStaple = (stapleId: string, now: Date): StoredSyncItem => ({
  entityType: 'staple_preference',
  entityId: stapleId,
  deviceId: 'house-pantry-merge',
  payload: { enabled: true },
  deleted: false,
  clientUpdatedAt: now,
  serverUpdatedAt: now,
  mutationId: `house-pantry-merge:staple_preference:${stapleId}`,
  serverSequence: 0,
});

const entityScopeFor = (scope: SyncScope, key: string): boolean => key.startsWith(`${scopeKey(scope)}:`);

const entityIdFromKey = (key: string): string => key.slice(key.lastIndexOf(':') + 1);

const entityKey = (scope: SyncScope, entityType: SyncMutation['entityType'], entityId: string): string =>
  `${scopeKey(scope)}:${entityType}:${entityId}`;

const resolveEntityScope = async (
  userId: string,
  entityType: SyncMutation['entityType'],
  options: ResolvedSyncRepositoryOptions,
  requestedScope?: SyncMutation['syncScope'],
): Promise<SyncScope | null> => {
  if (requestedScope !== undefined) {
    if (requestedScope === `account:${userId}`) return userScope(userId);
    if (requestedScope.startsWith('house:') && !isSharedEntityType(entityType)) throw new SyncScopeInvalidError();
    if (!requestedScope.startsWith('house:') || !options.scopeResolverConfigured) return null;
    const currentHouse = await options.scopeResolver(userId);
    return currentHouse?.kind === 'house' && requestedScope === `house:${currentHouse.id}` ? currentHouse : null;
  }
  if (!isSharedEntityType(entityType)) return userScope(userId);
  if (!options.scopeResolverConfigured) return userScope(userId);
  return (await options.scopeResolver(userId)) ?? userScope(userId);
};

const resolveReadScopes = async (
  userId: string,
  options: ResolvedSyncRepositoryOptions,
  requestedScope?: SyncMutation['syncScope'],
): Promise<SyncScope[]> => {
  if (requestedScope === `account:${userId}`) return [userScope(userId)];
  if (requestedScope?.startsWith('account:')) throw new SyncMembershipRequiredError();
  if (requestedScope?.startsWith('house:')) {
    if (!options.scopeResolverConfigured) throw new SyncMembershipRequiredError();
    const currentHouse = await options.scopeResolver(userId);
    if (currentHouse?.kind !== 'house' || requestedScope !== `house:${currentHouse.id}`) throw new SyncMembershipRequiredError();
    return [userScope(userId), currentHouse];
  }
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
  syncScope: item.syncScope,
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

  const mergeMemoryPantry = (
    userId: string,
    houseId: string,
    incomingLots: readonly PantryLot[],
    incomingStaples: readonly string[],
    sourceRows: readonly [string, StoredSyncItem][],
    markerIds: readonly string[],
    sourcePrefix: string,
  ): PantryMergeSummary => {
    const houseScope: SyncScope = { kind: 'house', id: houseId };
    const sourceRowsAfterExactDedup = sourceRows.map(([key, item]) => {
      const marker = guestMarkerForItem(item);
      return marker !== null && processed.has(`${scopeKey(houseScope)}:${marker}`)
        ? [key, { ...item, deleted: true }] as [string, StoredSyncItem]
        : [key, item] as [string, StoredSyncItem];
    });
    const houseRows = [...entities.entries()].filter(([key]) => entityScopeFor(houseScope, key));
    const housePantryRows = houseRows.filter(([, item]) => pantryTypes.has(item.entityType));
    const existingLots = housePantryRows
      .filter(([, item]) => pantryItemTypes.has(item.entityType))
      .map(([, item]) => storedPantryLot(item))
      .filter((lot): lot is PantryLot => lot !== null);
    const existingStaples = housePantryRows
      .filter(([, item]) => item.entityType === 'staple_preference' && !item.deleted
        && typeof item.payload === 'object' && item.payload !== null
        && (item.payload as { enabled?: unknown }).enabled === true)
      .map(([, item]) => item.entityId);
    const supersededExistingIds = new Set<string>();
    const houseProcessedPrefix = `${scopeKey(houseScope)}:`;
    const houseProcessedMarkers = [...processed]
      .filter((processedKey) => processedKey.startsWith(houseProcessedPrefix))
      .map((processedKey) => processedKey.slice(houseProcessedPrefix.length));
    const sourceRowsForMerge = sourceRowsAfterExactDedup.map(([key, item]) => {
      const sourceLot = storedPantryLot(item);
      const previous = sourceLot === null ? undefined : existingLots.find((lot) => lot.id === sourceLot.id);
      const markerPrefix = guestMarkerPrefixForItem(item);
      const hasPriorRevision = markerPrefix !== null
        && houseProcessedMarkers.some((processedMarker) => processedMarker.startsWith(markerPrefix));
      if (!item.deleted && sourceLot !== null && previous !== undefined && hasPriorRevision) {
        if (lotRevisionTime(sourceLot.updatedAt) <= lotRevisionTime(previous.updatedAt)) return [key, { ...item, deleted: true }] as [string, StoredSyncItem];
        supersededExistingIds.add(previous.id);
      }
      return [key, item] as [string, StoredSyncItem];
    });
    let existingLotsForMerge = existingLots.filter((lot) => !supersededExistingIds.has(lot.id));
    const sourceLots = sourceRowsForMerge
      .filter(([, item]) => pantryItemTypes.has(item.entityType))
      .map(([, item]) => storedPantryLot(item))
      .filter((lot): lot is PantryLot => lot !== null);
    const sourceStaples = sourceRowsForMerge
      .filter(([, item]) => item.entityType === 'staple_preference' && !item.deleted
        && typeof item.payload === 'object' && item.payload !== null
        && (item.payload as { enabled?: unknown }).enabled === true)
      .map(([, item]) => item.entityId);
    const sourceDeviceId = sourcePrefix.startsWith('guest:') ? sourcePrefix.slice('guest:'.length) : null;
    const revisionAwareIncomingLots = latestLotsById(incomingLots).filter((lot) => {
      const previous = existingLots.find((candidate) => candidate.id === lot.id);
      const priorRevision = sourceDeviceId === null ? null : latestGuestLotRevision(houseProcessedMarkers, sourceDeviceId, lot.id);
      const hasPriorRevision = priorRevision !== null || (sourceDeviceId !== null
        && houseProcessedMarkers.some((processedMarker) => processedMarker.startsWith(`guest:${sourceDeviceId}:pantry_lot:${lot.id}:`)));
      if (!hasPriorRevision) return true;
      if (priorRevision !== null) {
        if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(priorRevision.updatedAt)) return false;
        const priorCandidate = existingLotsForMerge.find((candidate) => sameLotGroup(candidate, priorRevision));
        if (priorCandidate !== undefined) {
          const adjusted = removeLotContribution(priorCandidate, priorRevision);
          existingLotsForMerge = adjusted === null
            ? existingLotsForMerge.filter((candidate) => candidate.id !== priorCandidate.id)
            : existingLotsForMerge.map((candidate) => candidate.id === priorCandidate.id ? adjusted : candidate);
        } else if (previous !== undefined) {
          supersededExistingIds.add(previous.id);
          existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
        }
        return true;
      }
      if (previous === undefined) return true;
      if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(previous.updatedAt)) return false;
      supersededExistingIds.add(previous.id);
      existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
      return true;
    });
    const incomingForMerge = rekeyCollidingLots(existingLotsForMerge, [...sourceLots, ...revisionAwareIncomingLots], sourcePrefix);
    const mergedLots = mergePantryLots(existingLotsForMerge, incomingForMerge);
    const stapleIds = [...new Set([...existingStaples, ...sourceStaples, ...incomingStaples])];
    const now = options.clock();
    const currentLotsById = new Map(housePantryRows
      .filter(([, item]) => item.entityType === 'pantry_lot' && !item.deleted)
      .map(([key, item]) => [entityIdFromKey(key), item]));
    const currentStaples = housePantryRows.filter(([, item]) => item.entityType === 'staple_preference' && !item.deleted);
    const lotsUnchanged = currentLotsById.size === mergedLots.lots.length
      && mergedLots.lots.every((lot) => entityMatches(currentLotsById.get(lot.id), 'pantry_lot', lot.id, lot));
    const staplesUnchanged = currentStaples.length === stapleIds.length
      && stapleIds.every((id) => entityMatches(
        currentStaples.find(([key]) => entityIdFromKey(key) === id)?.[1],
        'staple_preference',
        id,
        { enabled: true },
      ));

    if (!lotsUnchanged || !staplesUnchanged) {
      for (const [key] of houseRows.filter(([, item]) => pantryTypes.has(item.entityType))) entities.delete(key);
      const finalKeys = new Set([
        ...mergedLots.lots.map((lot) => `pantry_lot:${lot.id}`),
        ...stapleIds.map((id) => `staple_preference:${id}`),
      ]);
      for (const [, previous] of housePantryRows) {
        const previousKey = `${previous.entityType}:${previous.entityId}`;
        if (finalKeys.has(previousKey)) continue;
        const item = entityForTombstone(previous.entityType, previous.entityId, now);
        item.serverSequence = ++sequence;
        entities.set(entityKey(houseScope, previous.entityType, previous.entityId), item);
      }
      for (const lot of mergedLots.lots) {
        const item = entityForMergedLot(lot, now);
        item.serverSequence = ++sequence;
        entities.set(entityKey(houseScope, 'pantry_lot', lot.id), item);
      }
      for (const stapleId of stapleIds) {
        const item = entityForMergedStaple(stapleId, now);
        item.serverSequence = ++sequence;
        entities.set(entityKey(houseScope, 'staple_preference', stapleId), item);
      }
    }

    for (const [key] of sourceRows) entities.delete(key);
    for (const markerId of markerIds) processed.add(`${scopeKey(houseScope)}:${markerId}`);
    void userId;
    return {
      ...mergedLots.summary,
      importedStaples: incomingStaples.filter((id) => !existingStaples.includes(id)).length
        + sourceStaples.filter((id) => !existingStaples.includes(id)).length,
    };
  };

  return {
    applyMutation: async (userId, mutation) => {
      const prepared = prepareMutation(mutation, options);
      const scope = await resolveEntityScope(userId, prepared.mutation.entityType, options, prepared.mutation.syncScope);
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
        syncScope: scope.kind === 'house' ? `house:${scope.id}` : `account:${scope.id}`,
        serverSequence: ++sequence,
      };
      entities.set(key, item);
      return { applied: true, change: toChange(item) };
    },
    readChanges: async (userId, cursor, limit, requestedScope) => {
      const keys = new Set((await resolveReadScopes(userId, options, requestedScope)).map(scopeKey));
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
    mergeUserPantryToHouse: async (userId, houseId) => {
      const sourceScope = userScope(userId);
      const sourceRows = [...entities.entries()].filter(([key, item]) => entityScopeFor(sourceScope, key) && pantryTypes.has(item.entityType));
      return mergeMemoryPantry(
        userId,
        houseId,
        [],
        [],
        sourceRows,
        sourceRows.flatMap(([, item]) => [
          item.mutationId,
          guestMarkerForItem(item),
        ].filter((marker): marker is string => marker !== null)),
        `user:${userId}`,
      );
    },
    mergeGuestPantryToHouse: async (userId, houseId, input) => {
      const houseScope: SyncScope = { kind: 'house', id: houseId };
      const lotMarkers = input.lots.map((lot) => guestMarkerForLot(input.deviceId, lot));
      const pendingLots = input.lots.filter((lot, index) => !processed.has(`${scopeKey(houseScope)}:${lotMarkers[index]}`));
      const stapleMarkers = input.stapleIds.map((id) => `guest:${input.deviceId}:staple_preference:${id}:{"enabled":true}`);
      const pendingStaples = input.stapleIds.filter((id, index) => !processed.has(`${scopeKey(houseScope)}:${stapleMarkers[index]}`));
      return mergeMemoryPantry(
        userId,
        houseId,
        pendingLots,
        pendingStaples,
        [],
        [
          ...lotMarkers.filter((marker, index) => pendingLots.some((lot) => lot.id === input.lots[index]?.id)),
          ...stapleMarkers.filter((marker, index) => pendingStaples.includes(input.stapleIds[index]!)),
        ],
        `guest:${input.deviceId}`,
      );
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
  syncScope: item.scopeType === 'house' ? `house:${item.scopeId}` : `account:${item.scopeId}`,
  serverSequence: item.serverSequence,
});

export const createDrizzleSyncRepository = (
  database: ApplicationDatabase['db'],
  repositoryOptions: SyncRepositoryOptions = {},
): SyncRepository => {
  const options = resolveOptions(repositoryOptions);

  const mergeDatabasePantry = async (
    userId: string,
    houseId: string,
    input: { lots: PantryLot[]; stapleIds: string[]; deviceId?: string; includePersonalRows: boolean },
  ): Promise<PantryMergeSummary> => database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${houseId} FOR UPDATE`);
    const membershipRows = await transaction.execute(sql`SELECT id FROM ${houseMemberships} WHERE user_id = ${userId} AND house_id = ${houseId} FOR UPDATE`);
    if (membershipRows.length === 0) throw new SyncMembershipRequiredError();
    const houseRows = await transaction.select().from(syncItems).where(and(
      eq(syncItems.scopeType, 'house'),
      eq(syncItems.scopeId, houseId),
      inArray(syncItems.entityType, [...pantryTypes]),
    ));
    const sourceRows = input.includePersonalRows
      ? await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'user'),
        eq(syncItems.scopeId, userId),
        inArray(syncItems.entityType, [...pantryTypes]),
      ))
      : [];
    const sourceAliasMarkers = sourceRows
      .map((row) => guestMarkerForItem(fromDatabaseItem(row)))
      .filter((marker): marker is string => marker !== null);
    const sourceMutationIds = sourceRows.map((row) => row.mutationId);
    const sourceProcessedRows = sourceMutationIds.length === 0 ? [] : await transaction.select({ mutationId: processedSyncMutations.mutationId })
      .from(processedSyncMutations)
      .where(and(
        eq(processedSyncMutations.scopeType, 'house'),
        eq(processedSyncMutations.scopeId, houseId),
        inArray(processedSyncMutations.mutationId, sourceMutationIds),
      ));
    const sourceProcessed = new Set(sourceProcessedRows.map((row) => row.mutationId));
    const guestLotMarkers = input.deviceId === undefined
      ? []
      : input.lots.map((lot) => guestMarkerForLot(input.deviceId!, lot));
    const guestStapleMarkers = input.deviceId === undefined
      ? []
      : input.stapleIds.map((id) => `guest:${input.deviceId}:staple_preference:${id}:{"enabled":true}`);
    const guestMarkers = [...guestLotMarkers, ...guestStapleMarkers, ...sourceAliasMarkers];
    const guestProcessedRows = guestMarkers.length === 0 ? [] : await transaction.select({ mutationId: processedSyncMutations.mutationId })
      .from(processedSyncMutations)
      .where(and(
        eq(processedSyncMutations.scopeType, 'house'),
        eq(processedSyncMutations.scopeId, houseId),
        inArray(processedSyncMutations.mutationId, guestMarkers),
      ));
    const sourceMarkerPrefixes = sourceRows
      .map((row) => guestMarkerPrefixForItem(fromDatabaseItem(row)))
      .filter((prefix): prefix is string => prefix !== null);
    const inputMarkerPrefixes = input.deviceId === undefined ? [] : [
      ...input.lots.map((lot) => `guest:${input.deviceId}:pantry_lot:${lot.id}:`),
      ...input.stapleIds.map((id) => `guest:${input.deviceId}:staple_preference:${id}:`),
    ];
    const priorMarkerPrefixes = [...new Set([...sourceMarkerPrefixes, ...inputMarkerPrefixes])];
    const priorSourceProcessedRows = priorMarkerPrefixes.length === 0 ? [] : await transaction.select({ mutationId: processedSyncMutations.mutationId })
      .from(processedSyncMutations)
      .where(and(
        eq(processedSyncMutations.scopeType, 'house'),
        eq(processedSyncMutations.scopeId, houseId),
        or(...priorMarkerPrefixes.map((prefix) => like(processedSyncMutations.mutationId, `${prefix}%`))),
      ));
    const guestProcessed = new Set([
      ...guestProcessedRows.map((row) => row.mutationId),
      ...priorSourceProcessedRows.map((row) => row.mutationId),
    ]);
    const incomingLots = input.lots.filter((_, index) => !guestProcessed.has(guestLotMarkers[index]!));
    const incomingStaples = input.stapleIds.filter((_, index) => !guestProcessed.has(guestStapleMarkers[index]!));
    const housePantryRows = houseRows.map(fromDatabaseItem);
    const existingLots = housePantryRows
      .filter((row) => pantryItemTypes.has(row.entityType))
      .map(storedPantryLot)
      .filter((lot): lot is PantryLot => lot !== null);
    const existingStaples = housePantryRows
      .filter((row) => row.entityType === 'staple_preference' && !row.deleted
        && typeof row.payload === 'object' && row.payload !== null
        && (row.payload as { enabled?: unknown }).enabled === true)
      .map((row) => row.entityId);
    const supersededExistingIds = new Set<string>();
    const sourceRowsToMerge = sourceRows.filter((row) => {
      if (sourceProcessed.has(row.mutationId)) return false;
      const marker = guestMarkerForItem(fromDatabaseItem(row));
      if (marker !== null && guestProcessed.has(marker)) return false;
      const sourceLot = storedPantryLot(fromDatabaseItem(row));
      const previous = sourceLot === null ? undefined : existingLots.find((lot) => lot.id === sourceLot.id);
      const markerPrefix = guestMarkerPrefixForItem(fromDatabaseItem(row));
      const hasPriorRevision = markerPrefix !== null
        && [...guestProcessed].some((processedMarker) => processedMarker.startsWith(markerPrefix));
      if (sourceLot !== null && previous !== undefined && hasPriorRevision) {
        if (sourceLot.updatedAt <= previous.updatedAt) return false;
        supersededExistingIds.add(previous.id);
      }
      return true;
    });
    let existingLotsForMerge = existingLots.filter((lot) => !supersededExistingIds.has(lot.id));
    const sourceLots = sourceRowsToMerge
      .map((row) => storedPantryLot(fromDatabaseItem(row)))
      .filter((lot): lot is PantryLot => lot !== null);
    const sourceStaples = sourceRowsToMerge
      .filter((row) => row.entityType === 'staple_preference' && !row.deleted
        && typeof row.payload === 'object' && row.payload !== null
        && (row.payload as { enabled?: unknown }).enabled === true)
      .map((row) => row.entityId);
    const sourceDeviceId = input.deviceId === undefined ? null : input.deviceId;
    const revisionAwareIncomingLots = latestLotsById(incomingLots).filter((lot) => {
      const previous = existingLots.find((candidate) => candidate.id === lot.id);
      const priorRevision = sourceDeviceId === null ? null : latestGuestLotRevision([...guestProcessed], sourceDeviceId, lot.id);
      const hasPriorRevision = priorRevision !== null || (sourceDeviceId !== null
        && [...guestProcessed].some((processedMarker) => processedMarker.startsWith(`guest:${sourceDeviceId}:pantry_lot:${lot.id}:`)));
      if (!hasPriorRevision) return true;
      if (priorRevision !== null) {
        if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(priorRevision.updatedAt)) return false;
        const priorCandidate = existingLotsForMerge.find((candidate) => sameLotGroup(candidate, priorRevision));
        if (priorCandidate !== undefined) {
          const adjusted = removeLotContribution(priorCandidate, priorRevision);
          existingLotsForMerge = adjusted === null
            ? existingLotsForMerge.filter((candidate) => candidate.id !== priorCandidate.id)
            : existingLotsForMerge.map((candidate) => candidate.id === priorCandidate.id ? adjusted : candidate);
        } else if (previous !== undefined) {
          supersededExistingIds.add(previous.id);
          existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
        }
        return true;
      }
      if (previous === undefined) return true;
      if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(previous.updatedAt)) return false;
      supersededExistingIds.add(previous.id);
      existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
      return true;
    });
    const sourcePrefix = input.deviceId === undefined ? `user:${userId}` : `guest:${input.deviceId}`;
    const incomingForMerge = rekeyCollidingLots(existingLotsForMerge, [...sourceLots, ...revisionAwareIncomingLots], sourcePrefix);
    const mergedLots = mergePantryLots(existingLotsForMerge, incomingForMerge);
    const stapleIds = [...new Set([...existingStaples, ...sourceStaples, ...incomingStaples])];
    const now = options.clock();
    const currentLotsById = new Map(houseRows
      .filter((row) => row.entityType === 'pantry_lot' && !row.deleted)
      .map((row) => [row.entityId, row]));
    const currentStaples = houseRows.filter((row) => row.entityType === 'staple_preference' && !row.deleted);
    const lotsUnchanged = currentLotsById.size === mergedLots.lots.length
      && mergedLots.lots.every((lot) => entityMatches(currentLotsById.get(lot.id) === undefined
        ? undefined
        : fromDatabaseItem(currentLotsById.get(lot.id)!), 'pantry_lot', lot.id, lot));
    const staplesUnchanged = currentStaples.length === stapleIds.length
      && stapleIds.every((id) => entityMatches(
        currentStaples.find((row) => row.entityId === id) === undefined
          ? undefined
          : fromDatabaseItem(currentStaples.find((row) => row.entityId === id)!),
        'staple_preference',
        id,
        { enabled: true },
      ));

    if (!lotsUnchanged || !staplesUnchanged) {
      const finalKeys = new Set([
        ...mergedLots.lots.map((lot) => `pantry_lot:${lot.id}`),
        ...stapleIds.map((id) => `staple_preference:${id}`),
      ]);
      const tombstoneValues = houseRows
        .filter((row) => pantryTypes.has(row.entityType as SyncMutation['entityType']) && !finalKeys.has(`${row.entityType}:${row.entityId}`))
        .map((row) => ({
          userId,
          scopeType: 'house' as const,
          scopeId: houseId,
          entityType: row.entityType as SyncMutation['entityType'],
          entityId: row.entityId,
          deviceId: 'house-pantry-merge',
          payload: null,
          deleted: true,
          clientUpdatedAt: now,
          updatedAt: now,
          mutationId: `house-pantry-merge:delete:${row.entityType}:${row.entityId}`,
        }));
      await transaction.delete(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, houseId),
        inArray(syncItems.entityType, [...pantryTypes]),
      ));
      const lotValues = mergedLots.lots.map((lot) => ({
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        entityType: 'pantry_lot' as const,
        entityId: lot.id,
        deviceId: 'house-pantry-merge',
        payload: lot,
        deleted: false,
        clientUpdatedAt: new Date(lot.updatedAt),
        updatedAt: now,
        mutationId: `house-pantry-merge:pantry_lot:${lot.id}`,
      }));
      const stapleValues = stapleIds.map((stapleId) => ({
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        entityType: 'staple_preference' as const,
        entityId: stapleId,
        deviceId: 'house-pantry-merge',
        payload: { enabled: true },
        deleted: false,
        clientUpdatedAt: now,
        updatedAt: now,
        mutationId: `house-pantry-merge:staple_preference:${stapleId}`,
      }));
      const values = [...lotValues, ...stapleValues, ...tombstoneValues];
      if (values.length > 0) await transaction.insert(syncItems).values(values);
    }

    const markerIds = [...sourceMutationIds, ...sourceAliasMarkers, ...guestLotMarkers, ...guestStapleMarkers]
      .filter((mutationId) => !sourceProcessed.has(mutationId) && !guestProcessed.has(mutationId));
    if (markerIds.length > 0) {
      await transaction.insert(processedSyncMutations).values(markerIds.map((mutationId) => ({
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        mutationId,
      }))).onConflictDoNothing();
    }
    for (const sourceRow of sourceRows) {
      await transaction.delete(syncItems).where(and(
        eq(syncItems.id, sourceRow.id),
        eq(syncItems.mutationId, sourceRow.mutationId),
        eq(syncItems.clientUpdatedAt, sourceRow.clientUpdatedAt),
      ));
    }

    return {
      ...mergedLots.summary,
      importedStaples: incomingStaples.filter((id) => !existingStaples.includes(id)).length
        + sourceStaples.filter((id) => !existingStaples.includes(id)).length,
    };
  });

  return {
    applyMutation: async (userId, mutation) => {
      const prepared = prepareMutation(mutation, options);
      const scope = await resolveEntityScope(userId, prepared.mutation.entityType, options, prepared.mutation.syncScope);
      if (scope === null) throw new SyncMembershipRequiredError();
      return database.transaction(async (transaction) => {
        const validMutation = prepared.mutation;
        if (scope.kind === 'house') {
          await transaction.execute(sql`SELECT id FROM houses WHERE id = ${scope.id} FOR UPDATE`);
          const [membership] = await transaction.select({ id: houseMemberships.id })
            .from(houseMemberships)
            .where(and(
              eq(houseMemberships.houseId, scope.id),
              eq(houseMemberships.userId, userId),
            ))
            .limit(1);
          if (membership === undefined) throw new SyncMembershipRequiredError();
        }
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

  readChanges: async (userId, cursor, limit, requestedScope) => database.transaction(async (transaction) => {
    const scopes: SyncScope[] = [userScope(userId)];
    const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
      .from(houseMemberships)
      .where(eq(houseMemberships.userId, userId))
      .limit(1);
    let currentHouse: SyncScope | null = null;
    if (membership !== undefined) {
      const houseRows = await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR SHARE`);
      if (houseRows.length > 0) {
        const [currentMembership] = await transaction.select({ houseId: houseMemberships.houseId })
          .from(houseMemberships)
          .where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, membership.houseId)))
          .limit(1);
        if (currentMembership !== undefined) currentHouse = { kind: 'house', id: currentMembership.houseId };
      }
    }
    if (requestedScope === `account:${userId}`) {
      // Account reads intentionally exclude the shared house scope.
    } else if (requestedScope?.startsWith('account:')) {
      throw new SyncMembershipRequiredError();
    } else if (requestedScope?.startsWith('house:')) {
      if (currentHouse === null || requestedScope !== `house:${currentHouse.id}`) throw new SyncMembershipRequiredError();
      scopes.push(currentHouse);
    } else if (currentHouse !== null) {
      scopes.push(currentHouse);
    }
    const scopeCondition = scopes.length === 1
      ? and(eq(syncItems.scopeType, scopes[0]!.kind), eq(syncItems.scopeId, scopes[0]!.id))
      : or(...scopes.map((scope) => and(eq(syncItems.scopeType, scope.kind), eq(syncItems.scopeId, scope.id))));
    const rows = await transaction.select().from(syncItems).where(and(
      scopeCondition,
      gt(syncItems.serverSequence, cursor),
    )).orderBy(asc(syncItems.serverSequence)).limit(limit);
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  }),

  readAll: async (userId) => database.transaction(async (transaction) => {
    const scopes: SyncScope[] = [userScope(userId)];
    const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
      .from(houseMemberships)
      .where(eq(houseMemberships.userId, userId))
      .limit(1);
    if (membership !== undefined) {
      const houseRows = await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR SHARE`);
      if (houseRows.length > 0) {
        const [currentMembership] = await transaction.select({ houseId: houseMemberships.houseId })
          .from(houseMemberships)
          .where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, membership.houseId)))
          .limit(1);
        if (currentMembership !== undefined) scopes.push({ kind: 'house', id: currentMembership.houseId });
      }
    }
    const scopeCondition = scopes.length === 1
      ? and(eq(syncItems.scopeType, scopes[0]!.kind), eq(syncItems.scopeId, scopes[0]!.id))
      : or(...scopes.map((scope) => and(eq(syncItems.scopeType, scope.kind), eq(syncItems.scopeId, scope.id))));
    const rows = await transaction.select().from(syncItems)
      .where(scopeCondition)
      .orderBy(asc(syncItems.serverSequence));
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  }),

  readEntity: async (userId, entityType, entityId) => database.transaction(async (transaction) => {
    let scope: SyncScope = userScope(userId);
    if (isSharedEntityType(entityType)) {
      const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
        .from(houseMemberships)
        .where(eq(houseMemberships.userId, userId))
        .limit(1);
      if (membership !== undefined) {
        const houseRows = await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR SHARE`);
        if (houseRows.length > 0) {
          const [currentMembership] = await transaction.select({ houseId: houseMemberships.houseId })
            .from(houseMemberships)
            .where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, membership.houseId)))
            .limit(1);
          if (currentMembership !== undefined) scope = { kind: 'house', id: currentMembership.houseId };
        }
      }
    }
    const [row] = await transaction.select().from(syncItems).where(and(
      eq(syncItems.scopeType, scope.kind),
      eq(syncItems.scopeId, scope.id),
      eq(syncItems.entityType, entityType),
      eq(syncItems.entityId, entityId),
    )).limit(1);
    return row === undefined ? null : fromDatabaseItem(row);
  }),

  mergeUserPantryToHouse: (userId, houseId) => mergeDatabasePantry(userId, houseId, {
    lots: [],
    stapleIds: [],
    includePersonalRows: true,
  }),

  mergeGuestPantryToHouse: (userId, houseId, input) => mergeDatabasePantry(userId, houseId, {
    lots: input.lots,
    stapleIds: input.stapleIds,
    deviceId: input.deviceId,
    includePersonalRows: false,
  }),

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
