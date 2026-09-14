import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const LOCAL_DATABASE_NAME = 'ikuck-local-v2';
export const LOCAL_DATABASE_VERSION = 2;
export const KEY_VALUE_STORE = 'keyValue';
export const SYNC_QUEUE_STORE = 'syncQueue';
export const SYNC_META_STORE = 'syncMeta';

export type SyncScope = 'guest' | `account:${string}`;

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

          const cursorRequest = queue.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor === null) return;

            const value = cursor.value as Record<string, unknown>;
            if (typeof value.scope !== 'string') {
              const updateRequest = cursor.update({ ...value, scope: 'guest' satisfies SyncScope });
              updateRequest.onsuccess = () => cursor.continue();
              return;
            }
            cursor.continue();
          };
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

export async function writeKeyValue<T>(key: string, value: T): Promise<void> {
  const database = await openLocalDatabase();
  await database.put(KEY_VALUE_STORE, value, key);
}

export async function deleteKeyValue(key: string): Promise<void> {
  const database = await openLocalDatabase();
  await database.delete(KEY_VALUE_STORE, key);
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

export async function writeQueueValue<T extends { mutationId: string; scope: SyncScope }>(value: T): Promise<void> {
  const database = await openLocalDatabase();
  await database.put(SYNC_QUEUE_STORE, value);
}

export async function deleteQueueValue(mutationId: string, scope: SyncScope): Promise<void> {
  const database = await openLocalDatabase();
  const transaction = database.transaction(SYNC_QUEUE_STORE, 'readwrite');
  const queue = transaction.objectStore(SYNC_QUEUE_STORE);
  const value = await queue.get(mutationId) as { scope?: unknown } | undefined;
  if (value?.scope === scope) {
    await queue.delete(mutationId);
  }
  await transaction.done;
}

export async function readMeta<T>(key: string): Promise<T | null> {
  const database = await openLocalDatabase();
  const value = await database.get(SYNC_META_STORE, key);
  return (value as T | undefined) ?? null;
}

export async function writeMeta<T>(key: string, value: T): Promise<void> {
  const database = await openLocalDatabase();
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
