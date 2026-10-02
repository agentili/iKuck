import type {
  CookEvent,
  DietProfile,
  HouseState,
  RecipePreference,
  ShoppingListItem,
  SyncChange,
  SyncChangeSet,
  SyncEntityType,
  SyncMutation,
  SyncOperation,
} from '@ikuck/shared/contracts';
import { HOUSE_SYNC_ENTITY_TYPES } from '@ikuck/shared/contracts';
import type { PantryMergeSummary } from '@ikuck/shared/pantryMerge';
import type { DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { isDinnerEntry, isSavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';
import {
  deleteMeta,
  deleteQueueScope,
  deleteQueueValue,
  readMeta,
  readQueueValues,
  type SyncScope,
  writeMeta,
  writeQueueValue,
} from '../storage/indexedDb';
import {
  createPresencePantryLot,
  clearPantrySnapshot,
  derivePantryItems,
  isPantryLot,
  normalizePantrySnapshot,
  readPantrySnapshot,
  writePantrySnapshot,
  type PantrySnapshot,
} from '../storage/pantryStorage';
import { isCookEvent, isRecipePreference } from '../domain/activity';
import { DEFAULT_DIET_PROFILE, isDietProfile, normalizeDietProfile } from '../domain/dietary';
import { isShoppingListItem } from '../domain/shoppingList';
import {
  clearCookEvents,
  clearRecipePreferences,
  readCookEvents,
  readRecipePreferences,
  writeCookEvents,
  writeRecipePreferences,
} from '../storage/activityStorage';
import { clearShoppingList, readShoppingList, writeShoppingList } from '../storage/shoppingListStorage';
import { clearDietProfile, readDietProfile, readPersistedDietProfile, writeDietProfile } from '../storage/dietProfileStorage';
import { clearDinnerDiary, clearDinnerDiaryRecords, readDinnerEntries, readSavedRecipes, writeDinnerEntries, writeSavedRecipes } from '../storage/dinnerDiaryStorage';
import { assertSyncMutation, isPantryItemPayload, isStaplePreferencePayload } from './validation';
import { getActiveDataScope, getPersonalDataScope, setActiveDataScope, setPersonalDataScope } from './scopeContext';
import { completeScopePurge, hasPendingScopePurge, revokeScope, resumeScope, trackScopedWrite, waitForScopedWrites } from './scopeWriteFence';

const DEVICE_ID_META_KEY = 'deviceId';
const IMPORT_MUTATION_IDS_META_PREFIX = 'importMutationIds:';
const MAX_MUTATIONS_PER_REQUEST = 100;
const SERVER_CHANGE_PAGE_SIZE = 200;
// Bound page draining so a malformed server cursor cannot create an infinite sync loop.
const MAX_SYNC_PAGES = 100;

export type { SyncScope } from '../storage/indexedDb';
export const GUEST_SYNC_SCOPE: SyncScope = 'guest';

export const getAccountSyncScope = (userId: string): SyncScope => `account:${userId}`;

const SHARED_ENTITY_TYPES = new Set<SyncEntityType>(HOUSE_SYNC_ENTITY_TYPES);

export const getMutationScope = (
  entityType: SyncEntityType,
  activeScope: SyncScope = getActiveDataScope(),
  personalScope: SyncScope = getPersonalDataScope(),
): SyncScope => (
  SHARED_ENTITY_TYPES.has(entityType) ? activeScope : personalScope
);

const cursorMetaKey = (scope: SyncScope): string => `syncCursor:${scope}`;

const guestSnapshotFingerprint = (snapshot: PantrySnapshot): string => {
  const normalized = normalizePantrySnapshot(snapshot);
  return JSON.stringify({
    pantryItems: [...normalized.pantryItems].sort((left, right) => left.id.localeCompare(right.id)),
    pantryLots: [...(normalized.pantryLots ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    stapleIds: [...normalized.stapleIds].sort(),
  });
};

const pendingScopeApplications = new Map<SyncScope, Set<Promise<void>>>();

const clearFunctionalSnapshots = async (scope: SyncScope, preservePersonalDrafts = false): Promise<void> => {
  await Promise.allSettled([...(pendingScopeApplications.get(scope) ?? [])]);
  await waitForScopedWrites(scope);
  await pendingQueueWrites;
  const cleared = await Promise.allSettled([
    clearPantrySnapshot(scope),
    clearShoppingList(scope),
    clearCookEvents(scope),
    clearRecipePreferences(scope),
    clearDietProfile(scope),
    preservePersonalDrafts ? clearDinnerDiaryRecords(scope) : clearDinnerDiary(scope),
  ]);
  const failure = cleared.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure !== undefined) throw failure.reason;
};

const pendingScopePurges = new Map<SyncScope, Promise<void>>();
export function clearDataScope(scope: SyncScope): Promise<void> {
  const inFlight = pendingScopePurges.get(scope);
  if (inFlight !== undefined) return inFlight;
  // Persist purge intent before waiting on any local write. On failure or
  // reload, the old House cannot be displayed or reactivated without a retry.
  if (scope.startsWith('house:')) revokeScope(scope);
  const purging = (async () => {
    await clearFunctionalSnapshots(scope);
    await deleteQueueScope(scope);
    await deleteMeta(cursorMetaKey(scope));
    await deleteMeta(`${IMPORT_MUTATION_IDS_META_PREFIX}${scope}`);
    if (scope.startsWith('house:')) completeScopePurge(scope);
  })();
  pendingScopePurges.set(scope, purging);
  void purging.then(() => {
    if (pendingScopePurges.get(scope) === purging) pendingScopePurges.delete(scope);
  }, () => {
    if (pendingScopePurges.get(scope) === purging) pendingScopePurges.delete(scope);
  });
  return purging;
}

export interface SyncSession {
  userId: string;
  emailVerifiedAt: string;
  csrfToken: string;
}

export interface QueuedMutation extends SyncMutation {
  scope: SyncScope;
  createdAt: string;
}

interface SyncRequestOptions {
  fetch?: typeof globalThis.fetch;
  request?: ApiRequest;
  session: SyncSession;
  isSessionCurrent?: () => boolean;
  onMembershipLost?: () => void;
}

interface SyncPage extends SyncChangeSet {
  hasMore?: boolean;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  pending: number;
  complete: boolean;
}

export type SyncStatusState = 'idle' | 'syncing' | 'success' | 'error';

export interface SyncStatusSnapshot {
  state: SyncStatusState;
  error: unknown | null;
}

export class SyncSessionChangedError extends Error {
  readonly code = 'session_changed';

  constructor() {
    super('The active session changed while synchronizing');
    this.name = 'SyncSessionChangedError';
  }
}

export class SyncScopeChangedError extends Error {
  readonly code = 'scope_changed';

  constructor() {
    super('The active data scope changed while synchronizing');
    this.name = 'SyncScopeChangedError';
  }
}

export class SyncResponseScopeError extends Error {
  readonly code = 'invalid_response_scope';

  constructor() {
    super('A server change belongs to a different account or house');
    this.name = 'SyncResponseScopeError';
  }
}

export class SyncCursorStalledError extends Error {
  readonly code = 'cursor_stalled';

  constructor() {
    super('The sync cursor did not advance while more changes were available');
    this.name = 'SyncCursorStalledError';
  }
}

const syncPromises = new Map<string, Promise<SyncResult>>();
const syncStatuses = new Map<SyncScope, SyncStatusSnapshot>();
const syncStatusListeners = new Map<SyncScope, Set<(status: SyncStatusSnapshot) => void>>();
let pendingQueueWrites = Promise.resolve();
let pendingImportMutationIdWrites: Promise<unknown> = Promise.resolve();
const pantrySnapshotListeners = new Set<(snapshot: PantrySnapshot) => void>();
const shoppingListListeners = new Set<(items: ShoppingListItem[]) => void>();
const activitySnapshotListeners = new Set<(snapshot: {
  events: CookEvent[];
  preferences: RecipePreference[];
}) => void>();
const dietProfileSnapshotListeners = new Set<(profile: DietProfile) => void>();
export interface DinnerDiarySnapshot {
  scope: SyncScope;
  entries: DinnerEntry[];
  recipes: SavedRecipe[];
}
const dinnerDiarySnapshotListeners = new Set<(snapshot: DinnerDiarySnapshot) => void>();

const idleSyncStatus = (): SyncStatusSnapshot => ({ state: 'idle', error: null });

const setSyncStatus = (scope: SyncScope, status: SyncStatusSnapshot): void => {
  syncStatuses.set(scope, status);
  for (const listener of syncStatusListeners.get(scope) ?? []) listener(status);
};

export function getSyncStatus(scope: SyncScope): SyncStatusSnapshot {
  return syncStatuses.get(scope) ?? idleSyncStatus();
}

export function subscribeSyncStatus(
  scope: SyncScope,
  listener: (status: SyncStatusSnapshot) => void,
): () => void {
  const listeners = syncStatusListeners.get(scope) ?? new Set<(status: SyncStatusSnapshot) => void>();
  listeners.add(listener);
  syncStatusListeners.set(scope, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) syncStatusListeners.delete(scope);
  };
}

const createRandomId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

type ImportMutationIdLedger = Record<string, { fingerprint: string; mutationId: string }>;

const canonicalizeImportValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeImportValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalizeImportValue(nested)]));
};

const fingerprintImportPayload = async (payload: unknown): Promise<string> => {
  const serialized = JSON.stringify(canonicalizeImportValue(payload)) ?? 'null';
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('Web Crypto is required to fingerprint an import revision safely');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const getImportMutationId = (
  scope: SyncScope,
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: unknown | null,
): Promise<string> => {
  const previous = pendingImportMutationIdWrites;
  const write = trackScopedWrite(scope, () => previous.then(async () => {
    const fingerprint = await fingerprintImportPayload(payload);
    const metaKey = `${IMPORT_MUTATION_IDS_META_PREFIX}${scope}`;
    const ledger = await readMeta<ImportMutationIdLedger>(metaKey) ?? {};
    const entityKey = JSON.stringify([entityType, entityId, operation]);
    const existing = ledger[entityKey];
    if (existing?.fingerprint === fingerprint) return existing.mutationId;
    const mutationId = `import:${createRandomId()}`;
    await writeMeta(metaKey, { ...ledger, [entityKey]: { fingerprint, mutationId } });
    return mutationId;
  }));
  pendingImportMutationIdWrites = write.catch(() => undefined);
  return write;
};

const compareMutations = (left: QueuedMutation, right: QueuedMutation): number => {
  const timestampOrder = left.clientUpdatedAt.localeCompare(right.clientUpdatedAt);
  return timestampOrder === 0 ? left.mutationId.localeCompare(right.mutationId) : timestampOrder;
};

const ensureVerifiedSession = (session: SyncSession): void => {
  if (session.emailVerifiedAt.trim() === '') {
    throw new ApiClientError(403, 'email_not_verified', 'Email verification is required');
  }
  if (session.csrfToken.trim() === '') {
    throw new ApiClientError(403, 'csrf_failed', 'CSRF token is required');
  }
};

export async function getDeviceId(): Promise<string> {
  const existing = await readMeta<string>(DEVICE_ID_META_KEY);
  if (existing !== null && existing.trim() !== '') return existing;

  const deviceId = createRandomId();
  await writeMeta(DEVICE_ID_META_KEY, deviceId);
  return deviceId;
}

export async function createPantryMutation(
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: unknown | null,
): Promise<SyncMutation> {
  return assertSyncMutation({
    mutationId: createRandomId(),
    deviceId: await getDeviceId(),
    entityType,
    entityId,
    operation,
    payload,
    clientUpdatedAt: new Date().toISOString(),
  });
}

const createImportMutation = async (
  scope: SyncScope,
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: unknown | null,
): Promise<SyncMutation> => {
  const mutation = await createPantryMutation(entityType, entityId, operation, payload);
  return {
    ...mutation,
    mutationId: await getImportMutationId(scope, entityType, entityId, operation, payload),
  };
};

const queueMutationWrite = (scope: SyncScope, mutation: SyncMutation): Promise<void> => {
  const previous = pendingQueueWrites;
  const operation = trackScopedWrite(scope, () => previous.then(() => writeQueueValue<QueuedMutation>({
    ...mutation,
    scope,
    createdAt: new Date().toISOString(),
  })));
  pendingQueueWrites = operation.catch(() => undefined);
  return operation;
};

export async function enqueueMutation(scope: SyncScope, mutation: SyncMutation): Promise<void> {
  await queueMutationWrite(scope, assertSyncMutation(mutation));
}

export function enqueuePantryMutation(
  scope: SyncScope,
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: unknown | null,
): Promise<void> {
  const previous = pendingQueueWrites;
  const operationPromise = trackScopedWrite(scope, () => previous
    .then(() => createPantryMutation(entityType, entityId, operation, payload))
    .then((mutation) => writeQueueValue<QueuedMutation>({
      ...mutation,
      scope,
      createdAt: new Date().toISOString(),
    })));
  pendingQueueWrites = operationPromise.catch(() => undefined);
  return operationPromise;
}

export function enqueueEntityMutation(
  scope: SyncScope,
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: unknown | null,
): Promise<void> {
  return enqueuePantryMutation(scope, entityType, entityId, operation, payload);
}

export async function waitForPendingQueueWrites(): Promise<void> {
  await pendingQueueWrites;
}

export async function importLocalData(session: SyncSession, isSessionCurrent: () => boolean): Promise<SyncResult> {
  ensureVerifiedSession(session);
  const accountScope = getAccountSyncScope(session.userId);
  const activeScope = getActiveDataScope();
  const personalScope = getPersonalDataScope();
  const isCurrentScope = (): boolean => getActiveDataScope() === activeScope
    && getPersonalDataScope() === personalScope && personalScope === accountScope && activeScope !== 'guest';
  const isCurrent = (): boolean => isSessionCurrent() && isCurrentScope();
  const assertCurrent = (): void => {
    if (!isSessionCurrent()) throw new SyncSessionChangedError();
    if (!isCurrentScope()) throw new SyncScopeChangedError();
  };
  assertCurrent();
  const importEntity = async (entityType: SyncEntityType, entityId: string, payload: unknown): Promise<void> => {
    assertCurrent();
    const targetScope = getMutationScope(entityType, activeScope, personalScope);
    const mutation = await createImportMutation(targetScope, entityType, entityId, 'upsert', payload);
    assertCurrent();
    await enqueueMutation(targetScope, mutation);
    assertCurrent();
  };
  const snapshot = normalizePantrySnapshot(await readPantrySnapshot(GUEST_SYNC_SCOPE) ?? { pantryItems: [], stapleIds: [] });
  assertCurrent();

  if (activeScope.startsWith('house:')) {
    if ((snapshot.pantryLots?.length ?? 0) > 0 || snapshot.stapleIds.length > 0) {
      await mergeGuestPantryIntoHouse(session, activeScope.slice('house:'.length), apiRequest, isCurrent);
      assertCurrent();
    }
  } else {
    for (const lot of snapshot.pantryLots ?? []) await importEntity('pantry_lot', lot.id, lot);
    for (const stapleId of snapshot.stapleIds) await importEntity('staple_preference', stapleId, { enabled: true });
  }
  for (const item of await readShoppingList(GUEST_SYNC_SCOPE)) await importEntity('shopping_list_item', item.id, item);
  for (const event of await readCookEvents(GUEST_SYNC_SCOPE)) await importEntity('cook_event', event.id, event);
  for (const preference of await readRecipePreferences(GUEST_SYNC_SCOPE)) {
    await importEntity('recipe_preference', preference.recipeId, preference);
  }
  for (const entry of await readDinnerEntries(GUEST_SYNC_SCOPE)) await importEntity('dinner_entry', entry.id, entry);
  for (const recipe of await readSavedRecipes(GUEST_SYNC_SCOPE)) await importEntity('saved_recipe', recipe.id, recipe);
  const guestProfile = await readPersistedDietProfile(GUEST_SYNC_SCOPE);
  if (guestProfile !== null) {
    if (activeScope.startsWith('house:')) {
      assertCurrent();
      const mutation = await createImportMutation(activeScope, 'diet_profile', 'profile', 'upsert', guestProfile);
      assertCurrent();
      await apiRequest<void>('/v1/house/diet-profile/import', {
        method: 'POST',
        csrfToken: session.csrfToken,
        body: { mutation },
      });
      assertCurrent();
    } else {
      await importEntity('diet_profile', 'profile', guestProfile);
    }
  }
  assertCurrent();
  return syncNow({ session, isSessionCurrent: isCurrent });
}

class ScopeInitializationCancelledError extends Error {
  constructor() {
    super('Session scope initialization was cancelled');
    this.name = 'ScopeInitializationCancelledError';
  }
}

const PANTRY_MERGE_ENTITY_TYPES = new Set<SyncEntityType>([
  'pantry_item',
  'pantry_lot',
  'staple_preference',
]);

const clearQueueScope = async (scope: SyncScope, mutationIds?: ReadonlySet<string>): Promise<void> => {
  const queued = await readQueueValues<QueuedMutation>(scope);
  for (const mutation of queued) {
    if (PANTRY_MERGE_ENTITY_TYPES.has(mutation.entityType)
      && (mutationIds === undefined || mutationIds.has(mutation.mutationId))) {
      await deleteQueueValue(mutation.mutationId, scope);
    }
  }
};

export async function mergeGuestPantryIntoHouse(
  session: SyncSession,
  houseId: string,
  request: ApiRequest = apiRequest,
  isCurrent: () => boolean = () => true,
): Promise<PantryMergeSummary> {
  ensureVerifiedSession(session);
  void houseId;
  await waitForPendingQueueWrites();
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  const submittedSnapshot = normalizePantrySnapshot(await readPantrySnapshot(GUEST_SYNC_SCOPE) ?? { pantryItems: [], stapleIds: [] });
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  const submittedFingerprint = guestSnapshotFingerprint(submittedSnapshot);
  const submittedQueue = await readQueueValues<QueuedMutation>(GUEST_SYNC_SCOPE);
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  const submittedPantryMutationIds = new Set(
    submittedQueue.filter((mutation) => PANTRY_MERGE_ENTITY_TYPES.has(mutation.entityType)).map((mutation) => mutation.mutationId),
  );
  const deviceId = await getDeviceId();
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  const response = await request<{ summary: PantryMergeSummary }>('/v1/house/pantry/merge', {
    method: 'POST',
    csrfToken: session.csrfToken,
    body: {
      deviceId,
      lots: submittedSnapshot.pantryLots ?? [],
      stapleIds: submittedSnapshot.stapleIds,
    },
  });
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  await waitForPendingQueueWrites();
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  const currentSnapshot = normalizePantrySnapshot(await readPantrySnapshot(GUEST_SYNC_SCOPE) ?? { pantryItems: [], stapleIds: [] });
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  const currentQueue = await readQueueValues<QueuedMutation>(GUEST_SYNC_SCOPE);
  if (!isCurrent()) throw new ScopeInitializationCancelledError();
  const hasConcurrentPantryMutation = currentQueue.some((mutation) => PANTRY_MERGE_ENTITY_TYPES.has(mutation.entityType)
    && !submittedPantryMutationIds.has(mutation.mutationId));
  if (guestSnapshotFingerprint(currentSnapshot) === submittedFingerprint) {
    await clearQueueScope(GUEST_SYNC_SCOPE, submittedPantryMutationIds);
    if (!hasConcurrentPantryMutation) await clearPantrySnapshot(GUEST_SYNC_SCOPE);
  }
  return response.summary;
}

export interface SessionScopeInitialization {
  state: HouseState | null;
  mergeSummary: PantryMergeSummary | null;
  guestMergeFailed: boolean;
}

export async function initializeSessionScope(
  session: SyncSession,
  request: ApiRequest = apiRequest,
  isCurrent: () => boolean = () => true,
): Promise<SessionScopeInitialization> {
  ensureVerifiedSession(session);
  const ensureCurrent = (): void => {
    if (!isCurrent()) throw new ScopeInitializationCancelledError();
  };
  const accountScope = getAccountSyncScope(session.userId);
  const previousActiveScope = getActiveDataScope();
  const previousPersonalScope = getPersonalDataScope();
  let confirmedScope: SyncScope | null = null;
  try {
    const state = await request<HouseState | null>('/v1/house');
    ensureCurrent();
    const nextActiveScope: SyncScope = state?.house?.id === undefined ? accountScope : `house:${state.house.id}`;
    confirmedScope = nextActiveScope;
    if (previousActiveScope.startsWith('house:')
      && previousActiveScope !== nextActiveScope
      && getActiveDataScope() === previousActiveScope) {
      await clearDataScope(previousActiveScope);
      ensureCurrent();
    }
    ensureCurrent();
    setActiveDataScope(GUEST_SYNC_SCOPE);
    setPersonalDataScope(accountScope);
    // Guest data belongs to the device, not to the authenticated house.
    // Only the explicit Profile import may call mergeGuestPantryIntoHouse.
    if (state?.house !== null && state?.house !== undefined) {
      const houseScope: SyncScope = `house:${state.house.id}`;
      // A prior departure may have failed mid-purge (even across a reload).
      // Never reactivate that House's old queue or cursor on re-admission.
      if (hasPendingScopePurge(houseScope)) {
        await clearDataScope(houseScope);
        ensureCurrent();
      }
      await waitForPendingQueueWrites();
      ensureCurrent();
      // Diary store mutations enter the queue only after their chained local
      // write finishes; drain those submissions before moving account rows.
      await waitForScopedWrites(accountScope);
      ensureCurrent();
      // Replaying stale account pantry/diet as ordinary House upserts could
      // remove another member's lot or allergen. Import the original account
      // mutations on the server and let its semantic migration resolve them.
      await importPendingAccountQueue(session, request, accountScope, ensureCurrent);
      ensureCurrent();
      // The server migrated these records; keep the personal consent queue,
      // account cursor and local-only recipe drafts, never obsolete functional snapshots.
      await clearFunctionalSnapshots(accountScope, true);
      ensureCurrent();
      resumeScope(houseScope);
      setActiveDataScope(houseScope);
    } else {
      ensureCurrent();
      setActiveDataScope(accountScope);
      setPersonalDataScope(accountScope);
    }
    return { state, mergeSummary: null, guestMergeFailed: false };
  } catch (error) {
    if (!isCurrent()) throw error;
    // A failed purge is not a completed scope transition. Retain the revoked
    // namespace (and durable retry marker) rather than exposing old House data
    // or silently claiming that an account migration succeeded.
    if (previousActiveScope.startsWith('house:') && hasPendingScopePurge(previousActiveScope)) throw error;
    if (confirmedScope?.startsWith('house:')) {
      if (hasPendingScopePurge(confirmedScope)) {
        setActiveDataScope(confirmedScope);
        setPersonalDataScope(accountScope);
        throw error;
      }
      // Cleanup errors cannot turn a confirmed member into an account-scoped
      // user; keep house data isolated and let the next bootstrap retry.
      resumeScope(confirmedScope);
      setActiveDataScope(confirmedScope);
      setPersonalDataScope(accountScope);
      throw error;
    }
    if (confirmedScope === null || confirmedScope === previousActiveScope) {
      setActiveDataScope(previousPersonalScope === accountScope ? previousActiveScope : accountScope);
      setPersonalDataScope(accountScope);
      throw error;
    }
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    throw error;
  }
}

const toMutation = ({ createdAt, scope, ...mutation }: QueuedMutation): SyncMutation => {
  void createdAt;
  return {
    ...mutation,
    syncScope: scope === 'guest' ? undefined : scope,
  };
};

async function importPendingAccountQueue(
  session: SyncSession,
  request: ApiRequest,
  accountScope: SyncScope,
  assertCurrent: () => void,
  fetch?: typeof globalThis.fetch,
): Promise<void> {
  await waitForPendingQueueWrites();
  await waitForScopedWrites(accountScope);
  assertCurrent();
  const queued = (await readQueueValues<QueuedMutation>(accountScope))
    .filter((mutation) => SHARED_ENTITY_TYPES.has(mutation.entityType))
    .sort(compareMutations);
  assertCurrent();
  for (let offset = 0; offset < queued.length; offset += MAX_MUTATIONS_PER_REQUEST) {
    const batch = queued.slice(offset, offset + MAX_MUTATIONS_PER_REQUEST);
    assertCurrent();
    await request<void>('/v1/house/account-queue/import', {
      method: 'POST',
      csrfToken: session.csrfToken,
      fetch,
      body: { mutations: batch.map(toMutation) },
    });
    assertCurrent();
    for (const mutation of batch) {
      await deleteQueueValue(mutation.mutationId, accountScope);
      assertCurrent();
    }
  }
}

const syncQueueScopes = (accountScope: SyncScope, activeScope: SyncScope): SyncScope[] => (
  activeScope.startsWith('house:') ? [accountScope, activeScope] : [accountScope]
);

const readPendingSyncMutations = async (accountScope: SyncScope, activeScope: SyncScope): Promise<QueuedMutation[]> => {
  const values = await Promise.all(syncQueueScopes(accountScope, activeScope).map((scope) => readQueueValues<QueuedMutation>(scope)));
  return values.flat().sort(compareMutations);
};

export async function readQueuedMutations(scope: SyncScope): Promise<SyncMutation[]> {
  const values = await readQueueValues<QueuedMutation>(scope);
  return values.sort(compareMutations).map(toMutation);
}

export async function readSyncCursor(scope: SyncScope): Promise<number> {
  const cursor = await readMeta<number>(cursorMetaKey(scope));
  return cursor ?? 0;
}

const isMergePreservingPantryItemTombstone = (change: SyncChange): boolean => change.operation === 'delete'
  && change.entityType === 'pantry_item'
  && change.deviceId === 'house-pantry-merge'
  && change.syncScope?.startsWith('house:') === true
  && change.mutationId.startsWith('house-pantry-merge:delete:pantry_item:');

const applyChangeToSnapshot = (snapshot: PantrySnapshot, change: SyncChange): PantrySnapshot => {
  const normalizedSnapshot = normalizePantrySnapshot(snapshot);

  if (change.entityType === 'pantry_lot') {
    const pantryLots = (normalizedSnapshot.pantryLots ?? []).filter((lot) => lot.id !== change.entityId);
    if (change.operation === 'upsert' && isPantryLot(change.payload)) pantryLots.push(change.payload);
    return {
      ...normalizedSnapshot,
      pantryItems: derivePantryItems(pantryLots),
      pantryLots,
    };
  }

  if (change.entityType === 'pantry_item') {
    const pantryLotsForIngredient = (normalizedSnapshot.pantryLots ?? []).filter((lot) => lot.ingredientId === change.entityId);
    const pantryLots = change.operation === 'delete' && !isMergePreservingPantryItemTombstone(change)
      ? (normalizedSnapshot.pantryLots ?? []).filter((lot) => lot.ingredientId !== change.entityId)
      : (normalizedSnapshot.pantryLots ?? []);
    const pantryItems = normalizedSnapshot.pantryItems.filter((item) => item.id !== change.entityId);
    if (change.operation === 'upsert' && isPantryItemPayload(change.payload)
      && change.payload.id === change.entityId) {
      pantryItems.push(change.payload);
      if (pantryLotsForIngredient.length === 0) pantryLots.push(createPresencePantryLot(change.payload));
    }
    return { ...normalizedSnapshot, pantryItems: derivePantryItems(pantryLots), pantryLots };
  }

  const enabled = isStaplePreferencePayload(change.payload) && change.payload.enabled;
  const stapleIds = normalizedSnapshot.stapleIds.filter((id) => id !== change.entityId);
  return enabled ? { ...normalizedSnapshot, stapleIds: [...stapleIds, change.entityId] } : { ...normalizedSnapshot, stapleIds };
};

const applyServerChanges = async (
  changes: SyncChange[],
  activeScope: SyncScope,
  personalScope: SyncScope,
  assertCurrentContext: () => void,
): Promise<void> => {
  if (changes.length === 0) return;
  const current = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrentContext();
    const result = await operation();
    assertCurrentContext();
    return result;
  };

  const pantryChanges = changes.filter((change) => change.entityType === 'pantry_item'
    || change.entityType === 'pantry_lot'
    || change.entityType === 'staple_preference');
  const pantryChangesByScope = new Map<SyncScope, SyncChange[]>();
  for (const change of pantryChanges) {
    const targetScope = change.syncScope?.startsWith('account:') ? personalScope : activeScope;
    const scopedChanges = pantryChangesByScope.get(targetScope) ?? [];
    scopedChanges.push(change);
    pantryChangesByScope.set(targetScope, scopedChanges);
  }
  for (const [targetScope, scopedChanges] of pantryChangesByScope) {
    let snapshot = await current(() => readPantrySnapshot(targetScope)) ?? { pantryItems: [], stapleIds: [] };
    for (const change of scopedChanges) {
      snapshot = applyChangeToSnapshot(snapshot, change);
    }
    await current(() => writePantrySnapshot(snapshot, targetScope));
    if (targetScope === activeScope) {
      for (const listener of pantrySnapshotListeners) {
        assertCurrentContext();
        listener(snapshot);
      }
    }
  }

  const shoppingChanges = changes.filter((change) => change.entityType === 'shopping_list_item');
  const shoppingChangesByScope = new Map<SyncScope, SyncChange[]>();
  for (const change of shoppingChanges) {
    const targetScope = change.syncScope?.startsWith('account:') ? personalScope : activeScope;
    const scopedChanges = shoppingChangesByScope.get(targetScope) ?? [];
    scopedChanges.push(change);
    shoppingChangesByScope.set(targetScope, scopedChanges);
  }
  for (const [targetScope, scopedChanges] of shoppingChangesByScope) {
    let items = await current(() => readShoppingList(targetScope));
    for (const change of scopedChanges) {
      items = items.filter((item) => item.id !== change.entityId);
      if (change.operation === 'upsert' && isShoppingListItem(change.payload)) items.push(change.payload);
    }
    await current(() => writeShoppingList(items, targetScope));
    if (targetScope === activeScope) for (const listener of shoppingListListeners) {
      assertCurrentContext();
      listener(items);
    }
  }

  const activityChanges = changes.filter((change) => change.entityType === 'cook_event'
    || change.entityType === 'recipe_preference');
  const activityChangesByScope = new Map<SyncScope, SyncChange[]>();
  for (const change of activityChanges) {
    const targetScope = change.syncScope?.startsWith('account:') ? personalScope : activeScope;
    const scopedChanges = activityChangesByScope.get(targetScope) ?? [];
    scopedChanges.push(change);
    activityChangesByScope.set(targetScope, scopedChanges);
  }
  for (const [targetScope, scopedChanges] of activityChangesByScope) {
    let events = await current(() => readCookEvents(targetScope));
    let preferences = await current(() => readRecipePreferences(targetScope));
    let hasEventChanges = false;
    let hasPreferenceChanges = false;
    for (const change of scopedChanges) {
      if (change.entityType === 'cook_event') {
        hasEventChanges = true;
        events = events.filter((event) => event.id !== change.entityId);
        if (change.operation === 'upsert' && isCookEvent(change.payload)) events.push(change.payload);
      } else {
        hasPreferenceChanges = true;
        preferences = preferences.filter((preference) => preference.recipeId !== change.entityId);
        if (change.operation === 'upsert' && isRecipePreference(change.payload)) preferences.push(change.payload);
      }
    }
    if (hasEventChanges) await current(() => writeCookEvents(events, targetScope));
    if (hasPreferenceChanges) await current(() => writeRecipePreferences(preferences, targetScope));
    if (targetScope === activeScope) {
      const snapshot = { events, preferences };
      for (const listener of activitySnapshotListeners) {
        assertCurrentContext();
        listener(snapshot);
      }
    }
  }

  const diaryChanges = changes.filter((change) => change.entityType === 'dinner_entry' || change.entityType === 'saved_recipe');
  const diaryChangesByScope = new Map<SyncScope, SyncChange[]>();
  for (const change of diaryChanges) {
    const targetScope = change.syncScope?.startsWith('account:') ? personalScope : activeScope;
    const scopedChanges = diaryChangesByScope.get(targetScope) ?? [];
    scopedChanges.push(change);
    diaryChangesByScope.set(targetScope, scopedChanges);
  }
  for (const [targetScope, scopedChanges] of diaryChangesByScope) {
    let entries = await current(() => readDinnerEntries(targetScope));
    let recipes = await current(() => readSavedRecipes(targetScope));
    for (const change of scopedChanges) {
      if (change.entityType === 'dinner_entry') {
        if (change.operation === 'delete') {
          entries = entries.filter((entry) => entry.id !== change.entityId);
        } else if (isDinnerEntry(change.payload) && change.payload.id === change.entityId) {
          entries = [...entries.filter((entry) => entry.id !== change.entityId), change.payload];
        }
      } else {
        if (change.operation === 'delete') {
          recipes = recipes.filter((recipe) => recipe.id !== change.entityId);
        } else if (isSavedRecipe(change.payload) && change.payload.id === change.entityId) {
          recipes = [...recipes.filter((recipe) => recipe.id !== change.entityId), change.payload];
        }
      }
    }
    await current(() => writeDinnerEntries(entries, targetScope));
    await current(() => writeSavedRecipes(recipes, targetScope));
    const snapshot = { scope: targetScope, entries, recipes };
    for (const listener of dinnerDiarySnapshotListeners) {
      assertCurrentContext();
      listener(snapshot);
    }
  }

  const dietProfileChanges = changes.filter((change) => change.entityType === 'diet_profile');
  const dietChangesByScope = new Map<SyncScope, SyncChange[]>();
  for (const change of dietProfileChanges) {
    const targetScope = change.syncScope?.startsWith('account:') ? personalScope : activeScope;
    const scopedChanges = dietChangesByScope.get(targetScope) ?? [];
    scopedChanges.push(change);
    dietChangesByScope.set(targetScope, scopedChanges);
  }
  for (const [targetScope, scopedChanges] of dietChangesByScope) {
    let profile = await current(() => readDietProfile(targetScope));
    let hasProfileChange = false;
    for (const change of scopedChanges) {
      if (change.entityId !== 'profile') continue;
      hasProfileChange = true;
      if (change.operation === 'upsert' && isDietProfile(change.payload)) {
        profile = change.payload;
      } else if (change.operation === 'delete') {
        profile = normalizeDietProfile({ ...DEFAULT_DIET_PROFILE, updatedAt: new Date().toISOString() });
      }
    }
    if (hasProfileChange) {
      await current(() => writeDietProfile(profile, targetScope));
      if (targetScope === activeScope) for (const listener of dietProfileSnapshotListeners) {
        assertCurrentContext();
        listener(profile);
      }
    }
  }
};

export function registerPantrySnapshotListener(listener: (snapshot: PantrySnapshot) => void): () => void {
  pantrySnapshotListeners.add(listener);
  return () => pantrySnapshotListeners.delete(listener);
}

export function registerShoppingListSnapshotListener(listener: (items: ShoppingListItem[]) => void): () => void {
  shoppingListListeners.add(listener);
  return () => shoppingListListeners.delete(listener);
}

export function registerActivitySnapshotListener(listener: (snapshot: {
  events: CookEvent[];
  preferences: RecipePreference[];
}) => void): () => void {
  activitySnapshotListeners.add(listener);
  return () => activitySnapshotListeners.delete(listener);
}

export function registerDietProfileSnapshotListener(listener: (profile: DietProfile) => void): () => void {
  dietProfileSnapshotListeners.add(listener);
  return () => dietProfileSnapshotListeners.delete(listener);
}

export function registerDinnerDiarySnapshotListener(listener: (snapshot: DinnerDiarySnapshot) => void): () => void {
  dinnerDiarySnapshotListeners.add(listener);
  return () => dinnerDiarySnapshotListeners.delete(listener);
}

export async function syncNow({ fetch, request = apiRequest, session, isSessionCurrent }: SyncRequestOptions): Promise<SyncResult> {
  ensureVerifiedSession(session);
  const accountScope = getAccountSyncScope(session.userId);
  const activeScope = getActiveDataScope();
  const personalScope = getPersonalDataScope();
  const cursorScope = activeScope.startsWith('house:') ? activeScope : accountScope;
  const syncKey = `${accountScope}|${activeScope}|${session.csrfToken}`;
  const inFlight = syncPromises.get(syncKey);
  if (inFlight !== undefined) return inFlight;

  const contextError = (): Error | null => {
    if (isSessionCurrent !== undefined && !isSessionCurrent()) return new SyncSessionChangedError();
    if (getActiveDataScope() !== activeScope || getPersonalDataScope() !== personalScope) return new SyncScopeChangedError();
    return null;
  };

  const assertCurrentContext = (): void => {
    const error = contextError();
    if (error !== null) throw error;
  };
  const current = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrentContext();
    const result = await operation();
    assertCurrentContext();
    return result;
  };

  const operation = (async () => {
    await waitForPendingQueueWrites();
    assertCurrentContext();
    if (activeScope.startsWith('house:')) {
      await importPendingAccountQueue(session, request, accountScope, assertCurrentContext, fetch);
      assertCurrentContext();
    }
    const deviceId = await current(getDeviceId);
    let cursor = await current(() => readSyncCursor(cursorScope));
    let uploaded = 0;
    let downloaded = 0;

    for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
      const queued = await current(() => readPendingSyncMutations(accountScope, activeScope));
      const batch = queued.slice(0, MAX_MUTATIONS_PER_REQUEST);
      const result = await current(() => request<SyncPage>('/v1/sync', {
        method: 'POST',
        csrfToken: session.csrfToken,
        fetch,
        body: { syncScope: cursorScope === GUEST_SYNC_SCOPE ? undefined : cursorScope, deviceId, cursor, mutations: batch.map(toMutation) },
      }));

      const serverHasMore = result.hasMore ?? result.changes.length >= SERVER_CHANGE_PAGE_SIZE;
      if (result.nextCursor < cursor || (result.changes.length > 0 && result.nextCursor <= cursor)
        || (serverHasMore && result.nextCursor <= cursor)) {
        throw new SyncCursorStalledError();
      }

      if (result.changes.some((change) => (
        change.syncScope !== undefined && change.syncScope !== accountScope && change.syncScope !== activeScope
      ) || (change.syncScope?.startsWith('house:') === true && !SHARED_ENTITY_TYPES.has(change.entityType)))) {
        throw new SyncResponseScopeError();
      }
      const applying = applyServerChanges(result.changes, activeScope, personalScope, assertCurrentContext);
      const applicationScopes = new Set([activeScope, personalScope]);
      for (const scope of applicationScopes) {
        const pending = pendingScopeApplications.get(scope) ?? new Set<Promise<void>>();
        pending.add(applying);
        pendingScopeApplications.set(scope, pending);
      }
      try {
        await applying;
      } finally {
        for (const scope of applicationScopes) {
          const pending = pendingScopeApplications.get(scope);
          pending?.delete(applying);
          if (pending?.size === 0) pendingScopeApplications.delete(scope);
        }
      }
      const nextCursor = Math.max(cursor, result.nextCursor);
      await current(() => trackScopedWrite(cursorScope, () => writeMeta(cursorMetaKey(cursorScope), nextCursor)));
      for (const mutation of batch) await current(() => deleteQueueValue(mutation.mutationId, mutation.scope));

      uploaded += batch.length;
      downloaded += result.changes.length;
      cursor = nextCursor;
      const pending = (await current(() => readPendingSyncMutations(accountScope, activeScope))).length;
      if (pending === 0 && !serverHasMore) {
        return { uploaded, downloaded, pending, complete: true };
      }
    }

    const pending = (await current(() => readPendingSyncMutations(accountScope, activeScope))).length;
    return { uploaded, downloaded, pending, complete: false };
  })().finally(() => {
    if (syncPromises.get(syncKey) === operation) {
      syncPromises.delete(syncKey);
    }
  });

  syncPromises.set(syncKey, operation);
  return operation;
}

export async function syncVerifiedSession(
  session: SyncSession,
  options: Omit<SyncRequestOptions, 'session'> = {},
): Promise<SyncResult | null> {
  const scope = getAccountSyncScope(session.userId);
  const activeScope = getActiveDataScope();
  const personalScope = getPersonalDataScope();
  const isCurrentContext = (): boolean => (options.isSessionCurrent?.() !== false
    && getActiveDataScope() === activeScope
    && getPersonalDataScope() === personalScope);
  setSyncStatus(scope, { state: 'syncing', error: null });
  try {
    const result = await syncNow({ ...options, session });
    if (!isCurrentContext()) return null;
    setSyncStatus(scope, { state: 'success', error: null });
    return result;
  } catch (error) {
    if (!isCurrentContext()) return null;
    if (error instanceof ApiClientError
      && (error.code === 'house_membership_required' || error.code === 'sync_scope_required')
      && activeScope.startsWith('house:')) {
      try {
        await clearDataScope(activeScope);
      } catch (purgeError) {
        if (isCurrentContext()) setSyncStatus(scope, { state: 'error', error: purgeError });
        return null;
      }
      if (!isCurrentContext()) return null;
      setActiveDataScope(scope);
      setPersonalDataScope(scope);
      options.onMembershipLost?.();
    }
    setSyncStatus(scope, { state: 'error', error });
    return null;
  }
}

export function listenForReconnect(
  getSession: () => SyncSession | null,
  onMembershipLost?: () => void,
): () => void {
  const onOnline = () => {
    const session = getSession();
    if (session === null) return;
    void syncVerifiedSession(session, {
      onMembershipLost,
      isSessionCurrent: () => {
        const current = getSession();
        return current?.userId === session.userId && current.csrfToken === session.csrfToken;
      },
    });
  };

  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}
