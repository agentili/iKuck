import type {
  CookEvent,
  DietProfile,
  RecipePreference,
  ShoppingListItem,
  SyncChange,
  SyncChangeSet,
  SyncEntityType,
  SyncMutation,
  SyncOperation,
} from '@ikuck/shared/contracts';
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';
import {
  deleteQueueValue,
  readMeta,
  readQueueValues,
  type SyncScope,
  writeMeta,
  writeQueueValue,
} from '../storage/indexedDb';
import {
  createPresencePantryLot,
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
  readCookEvents,
  readRecipePreferences,
  writeCookEvents,
  writeRecipePreferences,
} from '../storage/activityStorage';
import { readShoppingList, writeShoppingList } from '../storage/shoppingListStorage';
import { readDietProfile, writeDietProfile } from '../storage/dietProfileStorage';

const DEVICE_ID_META_KEY = 'deviceId';
const MAX_MUTATIONS_PER_REQUEST = 100;

export type { SyncScope } from '../storage/indexedDb';
export const GUEST_SYNC_SCOPE: SyncScope = 'guest';

export const getAccountSyncScope = (userId: string): SyncScope => `account:${userId}`;

const cursorMetaKey = (scope: SyncScope): string => `syncCursor:${scope}`;

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

const syncPromises = new Map<string, Promise<SyncChangeSet>>();
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
  return {
    mutationId: createRandomId(),
    deviceId: await getDeviceId(),
    entityType,
    entityId,
    operation,
    payload,
    clientUpdatedAt: new Date().toISOString(),
  };
}

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
  await queueMutationWrite(scope, mutation);
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

export async function importLocalData(session: SyncSession): Promise<SyncChangeSet> {
  ensureVerifiedSession(session);
  const scope = getAccountSyncScope(session.userId);
  const snapshot = normalizePantrySnapshot(await readPantrySnapshot() ?? { pantryItems: [], stapleIds: [] });

  for (const lot of snapshot.pantryLots ?? []) {
    await enqueueMutation(scope, await createPantryMutation('pantry_lot', lot.id, 'upsert', lot));
  }
  for (const stapleId of snapshot.stapleIds) {
    await enqueueMutation(scope, await createPantryMutation(
      'staple_preference',
      stapleId,
      'upsert',
      { enabled: true },
    ));
  }
  for (const item of await readShoppingList()) {
    await enqueueMutation(scope, await createPantryMutation('shopping_list_item', item.id, 'upsert', item));
  }
  for (const event of await readCookEvents()) {
    await enqueueMutation(scope, await createPantryMutation('cook_event', event.id, 'upsert', event));
  }
  for (const preference of await readRecipePreferences()) {
    await enqueueMutation(scope, await createPantryMutation('recipe_preference', preference.recipeId, 'upsert', preference));
  }
  await enqueueMutation(scope, await createPantryMutation('diet_profile', 'profile', 'upsert', await readDietProfile()));

  return syncNow({ session });
}

const toMutation = ({ createdAt, ...mutation }: QueuedMutation): SyncMutation => {
  void createdAt;
  return mutation;
};

export async function readQueuedMutations(scope: SyncScope): Promise<SyncMutation[]> {
  const values = await readQueueValues<QueuedMutation>(scope);
  return values.sort(compareMutations).map(toMutation);
}

export async function readSyncCursor(scope: SyncScope): Promise<number> {
  const cursor = await readMeta<number>(cursorMetaKey(scope));
  return cursor ?? 0;
}

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
    const pantryItems = normalizedSnapshot.pantryItems.filter((item) => item.id !== change.entityId);
    const pantryLots = (normalizedSnapshot.pantryLots ?? []).filter((lot) => lot.ingredientId !== change.entityId);
    if (change.operation === 'upsert' && typeof change.payload === 'object' && change.payload !== null) {
      const item = change.payload as PantrySnapshot['pantryItems'][number];
      pantryItems.push(item);
      pantryLots.push(createPresencePantryLot(item));
    }
    return { ...normalizedSnapshot, pantryItems: derivePantryItems(pantryLots), pantryLots };
  }

  const enabled = typeof change.payload === 'object'
    && change.payload !== null
    && 'enabled' in change.payload
    && (change.payload as { enabled?: unknown }).enabled === true;
  const stapleIds = normalizedSnapshot.stapleIds.filter((id) => id !== change.entityId);
  return enabled ? { ...normalizedSnapshot, stapleIds: [...stapleIds, change.entityId] } : { ...normalizedSnapshot, stapleIds };
};

const applyServerChanges = async (changes: SyncChange[]): Promise<void> => {
  if (changes.length === 0) return;

  const pantryChanges = changes.filter((change) => change.entityType === 'pantry_item'
    || change.entityType === 'pantry_lot'
    || change.entityType === 'staple_preference');
  if (pantryChanges.length > 0) {
    let snapshot = await readPantrySnapshot() ?? { pantryItems: [], stapleIds: [] };
    for (const change of pantryChanges) {
      snapshot = applyChangeToSnapshot(snapshot, change);
    }
    await writePantrySnapshot(snapshot);
    for (const listener of pantrySnapshotListeners) listener(snapshot);
  }

  const shoppingChanges = changes.filter((change) => change.entityType === 'shopping_list_item');
  if (shoppingChanges.length > 0) {
    let items = await readShoppingList();
    for (const change of shoppingChanges) {
      items = items.filter((item) => item.id !== change.entityId);
      if (change.operation === 'upsert' && isShoppingListItem(change.payload)) items.push(change.payload);
    }
    await writeShoppingList(items);
    for (const listener of shoppingListListeners) listener(items);
  }

  const activityChanges = changes.filter((change) => change.entityType === 'cook_event'
    || change.entityType === 'recipe_preference');
  if (activityChanges.length > 0) {
    let events = await readCookEvents();
    let preferences = await readRecipePreferences();
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
    if (hasEventChanges) await writeCookEvents(events);
    if (hasPreferenceChanges) await writeRecipePreferences(preferences);
    const snapshot = { events, preferences };
    for (const listener of activitySnapshotListeners) listener(snapshot);
  }

  const dietProfileChanges = changes.filter((change) => change.entityType === 'diet_profile');
  if (dietProfileChanges.length > 0) {
    let profile = await readDietProfile();
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
      await writeDietProfile(profile);
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

export async function syncNow({ fetch, request = apiRequest, session, isSessionCurrent }: SyncRequestOptions): Promise<SyncChangeSet> {
  ensureVerifiedSession(session);
  const scope = getAccountSyncScope(session.userId);
  const inFlight = syncPromises.get(scope);
  if (inFlight !== undefined) return inFlight;

  const operation = (async () => {
    await waitForPendingQueueWrites();
    const deviceId = await getDeviceId();
    const cursor = await readSyncCursor(scope);
    const queued = (await readQueueValues<QueuedMutation>(scope)).sort(compareMutations);
    const batch = queued.slice(0, MAX_MUTATIONS_PER_REQUEST);
    const result = await request<SyncChangeSet>('/v1/sync', {
      method: 'POST',
      csrfToken: session.csrfToken,
      fetch,
      body: { deviceId, cursor, mutations: batch.map(toMutation) },
    });

    if (isSessionCurrent !== undefined && !isSessionCurrent()) {
      throw new SyncSessionChangedError();
    }

    await applyServerChanges(result.changes);
    if (isSessionCurrent !== undefined && !isSessionCurrent()) {
      throw new SyncSessionChangedError();
    }
    await writeMeta(cursorMetaKey(scope), Math.max(cursor, result.nextCursor));
    for (const mutation of batch) {
      await deleteQueueValue(mutation.mutationId, scope);
    }
    return result;
  })().finally(() => {
    if (syncPromises.get(scope) === operation) {
      syncPromises.delete(scope);
    }
  });

  syncPromises.set(scope, operation);
  return operation;
}

export async function syncVerifiedSession(
  session: SyncSession,
  options: Omit<SyncRequestOptions, 'session'> = {},
): Promise<SyncChangeSet | null> {
  const scope = getAccountSyncScope(session.userId);
  setSyncStatus(scope, { state: 'syncing', error: null });
  try {
    const result = await syncNow({ ...options, session });
    setSyncStatus(scope, { state: 'success', error: null });
    return result;
  } catch (error) {
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
