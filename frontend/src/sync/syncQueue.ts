import type { SyncChange, SyncChangeSet, SyncEntityType, SyncMutation, SyncOperation } from '@ikuck/shared/contracts';
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';
import {
  deleteQueueValue,
  readMeta,
  readQueueValues,
  writeMeta,
  writeQueueValue,
} from '../storage/indexedDb';
import { readPantrySnapshot, writePantrySnapshot, type PantrySnapshot } from '../storage/pantryStorage';

const DEVICE_ID_META_KEY = 'deviceId';
const CURSOR_META_KEY = 'cursor';
const MAX_MUTATIONS_PER_REQUEST = 100;

export interface SyncSession {
  userId: string;
  emailVerifiedAt: string;
  csrfToken: string;
}

interface QueuedMutation extends SyncMutation {
  createdAt: string;
}

interface SyncRequestOptions {
  fetch?: typeof globalThis.fetch;
  request?: ApiRequest;
  session: SyncSession;
}

let syncPromise: Promise<SyncChangeSet> | null = null;
let pendingQueueWrites = Promise.resolve();
const pantrySnapshotListeners = new Set<(snapshot: PantrySnapshot) => void>();

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

const queueMutationWrite = (mutation: SyncMutation): Promise<void> => {
  const operation = pendingQueueWrites.then(() => writeQueueValue<QueuedMutation>({
    ...mutation,
    createdAt: new Date().toISOString(),
  }));
  pendingQueueWrites = operation.catch(() => undefined);
  return operation;
};

export async function enqueueMutation(mutation: SyncMutation): Promise<void> {
  await queueMutationWrite(mutation);
}

export function enqueuePantryMutation(
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: unknown | null,
): Promise<void> {
  const operationPromise = pendingQueueWrites
    .then(() => createPantryMutation(entityType, entityId, operation, payload))
    .then((mutation) => writeQueueValue<QueuedMutation>({
      ...mutation,
      createdAt: new Date().toISOString(),
    }));
  pendingQueueWrites = operationPromise.catch(() => undefined);
  return operationPromise;
}

export async function waitForPendingQueueWrites(): Promise<void> {
  await pendingQueueWrites;
}

export async function importLocalData(session: SyncSession): Promise<SyncChangeSet> {
  ensureVerifiedSession(session);
  const snapshot = await readPantrySnapshot() ?? { pantryItems: [], stapleIds: [] };

  for (const item of snapshot.pantryItems) {
    await enqueueMutation(await createPantryMutation('pantry_item', item.id, 'upsert', item));
  }
  for (const stapleId of snapshot.stapleIds) {
    await enqueueMutation(await createPantryMutation(
      'staple_preference',
      stapleId,
      'upsert',
      { enabled: true },
    ));
  }

  return syncNow({ session });
}

const toMutation = ({ createdAt, ...mutation }: QueuedMutation): SyncMutation => {
  void createdAt;
  return mutation;
};

export async function readQueuedMutations(): Promise<SyncMutation[]> {
  const values = await readQueueValues<QueuedMutation>();
  return values.sort(compareMutations).map(toMutation);
}

export async function readSyncCursor(): Promise<number> {
  const cursor = await readMeta<number>(CURSOR_META_KEY);
  return cursor ?? 0;
}

const applyChangeToSnapshot = (snapshot: PantrySnapshot, change: SyncChange): PantrySnapshot => {
  if (change.entityType === 'pantry_item') {
    const pantryItems = snapshot.pantryItems.filter((item) => item.id !== change.entityId);
    if (change.operation === 'upsert' && typeof change.payload === 'object' && change.payload !== null) {
      pantryItems.push(change.payload as PantrySnapshot['pantryItems'][number]);
    }
    return { ...snapshot, pantryItems };
  }

  const enabled = typeof change.payload === 'object'
    && change.payload !== null
    && 'enabled' in change.payload
    && (change.payload as { enabled?: unknown }).enabled === true;
  const stapleIds = snapshot.stapleIds.filter((id) => id !== change.entityId);
  return enabled ? { ...snapshot, stapleIds: [...stapleIds, change.entityId] } : { ...snapshot, stapleIds };
};

const applyServerChanges = async (changes: SyncChange[]): Promise<void> => {
  if (changes.length === 0) return;

  let snapshot = await readPantrySnapshot() ?? { pantryItems: [], stapleIds: [] };
  for (const change of changes) {
    snapshot = applyChangeToSnapshot(snapshot, change);
  }
  await writePantrySnapshot(snapshot);
  for (const listener of pantrySnapshotListeners) listener(snapshot);
};

export function registerPantrySnapshotListener(listener: (snapshot: PantrySnapshot) => void): () => void {
  pantrySnapshotListeners.add(listener);
  return () => pantrySnapshotListeners.delete(listener);
}

export async function syncNow({ fetch, request = apiRequest, session }: SyncRequestOptions): Promise<SyncChangeSet> {
  ensureVerifiedSession(session);
  if (syncPromise !== null) return syncPromise;

  syncPromise = (async () => {
    await waitForPendingQueueWrites();
    const deviceId = await getDeviceId();
    const cursor = await readSyncCursor();
    const queued = (await readQueueValues<QueuedMutation>()).sort(compareMutations);
    const batch = queued.slice(0, MAX_MUTATIONS_PER_REQUEST);
    const result = await request<SyncChangeSet>('/v1/sync', {
      method: 'POST',
      csrfToken: session.csrfToken,
      fetch,
      body: { deviceId, cursor, mutations: batch.map(toMutation) },
    });

    for (const mutation of batch) {
      await deleteQueueValue(mutation.mutationId);
    }
    await applyServerChanges(result.changes);
    await writeMeta(CURSOR_META_KEY, Math.max(cursor, result.nextCursor));
    return result;
  })().finally(() => {
    syncPromise = null;
  });

  return syncPromise;
}

export function syncOnReconnect(getSession: () => SyncSession | null): () => void {
  const onOnline = () => {
    const session = getSession();
    if (session === null) return;
    void syncNow({ session }).catch(() => undefined);
  };

  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}
