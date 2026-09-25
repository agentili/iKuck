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
import type { PantryMergeSummary } from '@ikuck/shared/pantryMerge';
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
import { readDietProfile, writeDietProfile } from '../storage/dietProfileStorage';
import { assertSyncMutation, isPantryItemPayload, isStaplePreferencePayload } from './validation';
import { getActiveDataScope, getPersonalDataScope, setActiveDataScope, setPersonalDataScope } from './scopeContext';

const DEVICE_ID_META_KEY = 'deviceId';
const MAX_MUTATIONS_PER_REQUEST = 100;
const SERVER_CHANGE_PAGE_SIZE = 200;
// Bound page draining so a malformed server cursor cannot create an infinite sync loop.
const MAX_SYNC_PAGES = 100;

export type { SyncScope } from '../storage/indexedDb';
export const GUEST_SYNC_SCOPE: SyncScope = 'guest';

export const getAccountSyncScope = (userId: string): SyncScope => `account:${userId}`;

const SHARED_ENTITY_TYPES = new Set<SyncEntityType>([
  'pantry_item',
  'pantry_lot',
  'staple_preference',
]);

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

export async function clearDataScope(scope: SyncScope): Promise<void> {
  await Promise.all([
    clearPantrySnapshot(scope),
    clearShoppingList(scope),
    clearCookEvents(scope),
    clearRecipePreferences(scope),
  ]);
  await deleteQueueScope(scope);
  await deleteMeta(cursorMetaKey(scope));
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
const pantrySnapshotListeners = new Set<(snapshot: PantrySnapshot) => void>();
const shoppingListListeners = new Set<(items: ShoppingListItem[]) => void>();
const activitySnapshotListeners = new Set<(snapshot: {
  events: CookEvent[];
  preferences: RecipePreference[];
}) => void>();
const dietProfileSnapshotListeners = new Set<(profile: DietProfile) => void>();

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
): Promise<SyncMutation> => ({
  ...(await createPantryMutation(entityType, entityId, operation, payload)),
  mutationId: `import:${scope}:${entityType}:${entityId}`,
});

const queueMutationWrite = (scope: SyncScope, mutation: SyncMutation): Promise<void> => {
  const operation = pendingQueueWrites.then(() => writeQueueValue<QueuedMutation>({
    ...mutation,
    scope,
    createdAt: new Date().toISOString(),
  }));
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
  const operationPromise = pendingQueueWrites
    .then(() => createPantryMutation(entityType, entityId, operation, payload))
    .then((mutation) => writeQueueValue<QueuedMutation>({
      ...mutation,
      scope,
      createdAt: new Date().toISOString(),
    }));
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

export async function importLocalData(session: SyncSession): Promise<SyncResult> {
  ensureVerifiedSession(session);
  const scope = getAccountSyncScope(session.userId);
  const snapshot = normalizePantrySnapshot(await readPantrySnapshot() ?? { pantryItems: [], stapleIds: [] });

  for (const lot of snapshot.pantryLots ?? []) {
    await enqueueMutation(scope, await createImportMutation(scope, 'pantry_lot', lot.id, 'upsert', lot));
  }
  for (const stapleId of snapshot.stapleIds) {
    await enqueueMutation(scope, await createImportMutation(
      scope,
      'staple_preference',
      stapleId,
      'upsert',
      { enabled: true },
    ));
  }
  for (const item of await readShoppingList()) {
    await enqueueMutation(scope, await createImportMutation(scope, 'shopping_list_item', item.id, 'upsert', item));
  }
  for (const event of await readCookEvents()) {
    await enqueueMutation(scope, await createImportMutation(scope, 'cook_event', event.id, 'upsert', event));
  }
  for (const preference of await readRecipePreferences()) {
    await enqueueMutation(scope, await createImportMutation(
      scope,
      'recipe_preference',
      preference.recipeId,
      'upsert',
      preference,
    ));
  }
  await enqueueMutation(scope, await createImportMutation(
    scope,
    'diet_profile',
    'profile',
    'upsert',
    await readDietProfile(),
  ));

  return syncNow({ session });
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
  try {
    const state = await request<HouseState | null>('/v1/house');
    ensureCurrent();
    const nextActiveScope: SyncScope = state?.house?.id === undefined ? accountScope : `house:${state.house.id}`;
    if (previousActiveScope.startsWith('house:')
      && previousActiveScope !== nextActiveScope
      && getActiveDataScope() === previousActiveScope) {
      await clearDataScope(previousActiveScope);
      ensureCurrent();
    }
    ensureCurrent();
    setActiveDataScope(GUEST_SYNC_SCOPE);
    setPersonalDataScope(accountScope);
    let mergeSummary: PantryMergeSummary | null = null;
    if (state?.house !== null && state?.house !== undefined) {
      mergeSummary = await mergeGuestPantryIntoHouse(session, state.house.id, request, isCurrent);
      ensureCurrent();
      setActiveDataScope(`house:${state.house.id}`);
    } else {
      ensureCurrent();
      setActiveDataScope(accountScope);
      setPersonalDataScope(accountScope);
    }
    return { state, mergeSummary };
  } catch (error) {
    if (!isCurrent()) throw error;
    if (previousActiveScope.startsWith('house:')
      && getActiveDataScope() === previousActiveScope) {
      await clearDataScope(previousActiveScope).catch(() => undefined);
      ensureCurrent();
    }
    ensureCurrent();
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
): Promise<void> => {
  if (changes.length === 0) return;

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
    let snapshot = await readPantrySnapshot(targetScope) ?? { pantryItems: [], stapleIds: [] };
    for (const change of scopedChanges) {
      snapshot = applyChangeToSnapshot(snapshot, change);
    }
    await writePantrySnapshot(snapshot, targetScope);
    if (targetScope === activeScope) {
      for (const listener of pantrySnapshotListeners) listener(snapshot);
    }
  }

  const shoppingChanges = changes.filter((change) => change.entityType === 'shopping_list_item');
  if (shoppingChanges.length > 0) {
    let items = await readShoppingList(personalScope);
    for (const change of shoppingChanges) {
      items = items.filter((item) => item.id !== change.entityId);
      if (change.operation === 'upsert' && isShoppingListItem(change.payload)) items.push(change.payload);
    }
    await writeShoppingList(items, personalScope);
    for (const listener of shoppingListListeners) listener(items);
  }

  const activityChanges = changes.filter((change) => change.entityType === 'cook_event'
    || change.entityType === 'recipe_preference');
  if (activityChanges.length > 0) {
    let events = await readCookEvents(personalScope);
    let preferences = await readRecipePreferences(personalScope);
    let hasEventChanges = false;
    let hasPreferenceChanges = false;
    for (const change of activityChanges) {
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
    if (hasEventChanges) await writeCookEvents(events, personalScope);
    if (hasPreferenceChanges) await writeRecipePreferences(preferences, personalScope);
    const snapshot = { events, preferences };
    for (const listener of activitySnapshotListeners) listener(snapshot);
  }

  const dietProfileChanges = changes.filter((change) => change.entityType === 'diet_profile');
  if (dietProfileChanges.length > 0) {
    let profile = await readDietProfile(personalScope);
    let hasProfileChange = false;
    for (const change of dietProfileChanges) {
      if (change.entityId !== 'profile') continue;
      hasProfileChange = true;
      if (change.operation === 'upsert' && isDietProfile(change.payload)) {
        profile = change.payload;
      } else if (change.operation === 'delete') {
        profile = normalizeDietProfile({ ...DEFAULT_DIET_PROFILE, updatedAt: new Date().toISOString() });
      }
    }
    if (hasProfileChange) {
      await writeDietProfile(profile, personalScope);
      for (const listener of dietProfileSnapshotListeners) listener(profile);
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

export async function syncNow({ fetch, request = apiRequest, session, isSessionCurrent }: SyncRequestOptions): Promise<SyncResult> {
  ensureVerifiedSession(session);
  const accountScope = getAccountSyncScope(session.userId);
  const activeScope = getActiveDataScope();
  const personalScope = getPersonalDataScope();
  const cursorScope = activeScope.startsWith('house:') ? activeScope : accountScope;
  const syncKey = `${accountScope}|${activeScope}`;
  const inFlight = syncPromises.get(syncKey);
  if (inFlight !== undefined) return inFlight;

  const contextError = (): Error | null => {
    if (isSessionCurrent !== undefined && !isSessionCurrent()) return new SyncSessionChangedError();
    if (getActiveDataScope() !== activeScope || getPersonalDataScope() !== personalScope) return new SyncScopeChangedError();
    return null;
  };

  const operation = (async () => {
    await waitForPendingQueueWrites();
    const initialContextError = contextError();
    if (initialContextError !== null) throw initialContextError;
    const deviceId = await getDeviceId();
    let cursor = await readSyncCursor(cursorScope);
    let uploaded = 0;
    let downloaded = 0;

    for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
      const queued = await readPendingSyncMutations(accountScope, activeScope);
      const batch = queued.slice(0, MAX_MUTATIONS_PER_REQUEST);
      const result = await request<SyncPage>('/v1/sync', {
        method: 'POST',
        csrfToken: session.csrfToken,
        fetch,
        body: { syncScope: cursorScope === GUEST_SYNC_SCOPE ? undefined : cursorScope, deviceId, cursor, mutations: batch.map(toMutation) },
      });

      const responseContextError = contextError();
      if (responseContextError !== null) throw responseContextError;

      const serverHasMore = result.hasMore ?? result.changes.length >= SERVER_CHANGE_PAGE_SIZE;
      if (result.nextCursor < cursor || (result.changes.length > 0 && result.nextCursor <= cursor)
        || (serverHasMore && result.nextCursor <= cursor)) {
        throw new SyncCursorStalledError();
      }

      await applyServerChanges(result.changes, activeScope, personalScope);
      const appliedContextError = contextError();
      if (appliedContextError !== null) throw appliedContextError;
      const nextCursor = Math.max(cursor, result.nextCursor);
      await writeMeta(cursorMetaKey(cursorScope), nextCursor);
      if (cursorScope !== accountScope) await writeMeta(cursorMetaKey(accountScope), nextCursor);
      for (const mutation of batch) await deleteQueueValue(mutation.mutationId, mutation.scope);

      uploaded += batch.length;
      downloaded += result.changes.length;
      cursor = Math.max(cursor, result.nextCursor);
      const pending = (await readPendingSyncMutations(accountScope, activeScope)).length;
      if (pending === 0 && !serverHasMore) {
        return { uploaded, downloaded, pending, complete: true };
      }
    }

    const pending = (await readPendingSyncMutations(accountScope, activeScope)).length;
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
  setSyncStatus(scope, { state: 'syncing', error: null });
  try {
    const result = await syncNow({ ...options, session });
    setSyncStatus(scope, { state: 'success', error: null });
    return result;
  } catch (error) {
    if (error instanceof ApiClientError
      && (error.code === 'house_membership_required' || error.code === 'sync_scope_required')
      && activeScope.startsWith('house:')) {
      await clearDataScope(activeScope).catch(() => undefined);
      setActiveDataScope(scope);
      setPersonalDataScope(scope);
      options.onMembershipLost?.();
    }
    setSyncStatus(scope, { state: 'error', error });
    return null;
  }
}

export function listenForReconnect(getSession: () => SyncSession | null): () => void {
  const onOnline = () => {
    const session = getSession();
    if (session === null) return;
    void syncVerifiedSession(session);
  };

  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}
