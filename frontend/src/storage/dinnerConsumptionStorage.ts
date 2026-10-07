import type { DinnerConsumptionCommand, PantryConsumptionPlan } from '@ikuck/shared/pantryConsumption';
import { planPantryConsumption } from '@ikuck/shared/pantryConsumption';
import type { CookEvent } from '@ikuck/shared/contracts';
import { isCookEvent } from '../domain/activity';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { isDinnerEntry } from '@ikuck/shared/dinnerDiary';
import {
  commitLocalStorageJournal,
  DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX,
  DINNER_CONSUMPTION_STORE,
  isIndexedDbAvailable,
  KEY_VALUE_STORE,
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
  pantryDatabaseKeyForScope,
  pantryStorageKeyForScope,
  parsePantrySnapshot,
  serializePantrySnapshot,
  type PantrySnapshot,
} from './pantryStorage';
import { getActiveDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { isScopeWritable, ScopeRevokedError, trackScopedWrite } from '../sync/scopeWriteFence';

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
  const raw = window.localStorage.getItem(storageRecordKey(scope, operationId));
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
  const prefix = localRecordPrefix(scope);
  const records: DinnerConsumptionOutboxRecord[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null || !key.startsWith(prefix)) continue;
    const raw = window.localStorage.getItem(key);
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
  const raw = window.localStorage.getItem(pantryStorageKeyForScope(scope));
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

  return trackScopedWrite(scope, async () => {
    assertCurrentScope(scope);
    if (!isIndexedDbAvailable()) {
      return commitLocalConsumption(command, entry, capturedUpdatedAt, cookEvent);
    }

    recoverLocalStorageJournal();
    const pantryMirrorKey = pantryStorageKeyForScope(scope);
    const entriesMirrorKey = dinnerEntriesStorageKeyForScope(scope);
    const activityMirrorKey = cookEvent === undefined ? null : activityEventsStorageKeyForScope(scope);
    const pantryMirror = window.localStorage.getItem(pantryMirrorKey);
    const entriesMirror = window.localStorage.getItem(entriesMirrorKey);
    const activityMirror = activityMirrorKey === null ? null : window.localStorage.getItem(activityMirrorKey);
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
      window.localStorage.removeItem(pantryMirrorKey);
      window.localStorage.removeItem(entriesMirrorKey);
      if (activityMirrorKey !== null) window.localStorage.removeItem(activityMirrorKey);
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
      return resultFor(false, entry, nextPantrySnapshot, outbox);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      await completion.catch(() => undefined);
      if (mirrorsTouched && !transactionCommitted) {
        try {
          if (pantryMirror === null) window.localStorage.removeItem(pantryMirrorKey);
          else window.localStorage.setItem(pantryMirrorKey, pantryMirror);
          if (entriesMirror === null) window.localStorage.removeItem(entriesMirrorKey);
          else window.localStorage.setItem(entriesMirrorKey, entriesMirror);
          if (activityMirrorKey !== null) {
            if (activityMirror === null) window.localStorage.removeItem(activityMirrorKey);
            else window.localStorage.setItem(activityMirrorKey, activityMirror);
          }
        } catch {
          // The IndexedDB transaction remains authoritative if mirror restoration fails.
        }
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
  const entriesKey = dinnerEntriesStorageKeyForScope(command.scope);
  const existingEntries = parseDinnerEntriesSnapshot(window.localStorage.getItem(entriesKey));
  const activityKey = cookEvent === undefined ? null : activityEventsStorageKeyForScope(command.scope);
  const existingCookEvents = activityKey === null ? [] : parseCookEventsSnapshot(window.localStorage.getItem(activityKey));
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
  return resultFor(false, entry, nextPantrySnapshot, outbox);
}

export async function readDinnerConsumptionReceipt(
  operationId: string,
  scope: SyncScope = getActiveDataScope(),
): Promise<DinnerConsumptionReceipt | null> {
  recoverLocalStorageJournal();
  assertCurrentScope(scope);
  if (!isIndexedDbAvailable()) return readLocalRecord(scope, operationId)?.receipt ?? null;
  const database = await openLocalDatabase();
  assertCurrentScope(scope);
  const record = await database.get(DINNER_CONSUMPTION_STORE, operationId) as DinnerConsumptionOutboxRecord | undefined;
  assertCurrentScope(scope);
  return record?.scope === scope ? record.receipt : null;
}

export async function readDinnerConsumptionOutbox(scope: SyncScope): Promise<DinnerConsumptionOutboxRecord[]> {
  recoverLocalStorageJournal();
  assertCurrentScope(scope);
  if (!isIndexedDbAvailable()) return readLocalRecords(scope).filter((record) => record.status === 'pending');
  const database = await openLocalDatabase();
  assertCurrentScope(scope);
  const records = await database.getAllFromIndex(DINNER_CONSUMPTION_STORE, 'byScope', scope) as DinnerConsumptionOutboxRecord[];
  assertCurrentScope(scope);
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
