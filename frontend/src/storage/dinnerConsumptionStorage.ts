import type { DinnerConsumptionCommand, PantryConsumptionPlan } from '@ikuck/shared/pantryConsumption';
import { planPantryConsumption } from '@ikuck/shared/pantryConsumption';
import type { CookEvent, SyncMutation } from '@ikuck/shared/contracts';
import { isCookEvent } from '../domain/activity';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { isDinnerEntry } from '@ikuck/shared/dinnerDiary';
import {
  commitLocalStorageJournal,
  DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX,
  DINNER_CONSUMPTION_STORE,
  isIndexedDbAvailable,
  KEY_VALUE_STORE,
  SYNC_QUEUE_STORE,
  openLocalDatabase,
  recoverLocalStorageJournal,
} from './indexedDb';
import {
  dinnerEntriesDatabaseKeyForScope,
  dinnerEntriesStorageKeyForScope,
  parseDinnerEntriesSnapshot,
  serializeDinnerEntriesSnapshot,
} from './dinnerDiaryStorage';
import {
  activityEventsDatabaseKeyForScope,
  activityEventsStorageKeyForScope,
  parseCookEventsSnapshot,
  serializeCookEventsSnapshot,
} from './activityStorage';
import {
  derivePantryItems,
  normalizePantrySnapshot,
  observePantryCanonicalSnapshot,
  pantryDatabaseKeyForScope,
  pantryStorageKeyForScope,
  parsePantrySnapshot,
  serializePantrySnapshot,
  type PantrySnapshot,
} from './pantryStorage';
import { getActiveDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { isScopeWritable, ScopeRevokedError, trackScopedWrite, waitForScopedWrites } from '../sync/scopeWriteFence';

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// While IndexedDB is available the localStorage mirror is best-effort: a denied
// getter or method must never break a commit, read, reconciliation or acknowledgement.
function readMirror(key: string): string | null {
  const storage = getLocalStorage();
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function clearMirror(key: string): void {
  const storage = getLocalStorage();
  if (storage === null) return;
  try {
    storage.removeItem(key);
  } catch {
    // IndexedDB remains authoritative when mirror maintenance is denied.
  }
}

function restoreMirror(key: string, value: string | null): void {
  const storage = getLocalStorage();
  if (storage === null) return;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // The IndexedDB transaction remains authoritative if mirror restoration fails.
  }
}

// Without IndexedDB localStorage is the durable store: any denied access must fail
// the operation instead of fabricating a successful local commit.
function requireLocalStorage(): Storage {
  const storage = getLocalStorage();
  if (storage === null) {
    throw new Error('localStorage is unavailable for the durable local fallback');
  }
  return storage;
}

export interface DinnerConsumptionReceipt {
  operationId: string;
  entryId: string;
  scope: SyncScope;
  committedAt: string;
  plan: PantryConsumptionPlan;
}

export interface DinnerConsumptionOutboxRecord {
  operationId: string;
  entryId: string;
  scope: SyncScope;
  scopeEntryId: string;
  command: DinnerConsumptionCommand;
  entry: DinnerEntry;
  cookEvent?: CookEvent;
  receipt: DinnerConsumptionReceipt;
  createdAt: string;
  status: 'pending' | 'acknowledged';
}

export interface CommittedDinnerConsumption {
  duplicate: boolean;
  entry: DinnerEntry;
  pantrySnapshot: PantrySnapshot;
  receipt: DinnerConsumptionReceipt;
  outbox: DinnerConsumptionOutboxRecord;
  plan: PantryConsumptionPlan;
}

export interface DinnerConsumptionServerResult {
  entry: DinnerEntry;
  cookEvent?: CookEvent;
  pantrySnapshot: PantrySnapshot;
  receipt: DinnerConsumptionReceipt;
}

export interface ReconciledDinnerConsumption {
  entry: DinnerEntry;
  cookEvent?: CookEvent;
  pantrySnapshot: PantrySnapshot;
  receipt: DinnerConsumptionReceipt;
  outbox: DinnerConsumptionOutboxRecord;
}

export class DinnerConsumptionScopeChangedError extends Error {
  readonly code = 'scope_changed';

  constructor() {
    super('The active data scope changed before dinner consumption could be committed');
    this.name = 'DinnerConsumptionScopeChangedError';
  }
}

export class DinnerConsumptionConflictError extends Error {
  readonly code = 'dinner_consumption_conflict';

  constructor(message = 'The dinner consumption operation conflicts with an existing record') {
    super(message);
    this.name = 'DinnerConsumptionConflictError';
  }
}

const scopeEntryId = (scope: SyncScope, entryId: string): string => `${scope}\u0000${entryId}`;
const storageRecordKey = (scope: SyncScope, operationId: string): string => scopeStorageKey(
  scope,
  `${DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX}${encodeURIComponent(operationId)}`,
);
const localRecordPrefix = (scope: SyncScope): string => scopeStorageKey(scope, DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX);
const emptyPantry = (): PantrySnapshot => ({ pantryItems: [], stapleIds: [], pantryLots: [] });

const assertCurrentScope = (scope: SyncScope): void => {
  if (!isScopeWritable(scope)) throw new ScopeRevokedError();
  if (getActiveDataScope() !== scope) throw new DinnerConsumptionScopeChangedError();
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const validateInput = (command: DinnerConsumptionCommand, entry: DinnerEntry, cookEvent?: CookEvent): void => {
  if (command.operationId.trim() === '' || command.entryId.trim() === '' || command.entryId !== entry.id
    || command.servings !== entry.servings
    || (cookEvent !== undefined && (cookEvent.id !== command.entryId || !isCookEvent(cookEvent)))
    || command.scope !== getActiveDataScope() || !isDinnerEntry(entry)) {
    if (command.scope !== getActiveDataScope()) throw new DinnerConsumptionScopeChangedError();
    throw new DinnerConsumptionConflictError('Dinner entry and consumption command identifiers must match');
  }
}

const applyPlan = (snapshot: PantrySnapshot, plan: PantryConsumptionPlan): PantrySnapshot => {
  const lots = new Map((snapshot.pantryLots ?? []).map((lot) => [lot.id, lot]));
  for (const id of plan.deleteLotIds) lots.delete(id);
  for (const lot of plan.upsertLots) lots.set(lot.id, lot);
  const pantryLots = [...lots.values()];
  return normalizePantrySnapshot({ ...snapshot, pantryItems: derivePantryItems(pantryLots), pantryLots });
};

const isOutboxRecord = (value: unknown): value is DinnerConsumptionOutboxRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<DinnerConsumptionOutboxRecord>;
  return typeof record.operationId === 'string'
    && typeof record.entryId === 'string'
    && typeof record.scope === 'string'
    && typeof record.scopeEntryId === 'string'
    && record.command !== undefined
    && isDinnerEntry(record.entry)
    && (record.cookEvent === undefined || isCookEvent(record.cookEvent))
    && typeof record.receipt === 'object'
    && record.receipt !== null
    && typeof record.createdAt === 'string'
    && (record.status === 'pending' || record.status === 'acknowledged');
};

const readLocalRecord = (scope: SyncScope, operationId: string): DinnerConsumptionOutboxRecord | null => {
  const storage = requireLocalStorage();
  const raw = storage.getItem(storageRecordKey(scope, operationId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isOutboxRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readLocalRecords = (scope: SyncScope): DinnerConsumptionOutboxRecord[] => {
  recoverLocalStorageJournal();
  const storage = requireLocalStorage();
  const prefix = localRecordPrefix(scope);
  const records: DinnerConsumptionOutboxRecord[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isOutboxRecord(parsed) && parsed.scope === scope) records.push(parsed);
    } catch {
      // Ignore malformed local records; a committed operation is validated before it is returned.
    }
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId));
};

const currentPantryFromLocalStorage = (scope: SyncScope): PantrySnapshot => {
  const storage = requireLocalStorage();
  const raw = storage.getItem(pantryStorageKeyForScope(scope));
  return raw === null ? emptyPantry() : parsePantrySnapshot(raw) ?? emptyPantry();
};

const createReceipt = (command: DinnerConsumptionCommand, committedAt: string, plan: PantryConsumptionPlan): DinnerConsumptionReceipt => ({
  operationId: command.operationId,
  entryId: command.entryId,
  scope: command.scope,
  committedAt,
  plan,
});

const createOutboxRecord = (
  command: DinnerConsumptionCommand,
  entry: DinnerEntry,
  receipt: DinnerConsumptionReceipt,
  createdAt: string,
  cookEvent?: CookEvent,
): DinnerConsumptionOutboxRecord => ({
  operationId: command.operationId,
  entryId: command.entryId,
  scope: command.scope,
  scopeEntryId: scopeEntryId(command.scope, command.entryId),
  command,
  entry,
  ...(cookEvent === undefined ? {} : { cookEvent }),
  receipt,
  createdAt,
  status: 'pending',
});

const resultFor = (
  duplicate: boolean,
  entry: DinnerEntry,
  pantrySnapshot: PantrySnapshot,
  outbox: DinnerConsumptionOutboxRecord,
): CommittedDinnerConsumption => ({
  duplicate,
  entry,
  pantrySnapshot,
  receipt: outbox.receipt,
  outbox,
  plan: outbox.receipt.plan,
});

export async function commitDinnerConsumption({
  command: inputCommand,
  entry: inputEntry,
  cookEvent: inputCookEvent,
  updatedAt = new Date().toISOString(),
}: {
  command: DinnerConsumptionCommand;
  entry: DinnerEntry;
  cookEvent?: CookEvent;
  updatedAt?: string;
}): Promise<CommittedDinnerConsumption> {
  const command = cloneJson(inputCommand);
  const entry = cloneJson(inputEntry);
  const cookEvent = inputCookEvent === undefined ? undefined : cloneJson(inputCookEvent);
  const scope = command.scope;
  validateInput(command, entry, cookEvent);
  const capturedUpdatedAt = updatedAt;

  // Drain in-flight writes for this scope first: a pantry persistence still running
  // would otherwise land after the consumption commit and overwrite it.
  await waitForScopedWrites(scope);

  return trackScopedWrite(scope, async () => {
    assertCurrentScope(scope);
    if (!isIndexedDbAvailable()) {
      recoverLocalStorageJournal();
      return commitLocalConsumption(command, entry, capturedUpdatedAt, cookEvent);
    }

    const pantryMirrorKey = pantryStorageKeyForScope(scope);
    const entriesMirrorKey = dinnerEntriesStorageKeyForScope(scope);
    const activityMirrorKey = cookEvent === undefined ? null : activityEventsStorageKeyForScope(scope);
    const pantryMirror = readMirror(pantryMirrorKey);
    const entriesMirror = readMirror(entriesMirrorKey);
    const activityMirror = activityMirrorKey === null ? null : readMirror(activityMirrorKey);
    const fallbackPantry = pantryMirror === null ? null : parsePantrySnapshot(pantryMirror);
    const database = await openLocalDatabase();
    assertCurrentScope(scope);
    const transaction = database.transaction([KEY_VALUE_STORE, DINNER_CONSUMPTION_STORE], 'readwrite');
    const completion = transaction.done;
    const values = transaction.objectStore(KEY_VALUE_STORE);
    const consumptionStore = transaction.objectStore(DINNER_CONSUMPTION_STORE);
    let mirrorsTouched = false;
    let transactionCommitted = false;

    try {
      mirrorsTouched = true;
      clearMirror(pantryMirrorKey);
      clearMirror(entriesMirrorKey);
      if (activityMirrorKey !== null) clearMirror(activityMirrorKey);
      const [pantryRaw, entriesRaw, activityRaw, storedRecord, storedEntryRecord] = await Promise.all([
        values.get(pantryDatabaseKeyForScope(scope)),
        values.get(dinnerEntriesDatabaseKeyForScope(scope)),
        cookEvent === undefined ? Promise.resolve(undefined) : values.get(activityEventsDatabaseKeyForScope(scope)),
        consumptionStore.get(command.operationId) as Promise<DinnerConsumptionOutboxRecord | undefined>,
        consumptionStore.index('byScopeEntryId').get(scopeEntryId(scope, command.entryId)) as Promise<DinnerConsumptionOutboxRecord | undefined>,
      ]);
      assertCurrentScope(scope);
      const pantrySnapshot = typeof pantryRaw === 'string'
        ? parsePantrySnapshot(pantryRaw) ?? fallbackPantry ?? emptyPantry()
        : fallbackPantry ?? emptyPantry();
      const existingEntries = parseDinnerEntriesSnapshot(typeof entriesRaw === 'string' ? entriesRaw : entriesMirror);
      const existingCookEvents = cookEvent === undefined
        ? []
        : parseCookEventsSnapshot(typeof activityRaw === 'string' ? activityRaw : activityMirror);

      if (storedRecord !== undefined) {
        if (storedRecord.scope !== scope || JSON.stringify(storedRecord.command) !== JSON.stringify(command)
          || JSON.stringify(storedRecord.entry) !== JSON.stringify(entry)
          || JSON.stringify(storedRecord.cookEvent ?? null) !== JSON.stringify(cookEvent ?? null)) {
          throw new DinnerConsumptionConflictError('The operation ID is already committed with different content or scope');
        }
        await completion;
        transactionCommitted = true;
        assertCurrentScope(scope);
        return resultFor(true, storedRecord.entry, pantrySnapshot, storedRecord);
      }
      if (storedEntryRecord !== undefined || existingEntries.some((current) => current.id === entry.id)
        || (cookEvent !== undefined && existingCookEvents.some((current) => current.id === cookEvent.id))) {
        throw new DinnerConsumptionConflictError('The dinner entry already exists without this consumption receipt');
      }

      const plan = planPantryConsumption({ lots: pantrySnapshot.pantryLots ?? [], command, updatedAt: capturedUpdatedAt });
      const nextPantrySnapshot = applyPlan(pantrySnapshot, plan);
      const receipt = createReceipt(command, capturedUpdatedAt, plan);
      const outbox = createOutboxRecord(command, entry, receipt, capturedUpdatedAt, cookEvent);
      assertCurrentScope(scope);
      const writes: Promise<unknown>[] = [
        values.put(serializePantrySnapshot(nextPantrySnapshot), pantryDatabaseKeyForScope(scope)),
        values.put(serializeDinnerEntriesSnapshot([...existingEntries, entry]), dinnerEntriesDatabaseKeyForScope(scope)),
        consumptionStore.put(outbox),
      ];
      if (cookEvent !== undefined) {
        writes.push(values.put(serializeCookEventsSnapshot([...existingCookEvents, cookEvent]), activityEventsDatabaseKeyForScope(scope)));
      }
      await Promise.all(writes);
      assertCurrentScope(scope);
      await completion;
      transactionCommitted = true;
      assertCurrentScope(scope);
      observePantryCanonicalSnapshot(scope, serializePantrySnapshot(nextPantrySnapshot));
      return resultFor(false, entry, nextPantrySnapshot, outbox);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      await completion.catch(() => undefined);
      if (mirrorsTouched && !transactionCommitted) {
        restoreMirror(pantryMirrorKey, pantryMirror);
        restoreMirror(entriesMirrorKey, entriesMirror);
        if (activityMirrorKey !== null) restoreMirror(activityMirrorKey, activityMirror);
      }
      throw error;
    }
  });
}

function commitLocalConsumption(
  command: DinnerConsumptionCommand,
  entry: DinnerEntry,
  updatedAt: string,
  cookEvent?: CookEvent,
): CommittedDinnerConsumption {
  recoverLocalStorageJournal();
  const existingOutbox = readLocalRecord(command.scope, command.operationId);
  const pantrySnapshot = currentPantryFromLocalStorage(command.scope);
  const storage = requireLocalStorage();
  const entriesKey = dinnerEntriesStorageKeyForScope(command.scope);
  const existingEntries = parseDinnerEntriesSnapshot(storage.getItem(entriesKey));
  const activityKey = cookEvent === undefined ? null : activityEventsStorageKeyForScope(command.scope);
  const existingCookEvents = activityKey === null ? [] : parseCookEventsSnapshot(storage.getItem(activityKey));
  if (existingOutbox !== null) {
    if (JSON.stringify(existingOutbox.command) !== JSON.stringify(command) || JSON.stringify(existingOutbox.entry) !== JSON.stringify(entry)
      || JSON.stringify(existingOutbox.cookEvent ?? null) !== JSON.stringify(cookEvent ?? null)) {
      throw new DinnerConsumptionConflictError('The operation ID is already committed with different content or scope');
    }
    return resultFor(true, existingOutbox.entry, pantrySnapshot, existingOutbox);
  }
  if (readLocalRecords(command.scope).some((record) => record.entryId === entry.id)
    || existingEntries.some((current) => current.id === entry.id)
    || (cookEvent !== undefined && existingCookEvents.some((current) => current.id === cookEvent.id))) {
    throw new DinnerConsumptionConflictError('The dinner entry already exists without this consumption receipt');
  }

  const plan = planPantryConsumption({ lots: pantrySnapshot.pantryLots ?? [], command, updatedAt });
  const nextPantrySnapshot = applyPlan(pantrySnapshot, plan);
  const receipt = createReceipt(command, updatedAt, plan);
  const outbox = createOutboxRecord(command, entry, receipt, updatedAt, cookEvent);
  const recordKey = storageRecordKey(command.scope, command.operationId);
  const changes: Record<string, string> = {
    [pantryStorageKeyForScope(command.scope)]: serializePantrySnapshot(nextPantrySnapshot),
    [entriesKey]: serializeDinnerEntriesSnapshot([...existingEntries, entry]),
    [recordKey]: JSON.stringify(outbox),
  };
  if (activityKey !== null && cookEvent !== undefined) {
    changes[activityKey] = serializeCookEventsSnapshot([...existingCookEvents, cookEvent]);
  }
  commitLocalStorageJournal(changes);
  observePantryCanonicalSnapshot(command.scope, serializePantrySnapshot(nextPantrySnapshot));
  return resultFor(false, entry, nextPantrySnapshot, outbox);
}

export async function readDinnerConsumptionReceipt(
  operationId: string,
  scope: SyncScope = getActiveDataScope(),
): Promise<DinnerConsumptionReceipt | null> {
  if (!isIndexedDbAvailable()) {
    recoverLocalStorageJournal();
    assertCurrentScope(scope);
    return readLocalRecord(scope, operationId)?.receipt ?? null;
  }
  const database = await openLocalDatabase();
  assertCurrentScope(scope);
  const record = await database.get(DINNER_CONSUMPTION_STORE, operationId) as DinnerConsumptionOutboxRecord | undefined;
  assertCurrentScope(scope);
  return record?.scope === scope ? record.receipt : null;
}

const assertOutboxReadContext = (scope: SyncScope, assertContext?: () => void): void => {
  if (!isScopeWritable(scope)) throw new ScopeRevokedError();
  if (assertContext !== undefined) {
    assertContext();
  } else {
    assertCurrentScope(scope);
  }
};

export async function readDinnerConsumptionOutbox(
  scope: SyncScope,
  assertContext?: () => void,
): Promise<DinnerConsumptionOutboxRecord[]> {
  if (!isIndexedDbAvailable()) {
    recoverLocalStorageJournal();
    assertOutboxReadContext(scope, assertContext);
    return readLocalRecords(scope).filter((record) => record.status === 'pending');
  }
  const database = await openLocalDatabase();
  assertOutboxReadContext(scope, assertContext);
  const records = await database.getAllFromIndex(DINNER_CONSUMPTION_STORE, 'byScope', scope) as DinnerConsumptionOutboxRecord[];
  assertOutboxReadContext(scope, assertContext);
  return records.filter((record) => isOutboxRecord(record) && record.status === 'pending')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId));
}

export async function acknowledgeDinnerConsumption(operationId: string, scope: SyncScope): Promise<void> {
  return trackScopedWrite(scope, async () => {
    assertCurrentScope(scope);
    if (!isIndexedDbAvailable()) {
      recoverLocalStorageJournal();
      const record = readLocalRecord(scope, operationId);
      if (record === null) return;
      commitLocalStorageJournal({ [storageRecordKey(scope, operationId)]: JSON.stringify({ ...record, status: 'acknowledged' }) });
      return;
    }
    const database = await openLocalDatabase();
    assertCurrentScope(scope);
    const transaction = database.transaction(DINNER_CONSUMPTION_STORE, 'readwrite');
    const completion = transaction.done;
    try {
      const record = await transaction.store.get(operationId) as DinnerConsumptionOutboxRecord | undefined;
      assertCurrentScope(scope);
      if (record !== undefined && record.scope !== scope) throw new DinnerConsumptionConflictError('The operation belongs to a different scope');
      if (record !== undefined && record.status !== 'acknowledged') {
        await transaction.store.put({ ...record, status: 'acknowledged' });
      }
      assertCurrentScope(scope);
      await completion;
      assertCurrentScope(scope);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      await completion.catch(() => undefined);
      throw error;
    }
  });
}

const sameJsonValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const mutationIsNotNewerThanConsumption = (
  mutation: Partial<SyncMutation> & { clientUpdatedAt?: string },
  record: DinnerConsumptionOutboxRecord,
): boolean => {
  if (typeof mutation.clientUpdatedAt !== 'string') return false;
  const mutationTime = Date.parse(mutation.clientUpdatedAt);
  const consumptionTime = Date.parse(record.createdAt);
  return Number.isFinite(mutationTime) && Number.isFinite(consumptionTime) && mutationTime <= consumptionTime;
};

export const isDinnerConsumptionRelatedMutation = (
  mutation: Partial<SyncMutation> & { scope?: SyncScope; mutationId?: string },
  record: DinnerConsumptionOutboxRecord,
): boolean => {
  if (mutation.scope !== undefined && mutation.scope !== record.scope) return false;
  if ((mutation.entityType === 'dinner_entry' || mutation.entityType === 'cook_event')
    && mutation.entityId === record.entryId) return true;
  if (mutation.entityType !== 'pantry_lot' || typeof mutation.entityId !== 'string') return false;
  return record.receipt.plan.upsertLots.some((lot) => lot.id === mutation.entityId)
    || record.receipt.plan.deleteLotIds.includes(mutation.entityId);
};

export const isDinnerConsumptionSupersededMutation = (
  mutation: Partial<SyncMutation> & { scope?: SyncScope; mutationId?: string },
  record: DinnerConsumptionOutboxRecord,
): boolean => {
  if (mutation.scope !== undefined && mutation.scope !== record.scope) return false;
  if (mutation.entityType === 'dinner_entry' && mutation.entityId === record.entryId
    && mutation.operation === 'upsert') {
    return sameJsonValue(mutation.payload, record.entry) || mutationIsNotNewerThanConsumption(mutation, record);
  }
  if (record.cookEvent !== undefined && mutation.entityType === 'cook_event' && mutation.entityId === record.entryId
    && mutation.operation === 'upsert') {
    return sameJsonValue(mutation.payload, record.cookEvent) || mutationIsNotNewerThanConsumption(mutation, record);
  }
  if (mutation.entityType !== 'pantry_lot' || typeof mutation.entityId !== 'string') return false;
  const plannedLot = record.receipt.plan.upsertLots.find((lot) => lot.id === mutation.entityId);
  const isPlannedDelete = record.receipt.plan.deleteLotIds.includes(mutation.entityId);
  if (plannedLot === undefined && !isPlannedDelete) return false;
  if (mutation.operation === 'upsert' && plannedLot !== undefined && sameJsonValue(mutation.payload, plannedLot)) return true;
  if (mutation.operation === 'delete' && isPlannedDelete && mutation.payload === null) return true;
  return mutationIsNotNewerThanConsumption(mutation, record);
};

const upsertEntry = (entries: readonly DinnerEntry[], entry: DinnerEntry): DinnerEntry[] => [
  ...entries.filter((value) => value.id !== entry.id), entry,
];
const removeEntry = (entries: readonly DinnerEntry[], entryId: string): DinnerEntry[] => entries.filter((value) => value.id !== entryId);
const upsertCookEvent = (events: readonly CookEvent[], event: CookEvent): CookEvent[] => [
  ...events.filter((value) => value.id !== event.id), event,
];
const removeCookEvent = (events: readonly CookEvent[], eventId: string): CookEvent[] => events.filter((value) => value.id !== eventId);

const withScopedWrites = <T>(scopes: readonly SyncScope[], action: () => Promise<T>): Promise<T> => {
  const uniqueScopes = [...new Set(scopes)];
  const apply = (index: number): Promise<T> => index >= uniqueScopes.length
    ? action()
    : trackScopedWrite(uniqueScopes[index]!, () => apply(index + 1));
  return apply(0);
};

export async function reconcileDinnerConsumption({
  operationId,
  originalScope,
  canonicalScope,
  result,
  assertContext,
}: {
  operationId: string;
  originalScope: SyncScope;
  canonicalScope: SyncScope;
  result: DinnerConsumptionServerResult;
  assertContext: () => void;
}): Promise<ReconciledDinnerConsumption> {
  const assertCurrent = (): void => {
    if (!isScopeWritable(originalScope) || !isScopeWritable(canonicalScope)) throw new ScopeRevokedError();
    assertContext();
  };
  const pantrySnapshot = normalizePantrySnapshot(result.pantrySnapshot);
  assertCurrent();

  return withScopedWrites([originalScope, canonicalScope], async () => {
    assertCurrent();
    const sourceEntriesKey = dinnerEntriesDatabaseKeyForScope(originalScope);
    const targetEntriesKey = dinnerEntriesDatabaseKeyForScope(canonicalScope);
    const sourceEventsKey = activityEventsDatabaseKeyForScope(originalScope);
    const targetEventsKey = activityEventsDatabaseKeyForScope(canonicalScope);
    const sourceRecordKey = storageRecordKey(originalScope, operationId);
    const targetRecordKey = storageRecordKey(canonicalScope, operationId);

    if (!isIndexedDbAvailable()) {
      recoverLocalStorageJournal();
      const record = readLocalRecord(originalScope, operationId);
      if (record === null || record.operationId !== result.receipt.operationId
        || record.entryId !== result.receipt.entryId || result.entry.id !== record.entryId
        || result.receipt.scope !== canonicalScope) {
        throw new DinnerConsumptionConflictError('The server response does not match the pending dinner operation');
      }
      const storage = requireLocalStorage();
      const sourceEntries = parseDinnerEntriesSnapshot(storage.getItem(dinnerEntriesStorageKeyForScope(originalScope)));
      const targetEntries = originalScope === canonicalScope ? sourceEntries
        : parseDinnerEntriesSnapshot(storage.getItem(dinnerEntriesStorageKeyForScope(canonicalScope)));
      const changes: Record<string, string | null> = {
        [pantryStorageKeyForScope(canonicalScope)]: serializePantrySnapshot(pantrySnapshot),
        [dinnerEntriesStorageKeyForScope(canonicalScope)]: serializeDinnerEntriesSnapshot(upsertEntry(targetEntries, result.entry)),
        [targetRecordKey]: JSON.stringify({ ...record, scope: canonicalScope, scopeEntryId: scopeEntryId(canonicalScope, record.entryId), receipt: result.receipt, status: 'acknowledged' }),
      };
      if (originalScope !== canonicalScope) {
        changes[dinnerEntriesStorageKeyForScope(originalScope)] = serializeDinnerEntriesSnapshot(removeEntry(sourceEntries, record.entryId));
        changes[sourceRecordKey] = null;
      }
      if (result.cookEvent !== undefined) {
        const sourceEvents = parseCookEventsSnapshot(storage.getItem(activityEventsStorageKeyForScope(originalScope)));
        const targetEvents = originalScope === canonicalScope ? sourceEvents
          : parseCookEventsSnapshot(storage.getItem(activityEventsStorageKeyForScope(canonicalScope)));
        changes[activityEventsStorageKeyForScope(canonicalScope)] = serializeCookEventsSnapshot(upsertCookEvent(targetEvents, result.cookEvent));
        if (originalScope !== canonicalScope) {
          changes[activityEventsStorageKeyForScope(originalScope)] = serializeCookEventsSnapshot(removeCookEvent(sourceEvents, record.entryId));
        }
      }
      assertCurrent();
      commitLocalStorageJournal(changes);
      observePantryCanonicalSnapshot(canonicalScope, serializePantrySnapshot(pantrySnapshot));
      assertCurrent();
      return {
        entry: result.entry,
        ...(result.cookEvent === undefined ? {} : { cookEvent: result.cookEvent }),
        pantrySnapshot,
        receipt: result.receipt,
        outbox: { ...record, scope: canonicalScope, scopeEntryId: scopeEntryId(canonicalScope, record.entryId), receipt: result.receipt, status: 'acknowledged' },
      };
    }

    const mirrorKeys = new Set([
      pantryStorageKeyForScope(canonicalScope),
      dinnerEntriesStorageKeyForScope(originalScope),
      dinnerEntriesStorageKeyForScope(canonicalScope),
      ...(result.cookEvent === undefined ? [] : [activityEventsStorageKeyForScope(originalScope), activityEventsStorageKeyForScope(canonicalScope)]),
    ]);
    const mirrors = new Map([...mirrorKeys].map((key) => [key, readMirror(key)]));
    const database = await openLocalDatabase();
    assertCurrent();
    const transaction = database.transaction([KEY_VALUE_STORE, DINNER_CONSUMPTION_STORE, SYNC_QUEUE_STORE], 'readwrite');
    const completion = transaction.done;
    const values = transaction.objectStore(KEY_VALUE_STORE);
    const consumption = transaction.objectStore(DINNER_CONSUMPTION_STORE);
    const queue = transaction.objectStore(SYNC_QUEUE_STORE);
    let mirrorsTouched = false;
    let transactionCommitted = false;
    try {
      mirrorsTouched = true;
      for (const key of mirrorKeys) clearMirror(key);
      const queuedScopes = [...new Set([originalScope, canonicalScope])];
      const [storedRecord, sourceEntriesRaw, targetEntriesRaw, sourceEventsRaw, targetEventsRaw, queuedByScope] = await Promise.all([
        consumption.get(operationId) as Promise<DinnerConsumptionOutboxRecord | undefined>,
        values.get(sourceEntriesKey),
        originalScope === canonicalScope ? Promise.resolve(undefined) : values.get(targetEntriesKey),
        result.cookEvent === undefined ? Promise.resolve(undefined) : values.get(sourceEventsKey),
        result.cookEvent === undefined || originalScope === canonicalScope ? Promise.resolve(undefined) : values.get(targetEventsKey),
        Promise.all(queuedScopes.map((scope) => queue.index('byScope').getAll(scope) as Promise<Array<Partial<SyncMutation> & { scope?: SyncScope; mutationId?: string }>>)),
      ]);
      assertCurrent();
      if (storedRecord === undefined || !isOutboxRecord(storedRecord) || storedRecord.scope !== originalScope
        || storedRecord.operationId !== result.receipt.operationId || storedRecord.entryId !== result.receipt.entryId
        || result.entry.id !== storedRecord.entryId || result.receipt.scope !== canonicalScope) {
        throw new DinnerConsumptionConflictError('The server response does not match the pending dinner operation');
      }
      const sourceEntries = parseDinnerEntriesSnapshot(typeof sourceEntriesRaw === 'string'
        ? sourceEntriesRaw : mirrors.get(dinnerEntriesStorageKeyForScope(originalScope)) ?? null);
      const targetEntries = originalScope === canonicalScope ? sourceEntries
        : parseDinnerEntriesSnapshot(typeof targetEntriesRaw === 'string'
          ? targetEntriesRaw : mirrors.get(dinnerEntriesStorageKeyForScope(canonicalScope)) ?? null);
      const writes: Promise<unknown>[] = [
        values.put(serializePantrySnapshot(pantrySnapshot), pantryDatabaseKeyForScope(canonicalScope)),
        values.put(serializeDinnerEntriesSnapshot(upsertEntry(targetEntries, result.entry)), targetEntriesKey),
      ];
      if (originalScope !== canonicalScope) {
        writes.push(values.put(serializeDinnerEntriesSnapshot(removeEntry(sourceEntries, storedRecord.entryId)), sourceEntriesKey));
      }
      let sourceEvents: CookEvent[] = [];
      if (result.cookEvent !== undefined) {
        sourceEvents = parseCookEventsSnapshot(typeof sourceEventsRaw === 'string'
          ? sourceEventsRaw : mirrors.get(activityEventsStorageKeyForScope(originalScope)) ?? null);
        const targetEvents = originalScope === canonicalScope ? sourceEvents
          : parseCookEventsSnapshot(typeof targetEventsRaw === 'string'
            ? targetEventsRaw : mirrors.get(activityEventsStorageKeyForScope(canonicalScope)) ?? null);
        writes.push(values.put(serializeCookEventsSnapshot(upsertCookEvent(targetEvents, result.cookEvent)), targetEventsKey));
        if (originalScope !== canonicalScope) {
          writes.push(values.put(serializeCookEventsSnapshot(removeCookEvent(sourceEvents, storedRecord.entryId)), sourceEventsKey));
        }
      }
      const acknowledgedRecord: DinnerConsumptionOutboxRecord = {
        ...storedRecord,
        scope: canonicalScope,
        scopeEntryId: scopeEntryId(canonicalScope, storedRecord.entryId),
        receipt: result.receipt,
        status: 'acknowledged',
      };
      for (const queuedValues of queuedByScope) {
        for (const mutation of queuedValues) {
          if (typeof mutation.mutationId === 'string' && isDinnerConsumptionSupersededMutation(mutation, storedRecord)) {
            writes.push(queue.delete(mutation.mutationId));
          }
        }
      }
      writes.push(consumption.put(acknowledgedRecord));
      assertCurrent();
      await Promise.all(writes);
      assertCurrent();
      await completion;
      transactionCommitted = true;
      assertCurrent();
      observePantryCanonicalSnapshot(canonicalScope, serializePantrySnapshot(pantrySnapshot));
      return {
        entry: result.entry,
        ...(result.cookEvent === undefined ? {} : { cookEvent: result.cookEvent }),
        pantrySnapshot,
        receipt: result.receipt,
        outbox: acknowledgedRecord,
      };
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      await completion.catch(() => undefined);
      if (mirrorsTouched && !transactionCommitted) {
        for (const [key, value] of mirrors) restoreMirror(key, value);
      }
      throw error;
    }
  });
}
