import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { scopeStorageKey, type SyncScope } from '../sync/scopeContext';

export type { SyncScope } from '../sync/scopeContext';

export const LOCAL_DATABASE_NAME = 'ikuck-local-v2';
export const LOCAL_DATABASE_VERSION = 4;
export const KEY_VALUE_STORE = 'keyValue';
export const SYNC_QUEUE_STORE = 'syncQueue';
export const SYNC_META_STORE = 'syncMeta';
export const DINNER_CONSUMPTION_STORE = 'dinnerConsumption';
export const DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX = 'dinner-consumption-record:';
export const LOCAL_STORAGE_JOURNAL_KEY = 'ikuck:local-storage-journal-v1';

interface LocalStorageJournal {
  version: 1;
  state: 'prepared' | 'committed';
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

const applyLocalStorageValues = (storage: Storage, values: Record<string, string | null>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  }
};

// The localStorage getter itself can be denied (privacy mode, enterprise policy).
// Callers that only maintain a mirror must treat a denied getter as "nothing to do";
// callers that rely on localStorage as the durable store must use requireLocalStorage.
function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function requireLocalStorage(): Storage {
  const storage = getLocalStorage();
  if (storage === null) {
    throw new Error('localStorage is unavailable for the durable local fallback');
  }
  return storage;
}

type LocalDatabaseResetListener = () => void;
const localDatabaseResetListeners = new Set<LocalDatabaseResetListener>();

// In-memory observations of the durable stores become stale as soon as the local
// database is deleted; subscribers drop them instead of comparing against ghosts.
export function onLocalDatabaseReset(listener: LocalDatabaseResetListener): () => void {
  localDatabaseResetListeners.add(listener);
  return () => localDatabaseResetListeners.delete(listener);
}

export function recoverLocalStorageJournal(): void {
  const storage = getLocalStorage();
  if (storage === null) return;
  let raw: string | null;
  try {
    raw = storage.getItem(LOCAL_STORAGE_JOURNAL_KEY);
  } catch {
    // Best-effort mirror maintenance: a denied read cannot be recovered here,
    // and recovery must never break the IndexedDB-backed caller.
    return;
  }
  if (raw === null) return;

  let journal: LocalStorageJournal;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
      || !('state' in parsed) || (parsed.state !== 'prepared' && parsed.state !== 'committed')
      || !('before' in parsed) || typeof parsed.before !== 'object' || parsed.before === null
      || !('after' in parsed) || typeof parsed.after !== 'object' || parsed.after === null) {
      throw new Error('Malformed local storage journal');
    }
    journal = parsed as LocalStorageJournal;
  } catch {
    try {
      storage.removeItem(LOCAL_STORAGE_JOURNAL_KEY);
    } catch {
      // A denied cleanup leaves the journal for the next successful recovery attempt.
    }
    return;
  }

  try {
    // Applying either image is idempotent, so a partially applied recovery can be retried.
    applyLocalStorageValues(storage, journal.state === 'committed' ? journal.after : journal.before);
    storage.removeItem(LOCAL_STORAGE_JOURNAL_KEY);
  } catch {
    // Keep the journal: the next read retries the recovery instead of trusting a half-applied image.
  }
}

export function commitLocalStorageJournal(after: Record<string, string | null>): void {
  recoverLocalStorageJournal();
  // This is the durable path used only when IndexedDB is unavailable: a denied
  // localStorage access must fail the operation instead of fabricating success.
  const storage = requireLocalStorage();
  const before = Object.fromEntries(Object.keys(after).map((key) => [key, storage.getItem(key)]));
  const journal: LocalStorageJournal = { version: 1, state: 'prepared', before, after };
  storage.setItem(LOCAL_STORAGE_JOURNAL_KEY, JSON.stringify(journal));

  try {
    applyLocalStorageValues(storage, after);
    storage.setItem(LOCAL_STORAGE_JOURNAL_KEY, JSON.stringify({ ...journal, state: 'committed' }));
  } catch (error) {
    try {
      applyLocalStorageValues(storage, before);
      storage.removeItem(LOCAL_STORAGE_JOURNAL_KEY);
    } catch {
      // Keep the prepared journal so the next read can restore the before-image.
    }
    throw error;
  }

  try {
    storage.removeItem(LOCAL_STORAGE_JOURNAL_KEY);
  } catch {
    // The committed journal is recoverable and is authoritative on the next read.
  }
}

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
      byScopeOrder: [SyncScope, number];
    };
  };
  syncMeta: {
    key: string;
    value: unknown;
  };
  dinnerConsumption: {
    key: string;
    value: unknown;
    indexes: {
      byScope: SyncScope;
      byScopeEntryId: string;
    };
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
          queue.createIndex('byScopeOrder', ['scope', 'localOrder']);
        } else if (oldVersion < 2) {
          const queue = transaction.objectStore(SYNC_QUEUE_STORE);
          if (!queue.indexNames.contains('byScope')) {
            queue.createIndex('byScope', 'scope');
          }
        }

        const queue = transaction.objectStore(SYNC_QUEUE_STORE);
        if (!queue.indexNames.contains('byScopeOrder')) {
          queue.createIndex('byScopeOrder', ['scope', 'localOrder']);
        }
        if (oldVersion < 4) {
          void queue.getAll().then((values) => {
            const compareText = (left: unknown, right: unknown): number => {
              const leftText = typeof left === 'string' ? left : '';
              const rightText = typeof right === 'string' ? right : '';
              return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
            };
            const timestamp = (value: unknown): number => {
              if (typeof value === 'number' && Number.isFinite(value)) return value;
              if (typeof value === 'string') {
                const parsed = Date.parse(value);
                if (Number.isFinite(parsed)) return parsed;
              }
              return Number.MIN_SAFE_INTEGER;
            };
            const planRecords = (values as Array<Record<string, unknown>>)
              .filter((record) => record.entityType === 'meal_plan_entry' && typeof record.mutationId === 'string')
              .map((record): Record<string, unknown> => ({ ...record, scope: typeof record.scope === 'string' ? record.scope : 'guest' }))
              .sort((left, right) => compareText(left.scope, right.scope)
                || timestamp(left.createdAt) - timestamp(right.createdAt)
                || compareText(left.mutationId, right.mutationId));
            const orderByScope = new Map<string, number>();
            for (const record of planRecords) {
              const scope = record.scope as string;
              const localOrder = (orderByScope.get(scope) ?? 0) + 1;
              orderByScope.set(scope, localOrder);
              queue.put({ ...record, localOrder });
            }
          });
        }

        if (!database.objectStoreNames.contains(SYNC_META_STORE)) {
          database.createObjectStore(SYNC_META_STORE);
        }
        if (!database.objectStoreNames.contains(DINNER_CONSUMPTION_STORE)) {
          const consumption = database.createObjectStore(DINNER_CONSUMPTION_STORE, { keyPath: 'operationId' });
          consumption.createIndex('byScope', 'scope');
          consumption.createIndex('byScopeEntryId', 'scopeEntryId', { unique: true });
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

export interface AtomicScopedQueueDelete {
  mutationId: string;
  scope: SyncScope;
}

export interface AtomicKeyValueUpdate {
  key: string;
  queueScope?: SyncScope;
  update: (currentValue: unknown | null, queueValues: readonly unknown[]) => unknown | undefined;
}

export async function atomicUpdateKeyValuesAndQueue(
  updates: readonly AtomicKeyValueUpdate[],
  queueWrites: readonly unknown[] = [],
  queueDeletes: readonly AtomicScopedQueueDelete[] = [],
  assertWritable?: () => void,
): Promise<void> {
  const database = await openLocalDatabase();
  assertWritable?.();
  const transaction = database.transaction([KEY_VALUE_STORE, SYNC_QUEUE_STORE], 'readwrite');
  const values = transaction.objectStore(KEY_VALUE_STORE);
  const queue = transaction.objectStore(SYNC_QUEUE_STORE);
  try {
    for (const item of queueDeletes) {
      const stored = await queue.get(item.mutationId) as { scope?: unknown } | undefined;
      assertWritable?.();
      if (stored?.scope === item.scope) await queue.delete(item.mutationId);
    }
    for (const value of queueWrites) {
      assertWritable?.();
      if (typeof value === 'object' && value !== null && 'entityType' in value
        && value.entityType === 'meal_plan_entry' && 'mutationId' in value && typeof value.mutationId === 'string'
        && 'scope' in value && typeof value.scope === 'string') {
        const candidate = value as Record<string, unknown>;
        const mutationId = candidate.mutationId as string;
        const existing = await queue.get(mutationId) as Record<string, unknown> | undefined;
        assertWritable?.();
        let localOrder: number | undefined;
        if (existing !== undefined) {
          const stableFields = (record: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
            Object.entries(record).filter(([key]) => key !== 'createdAt' && key !== 'localOrder'),
          );
          if (existing.entityType !== 'meal_plan_entry' || existing.scope !== candidate.scope
            || JSON.stringify(stableFields(existing)) !== JSON.stringify(stableFields(candidate))) {
            throw new Error('L’identificativo dell’operazione del piano è già associato a un comando diverso.');
          }
          if (Number.isSafeInteger(existing.localOrder) && (existing.localOrder as number) > 0) {
            localOrder = existing.localOrder as number;
          }
        }
        if (localOrder === undefined) {
          const scope = candidate.scope as SyncScope;
          const queued = await queue.index('byScopeOrder').getAll(
            IDBKeyRange.bound([scope, 0], [scope, Number.MAX_SAFE_INTEGER]),
          ) as Array<{ localOrder?: unknown }>;
          assertWritable?.();
          const maximum = queued.reduce((max, record) => Number.isSafeInteger(record.localOrder)
            ? Math.max(max, record.localOrder as number) : max, 0);
          localOrder = maximum + 1;
        }
        await queue.put({ ...candidate, localOrder });
      } else {
        await queue.put(value);
      }
      assertWritable?.();
    }
    for (const change of updates) {
      const stored = await values.get(change.key);
      assertWritable?.();
      const queueValues = change.queueScope === undefined
        ? []
        : await queue.index('byScope').getAll(change.queueScope);
      assertWritable?.();
      const next = change.update(stored ?? null, queueValues);
      if (next === undefined) await values.delete(change.key);
      else await values.put(next, change.key);
      assertWritable?.();
    }
    assertWritable?.();
    await transaction.done;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    await transaction.done.catch(() => undefined);
    throw error;
  }
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

export async function readQueueValues<T>(scope: SyncScope, assertWritable?: () => void): Promise<T[]> {
  const database = await openLocalDatabase();
  assertWritable?.();
  const migrationTransaction = database.transaction(SYNC_QUEUE_STORE, 'readwrite');
  const queue = migrationTransaction.objectStore(SYNC_QUEUE_STORE);
  try {
    const values = await queue.getAll() as Array<Record<string, unknown>>;
    assertWritable?.();
    for (const value of values) {
      if (typeof value.scope !== 'string') {
        assertWritable?.();
        await queue.put({ ...value, scope: 'guest' satisfies SyncScope });
        assertWritable?.();
      }
    }
    assertWritable?.();
    await migrationTransaction.done;
  } catch (error) {
    try {
      migrationTransaction.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    await migrationTransaction.done.catch(() => undefined);
    throw error;
  }

  assertWritable?.();
  const scopedValues = await database.getAllFromIndex(SYNC_QUEUE_STORE, 'byScope', scope);
  assertWritable?.();
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

const removeLocalDinnerConsumptionRecords = (scope: SyncScope, durable: boolean): void => {
  if (isIndexedDbAvailable()) return;
  recoverLocalStorageJournal();
  const storage = getLocalStorage();
  if (storage === null) {
    if (durable) throw new Error('The dinner outbox could not be purged because localStorage is unavailable');
    return;
  }
  try {
    const localPrefix = scopeStorageKey(scope, DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX);
    const localRecordKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(localPrefix));
    for (const key of localRecordKeys) storage.removeItem(key);
  } catch (error) {
    // Without IndexedDB localStorage is the durable store: a denied purge must fail
    // loudly instead of leaving records behind as if the scope had been cleared.
    if (durable) throw error;
  }
};

export async function deleteQueueScope(scope: SyncScope): Promise<void> {
  if (!isIndexedDbAvailable()) {
    removeLocalDinnerConsumptionRecords(scope, true);
    return;
  }
  const database = await openLocalDatabase();
  const transaction = database.transaction([SYNC_QUEUE_STORE, DINNER_CONSUMPTION_STORE], 'readwrite');
  const queue = transaction.objectStore(SYNC_QUEUE_STORE);
  const consumption = transaction.objectStore(DINNER_CONSUMPTION_STORE);
  const [queuedValues, consumptionValues] = await Promise.all([
    queue.index('byScope').getAll(scope) as Promise<Array<{ mutationId?: unknown }>>,
    consumption.index('byScope').getAll(scope) as Promise<Array<{ operationId?: unknown }>>,
  ]);
  for (const value of queuedValues) {
    if (typeof value.mutationId === 'string') await queue.delete(value.mutationId);
  }
  for (const value of consumptionValues) {
    if (typeof value.operationId === 'string') await consumption.delete(value.operationId);
  }
  await transaction.done;
  removeLocalDinnerConsumptionRecords(scope, false);
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

export async function closeLocalDatabase(): Promise<void> {
  const activeDatabase = databasePromise;
  databasePromise = null;

  if (activeDatabase) {
    try {
      (await activeDatabase).close();
    } catch {
      // The connection may already be closed after a failed open.
    }
  }
}

export async function deleteLocalDatabase(): Promise<void> {
  await closeLocalDatabase();
  if (isIndexedDbAvailable()) {
    await deleteDB(LOCAL_DATABASE_NAME);
  }
  for (const listener of [...localDatabaseResetListeners]) listener();
}
