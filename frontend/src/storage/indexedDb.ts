import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SyncScope } from '../sync/scopeContext';

export type { SyncScope } from '../sync/scopeContext';

export const LOCAL_DATABASE_NAME = 'ikuck-local-v2';
export const LOCAL_DATABASE_VERSION = 2;
export const KEY_VALUE_STORE = 'keyValue';
export const SYNC_QUEUE_STORE = 'syncQueue';
export const SYNC_META_STORE = 'syncMeta';

interface LocalDatabaseSchema extends DBSchema {
  keyValue: {
    key: string;
    value: unknown;
  };
  syncQueue: {
    key: string;
    value: unknown;
    indexes: {
      byCreatedAt: number;
      byScope: SyncScope;
    };
  };
  syncMeta: {
    key: string;
    value: unknown;
  };
}

let databasePromise: Promise<IDBPDatabase<LocalDatabaseSchema>> | null = null;

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function openLocalDatabase(): Promise<IDBPDatabase<LocalDatabaseSchema>> {
  if (!isIndexedDbAvailable()) {
    throw new Error('IndexedDB is unavailable');
  }

  if (!databasePromise) {
    databasePromise = openDB<LocalDatabaseSchema>(LOCAL_DATABASE_NAME, LOCAL_DATABASE_VERSION, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (!database.objectStoreNames.contains(KEY_VALUE_STORE)) {
          database.createObjectStore(KEY_VALUE_STORE);
        }

        if (!database.objectStoreNames.contains(SYNC_QUEUE_STORE)) {
          const queue = database.createObjectStore(SYNC_QUEUE_STORE, { keyPath: 'mutationId' });
          queue.createIndex('byCreatedAt', 'createdAt');
          queue.createIndex('byScope', 'scope');
        } else if (oldVersion < 2) {
          const queue = transaction.objectStore(SYNC_QUEUE_STORE);
          if (!queue.indexNames.contains('byScope')) {
            queue.createIndex('byScope', 'scope');
          }

        }

        if (!database.objectStoreNames.contains(SYNC_META_STORE)) {
          database.createObjectStore(SYNC_META_STORE);
        }
      },
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }

  return databasePromise;
}

export async function readKeyValue<T>(key: string): Promise<T | null> {
  const database = await openLocalDatabase();
  const value = await database.get(KEY_VALUE_STORE, key);
  return (value as T | undefined) ?? null;
}

export interface KeyValueCompareAndWrite<T> {
  expectedValue: T | null;
  conflictKey: string;
  preserveConflict: (currentValue: T | null, previousConflict: unknown | null) => unknown;
}

export async function writeKeyValue<T>(
  key: string,
  value: T,
  assertWritable?: () => void,
  compareAndWrite?: KeyValueCompareAndWrite<T>,
): Promise<boolean | void> {
  const database = await openLocalDatabase();
  assertWritable?.();
  if (compareAndWrite === undefined) {
    await database.put(KEY_VALUE_STORE, value, key);
    return;
  }

  const transaction = database.transaction(KEY_VALUE_STORE, 'readwrite');
  const store = transaction.objectStore(KEY_VALUE_STORE);
  const stored = await store.get(key) as T | undefined;
  const currentValue = stored ?? null;
  assertWritable?.();
  if (!Object.is(currentValue, compareAndWrite.expectedValue)) {
    const previousConflict = await store.get(compareAndWrite.conflictKey);
    assertWritable?.();
    await store.put(compareAndWrite.preserveConflict(currentValue, previousConflict ?? null), compareAndWrite.conflictKey);
    await transaction.done;
    return false;
  }
  await store.put(value, key);
  await transaction.done;
  return true;
}

export async function updateKeyValue<T>(
  key: string,
  update: (currentValue: T | null) => T,
  assertWritable?: () => void,
): Promise<T> {
  const database = await openLocalDatabase();
  assertWritable?.();
  const transaction = database.transaction(KEY_VALUE_STORE, 'readwrite');
  const store = transaction.objectStore(KEY_VALUE_STORE);
  try {
    const stored = await store.get(key) as T | undefined;
    assertWritable?.();
    const updated = update(stored ?? null);
    await store.put(updated, key);
    await transaction.done;
    return updated;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    throw error;
  }
}

export async function commitPantryRecoverySnapshot(
  pantryKey: string,
  conflictKey: string,
  archiveKey: string,
  backupId: string,
  expectedCopiesSignature: string,
  selectedCopyId: string,
  selectedRaw: string,
  archiveEntry: unknown,
  assertWritable?: () => void,
): Promise<boolean> {
  const database = await openLocalDatabase();
  assertWritable?.();
  const transaction = database.transaction(KEY_VALUE_STORE, 'readwrite');
  const store = transaction.objectStore(KEY_VALUE_STORE);
  const active = await store.get(conflictKey) as Record<string, unknown> | undefined;
  assertWritable?.();
  if (active?.id !== backupId || active.resolvedAt !== undefined
    || JSON.stringify(active.copies) !== expectedCopiesSignature
    || (typeof active.recoveryPendingCopyId === 'string' && active.recoveryPendingCopyId !== selectedCopyId)) {
    await transaction.done;
    return false;
  }

  const previousArchive = await store.get(archiveKey) as { entries?: unknown[] } | unknown[] | undefined;
  assertWritable?.();
  const entries = Array.isArray(previousArchive)
    ? previousArchive
    : Array.isArray(previousArchive?.entries) ? previousArchive.entries : [];
  const matchingIndex = entries.findIndex((entry) => typeof entry === 'object' && entry !== null
    && (entry as Record<string, unknown>).id === backupId
    && (entry as Record<string, unknown>).selectedCopyId === selectedCopyId);
  const updatedEntries = [...entries];
  if (matchingIndex === -1) updatedEntries.push(archiveEntry);
  else updatedEntries[matchingIndex] = archiveEntry;
  await store.put(Array.isArray(previousArchive) ? updatedEntries : { entries: updatedEntries }, archiveKey);
  await store.put({ ...active, recoveryPendingCopyId: selectedCopyId }, conflictKey);
  await store.put(selectedRaw, pantryKey);
  await transaction.done;
  return true;
}

export async function finalizePantryRecoverySnapshot(
  pantryKey: string,
  conflictKey: string,
  archiveKey: string,
  backupId: string,
  selectedCopyId: string,
  expectedCopiesSignature: string,
  expectedRaw: string,
  finalRaw: string,
  resolvedAt: string,
  assertWritable?: () => void,
): Promise<boolean> {
  const database = await openLocalDatabase();
  assertWritable?.();
  const transaction = database.transaction(KEY_VALUE_STORE, 'readwrite');
  const store = transaction.objectStore(KEY_VALUE_STORE);
  const active = await store.get(conflictKey) as Record<string, unknown> | undefined;
  const canonical = await store.get(pantryKey);
  const previousArchive = await store.get(archiveKey);
  assertWritable?.();
  const entries = Array.isArray(previousArchive)
    ? previousArchive
    : typeof previousArchive === 'object' && previousArchive !== null && 'entries' in previousArchive
      && Array.isArray(previousArchive.entries)
      ? previousArchive.entries
      : [];
  const archiveIndex = entries.findIndex((entry) => typeof entry === 'object' && entry !== null
    && (entry as Record<string, unknown>).id === backupId
    && (entry as Record<string, unknown>).selectedCopyId === selectedCopyId
    && (entry as Record<string, unknown>).resolvedAt === undefined
    && JSON.stringify((entry as Record<string, unknown>).copies) === expectedCopiesSignature);
  if (active?.id !== backupId || active.recoveryPendingCopyId !== selectedCopyId
    || JSON.stringify(active.copies) !== expectedCopiesSignature || canonical !== expectedRaw || archiveIndex === -1) {
    await transaction.done;
    return false;
  }
  const updatedEntries = [...entries];
  updatedEntries[archiveIndex] = {
    ...(updatedEntries[archiveIndex] as Record<string, unknown>),
    resolvedAt,
    selectedCopyId,
  };
  await store.put(Array.isArray(previousArchive) ? updatedEntries : { entries: updatedEntries }, archiveKey);
  await store.put(finalRaw, pantryKey);
  await store.put({ ...active, resolvedAt, selectedCopyId }, conflictKey);
  await transaction.done;
  return true;
}

export async function deleteKeyValue(key: string, assertWritable?: () => void): Promise<void> {
  const database = await openLocalDatabase();
  assertWritable?.();
  await database.delete(KEY_VALUE_STORE, key);
}

export async function deleteKeyValueIfValue<T>(
  key: string,
  expectedValue: T,
  assertWritable?: () => void,
): Promise<boolean> {
  const database = await openLocalDatabase();
  assertWritable?.();
  const transaction = database.transaction(KEY_VALUE_STORE, 'readwrite');
  const store = transaction.objectStore(KEY_VALUE_STORE);
  const stored = await store.get(key) as T | undefined;
  assertWritable?.();
  if (!Object.is(stored ?? null, expectedValue)) {
    await transaction.done;
    return false;
  }
  await store.delete(key);
  await transaction.done;
  return true;
}

export async function readQueueValues<T>(scope: SyncScope): Promise<T[]> {
  const database = await openLocalDatabase();
  const migrationTransaction = database.transaction(SYNC_QUEUE_STORE, 'readwrite');
  const queue = migrationTransaction.objectStore(SYNC_QUEUE_STORE);
  const values = await queue.getAll() as Array<Record<string, unknown>>;
  for (const value of values) {
    if (typeof value.scope !== 'string') {
      await queue.put({ ...value, scope: 'guest' satisfies SyncScope });
    }
  }
  await migrationTransaction.done;

  const scopedValues = await database.getAllFromIndex(SYNC_QUEUE_STORE, 'byScope', scope);
  return scopedValues as T[];
}

export async function writeQueueValue<T extends { mutationId: string; scope: SyncScope }>(
  value: T,
  assertWritable?: () => void,
): Promise<void> {
  const database = await openLocalDatabase();
  assertWritable?.();
  await database.put(SYNC_QUEUE_STORE, value);
}

export async function moveQueueValues<T extends { mutationId: string; scope: SyncScope }>(
  fromScope: SyncScope,
  toScope: SyncScope,
  shouldMove: (value: T) => boolean,
): Promise<void> {
  if (fromScope === toScope) return;
  const database = await openLocalDatabase();
  const transaction = database.transaction(SYNC_QUEUE_STORE, 'readwrite');
  const queue = transaction.objectStore(SYNC_QUEUE_STORE);
  const values = await queue.index('byScope').getAll(fromScope) as T[];
  for (const value of values) {
    if (shouldMove(value)) await queue.put({ ...value, scope: toScope });
  }
  await transaction.done;
}

export async function deleteQueueValue(
  mutationId: string,
  scope: SyncScope,
  assertWritable?: () => void,
): Promise<void> {
  const database = await openLocalDatabase();
  assertWritable?.();
  const transaction = database.transaction(SYNC_QUEUE_STORE, 'readwrite');
  const queue = transaction.objectStore(SYNC_QUEUE_STORE);
  const value = await queue.get(mutationId) as { scope?: unknown } | undefined;
  assertWritable?.();
  if (value?.scope === scope) {
    await queue.delete(mutationId);
  }
  await transaction.done;
}

export async function deleteQueueScope(scope: SyncScope): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(SYNC_QUEUE_STORE, 'readwrite');
  const queue = transaction.objectStore(SYNC_QUEUE_STORE);
  const values = await queue.index('byScope').getAll(scope) as Array<{ mutationId?: unknown }>;
  for (const value of values) {
    if (typeof value.mutationId === 'string') await queue.delete(value.mutationId);
  }
  await transaction.done;
}

export async function readMeta<T>(key: string): Promise<T | null> {
  const database = await openLocalDatabase();
  const value = await database.get(SYNC_META_STORE, key);
  return (value as T | undefined) ?? null;
}

export async function deleteMeta(key: string): Promise<void> {
  const database = await openLocalDatabase();
  await database.delete(SYNC_META_STORE, key);
}

export async function writeMeta<T>(key: string, value: T, assertWritable?: () => void): Promise<void> {
  const database = await openLocalDatabase();
  assertWritable?.();
  await database.put(SYNC_META_STORE, value, key);
}

export async function deleteLocalDatabase(): Promise<void> {
  const activeDatabase = databasePromise;
  databasePromise = null;

  if (activeDatabase) {
    try {
      (await activeDatabase).close();
    } catch {
      // The connection may already be closed after a failed open.
    }
  }

  if (isIndexedDbAvailable()) {
    await deleteDB(LOCAL_DATABASE_NAME);
  }
}
