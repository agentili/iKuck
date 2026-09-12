import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const LOCAL_DATABASE_NAME = 'ikuck-local-v2';
export const LOCAL_DATABASE_VERSION = 1;
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
      upgrade(database) {
        if (!database.objectStoreNames.contains(KEY_VALUE_STORE)) {
          database.createObjectStore(KEY_VALUE_STORE);
        }

        if (!database.objectStoreNames.contains(SYNC_QUEUE_STORE)) {
          const queue = database.createObjectStore(SYNC_QUEUE_STORE, { keyPath: 'mutationId' });
          queue.createIndex('byCreatedAt', 'createdAt');
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

export async function readQueueValues<T>(): Promise<T[]> {
  const database = await openLocalDatabase();
  const values = await database.getAll(SYNC_QUEUE_STORE);
  return values as T[];
}

export async function writeQueueValue<T extends { mutationId: string }>(value: T): Promise<void> {
  const database = await openLocalDatabase();
  await database.put(SYNC_QUEUE_STORE, value);
}

export async function deleteQueueValue(mutationId: string): Promise<void> {
  const database = await openLocalDatabase();
  await database.delete(SYNC_QUEUE_STORE, mutationId);
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
