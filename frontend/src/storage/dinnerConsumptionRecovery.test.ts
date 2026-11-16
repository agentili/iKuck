import { beforeEach, expect, it, vi } from 'vitest';
import type { CookEvent } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import * as db from './indexedDb';
import { activityEventsDatabaseKeyForScope, activityEventsStorageKeyForScope, readCookEvents, serializeCookEventsSnapshot } from './activityStorage';
import { dinnerEntriesDatabaseKeyForScope, dinnerEntriesStorageKeyForScope, serializeDinnerEntriesSnapshot } from './dinnerDiaryStorage';
import { pantryDatabaseKeyForScope, pantryStorageKeyForScope, serializePantrySnapshot } from './pantryStorage';
import { commitDinnerConsumption, readDinnerConsumptionOutbox, reconcileDinnerConsumption } from './dinnerConsumptionStorage';
import { getActiveDataScope, setActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { resumeScope, waitForScopedWrites } from '../sync/scopeWriteFence';

const timestamp = '2026-10-07T09:00:00.000Z';
const event: CookEvent = { id: 'dinner-new', recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 2, cookedAt: timestamp, note: null, createdAt: timestamp, updatedAt: timestamp };
const oldEvent: CookEvent = { ...event, id: 'old-event' };
const entry: DinnerEntry = { id: event.id, date: '2026-10-07', text: 'Pasta', servings: 2, note: null, recipes: [], authorId: null, createdAt: timestamp, updatedAt: timestamp };
const command = (scope: SyncScope): DinnerConsumptionCommand => ({ operationId: 'recovery-op', entryId: entry.id, scope, servings: 2, ingredients: [] });
const snapshots = [
  { name: 'activity', databaseKey: activityEventsDatabaseKeyForScope, storageKey: activityEventsStorageKeyForScope, raw: serializeCookEventsSnapshot([oldEvent]) },
  { name: 'diary', databaseKey: dinnerEntriesDatabaseKeyForScope, storageKey: dinnerEntriesStorageKeyForScope, raw: serializeDinnerEntriesSnapshot([{ ...entry, id: 'old-entry' }]) },
  { name: 'pantry', databaseKey: pantryDatabaseKeyForScope, storageKey: pantryStorageKeyForScope, raw: serializePantrySnapshot({ pantryItems: [], stapleIds: ['salt'], pantryLots: [] }) },
];

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.deleteLocalDatabase();
  window.localStorage.clear();
  setActiveDataScope('guest');
  resumeScope('guest');
  resumeScope('account:recovery');
  resumeScope('house:recovery');
});

it.each(snapshots)('commit preserves an unreadable $name fallback and retries after recovery', async (snapshot) => {
  const key = snapshot.storageKey('guest');
  window.localStorage.setItem(key, snapshot.raw);
  const get = Storage.prototype.getItem;
  const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, current) {
    if (current === key) throw new Error('temporary read failure');
    return get.call(this, current);
  });
  try {
    await expect(commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event })).rejects.toThrow('temporary read failure');
  } finally {
    denied.mockRestore();
  }
  expect(window.localStorage.getItem(key)).toBe(snapshot.raw);
  expect(await db.readKeyValue(snapshot.databaseKey('guest'))).toBeNull();
  expect(await readDinnerConsumptionOutbox('guest')).toEqual([]);
  await waitForScopedWrites('guest');
  const committed = await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event });
  expect(committed.duplicate).toBe(false);
  expect((await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event })).duplicate).toBe(true);
  if (snapshot.name === 'activity') expect(await readCookEvents()).toEqual([oldEvent, event]);
});

it.each(snapshots)('commit refuses non-string $name primary even with a valid fallback', async (snapshot) => {
  const raw: unknown = JSON.parse(snapshot.raw);
  await db.writeKeyValue(snapshot.databaseKey('guest'), raw);
  window.localStorage.setItem(snapshot.storageKey('guest'), snapshot.raw);
  await expect(commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event })).rejects.toThrow();
  expect(await db.readKeyValue(snapshot.databaseKey('guest'))).toEqual(raw);
  expect(window.localStorage.getItem(snapshot.storageKey('guest'))).toBe(snapshot.raw);
  expect(await readDinnerConsumptionOutbox('guest')).toEqual([]);
});

it.each(snapshots)('commit refuses corrupt $name JSON without discarding either copy', async (snapshot) => {
  await db.writeKeyValue(snapshot.databaseKey('guest'), '{broken');
  window.localStorage.setItem(snapshot.storageKey('guest'), snapshot.raw);
  await expect(commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event })).rejects.toThrow();
  expect(await db.readKeyValue(snapshot.databaseKey('guest'))).toBe('{broken');
  expect(window.localStorage.getItem(snapshot.storageKey('guest'))).toBe(snapshot.raw);
  expect(await readDinnerConsumptionOutbox('guest')).toEqual([]);
});

it.each(snapshots)('reconcile preserves pending outbox and queued mutations on unreadable $name fallback', async (snapshot) => {
  const scope = 'account:recovery';
  setActiveDataScope(scope);
  const committed = await commitDinnerConsumption({ command: command(scope), entry, cookEvent: event });
  const mutation = { mutationId: 'queued-dinner', scope, entityType: 'cook_event', entityId: event.id, operation: 'upsert', payload: event, clientUpdatedAt: timestamp } as const;
  await db.writeQueueValue(mutation);
  const key = snapshot.storageKey(scope);
  const raw = snapshot.name === 'activity' ? serializeCookEventsSnapshot([oldEvent, event]) : snapshot.raw;
  await db.deleteKeyValue(snapshot.databaseKey(scope));
  window.localStorage.setItem(key, raw);
  const get = Storage.prototype.getItem;
  const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, current) {
    if (current === key) throw new Error('temporary read failure');
    return get.call(this, current);
  });
  const reconcile = () => reconcileDinnerConsumption({ operationId: command(scope).operationId, originalScope: scope, canonicalScope: scope, result: { entry, cookEvent: event, receipt: committed.receipt, pantrySnapshot: committed.pantrySnapshot }, assertContext: () => { expect(getActiveDataScope()).toBe(scope); } });
  try {
    await expect(reconcile()).rejects.toThrow('temporary read failure');
  } finally {
    denied.mockRestore();
  }
  expect(window.localStorage.getItem(key)).toBe(raw);
  expect(await db.readKeyValue(snapshot.databaseKey(scope))).toBeNull();
  expect(await readDinnerConsumptionOutbox(scope)).toEqual([committed.outbox]);
  expect(await db.readQueueValues(scope)).toEqual([mutation]);
  await waitForScopedWrites(scope);
  expect((await reconcile()).outbox.status).toBe('acknowledged');
  expect(await readDinnerConsumptionOutbox(scope)).toEqual([]);
  expect(await db.readQueueValues(scope)).toEqual([]);
  if (snapshot.name === 'activity') expect(await readCookEvents(scope)).toEqual([oldEvent, event]);
});

it.each(snapshots)('reconcile refuses non-string $name primary without acknowledging the outbox', async (snapshot) => {
  const scope = 'account:recovery';
  setActiveDataScope(scope);
  const committed = await commitDinnerConsumption({ command: command(scope), entry, cookEvent: event });
  const corrupt: unknown = JSON.parse(snapshot.raw);
  await db.writeKeyValue(snapshot.databaseKey(scope), corrupt);
  await expect(reconcileDinnerConsumption({ operationId: command(scope).operationId, originalScope: scope, canonicalScope: scope, result: { entry, cookEvent: event, receipt: committed.receipt, pantrySnapshot: committed.pantrySnapshot }, assertContext: () => {} })).rejects.toThrow();
  expect(await db.readKeyValue(snapshot.databaseKey(scope))).toEqual(corrupt);
  expect(await readDinnerConsumptionOutbox(scope)).toEqual([committed.outbox]);
});

it.each(['source', 'target'] as const)('migration preserves both scopes when the %s activity fallback is unreadable', async (side) => {
  const source = 'account:recovery';
  const target = 'house:recovery';
  setActiveDataScope(source);
  const committed = await commitDinnerConsumption({ command: command(source), entry, cookEvent: event });
  setActiveDataScope(target);
  const scope = side === 'source' ? source : target;
  const raw = serializeCookEventsSnapshot(side === 'source' ? [oldEvent, event] : [oldEvent]);
  const key = activityEventsStorageKeyForScope(scope);
  await db.deleteKeyValue(activityEventsDatabaseKeyForScope(scope));
  window.localStorage.setItem(key, raw);
  const get = Storage.prototype.getItem;
  const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, current) {
    if (current === key) throw new Error('unreadable migration history');
    return get.call(this, current);
  });
  const reconcile = () => reconcileDinnerConsumption({ operationId: command(source).operationId, originalScope: source, canonicalScope: target, result: { entry, cookEvent: event, receipt: { ...committed.receipt, scope: target }, pantrySnapshot: committed.pantrySnapshot }, assertContext: () => { expect(getActiveDataScope()).toBe(target); } });
  try {
    await expect(reconcile()).rejects.toThrow('unreadable migration history');
  } finally {
    denied.mockRestore();
  }
  expect(window.localStorage.getItem(key)).toBe(raw);
  expect(await readDinnerConsumptionOutbox(source, () => {})).toEqual([committed.outbox]);
  expect(await readDinnerConsumptionOutbox(target)).toEqual([]);
  await reconcile();
  expect(await readDinnerConsumptionOutbox(source, () => {})).toEqual([]);
  expect(await readCookEvents(target)).toEqual(side === 'target' ? [oldEvent, event] : [event]);
  expect(await readCookEvents(source)).toEqual(side === 'source' ? [oldEvent] : []);
});

it.each(['commit', 'reconcile'] as const)('fences %s after database open changes the active scope', async (operation) => {
  const committed = operation === 'reconcile' ? await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event }) : null;
  const key = activityEventsStorageKeyForScope('guest');
  const raw = serializeCookEventsSnapshot([oldEvent, ...(committed === null ? [] : [event])]);
  await db.deleteKeyValue(activityEventsDatabaseKeyForScope('guest'));
  window.localStorage.setItem(key, raw);
  const originalOpen = db.openLocalDatabase;
  const open = vi.spyOn(db, 'openLocalDatabase').mockImplementationOnce(async () => {
    const database = await originalOpen();
    setActiveDataScope('account:recovery');
    return database;
  });
  try {
    const pending = committed === null ? commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event })
      : reconcileDinnerConsumption({ operationId: command('guest').operationId, originalScope: 'guest', canonicalScope: 'guest', result: { entry, cookEvent: event, receipt: committed.receipt, pantrySnapshot: committed.pantrySnapshot }, assertContext: () => { if (getActiveDataScope() !== 'guest') throw new Error('scope changed'); } });
    await expect(pending).rejects.toThrow(/scope changed/);
  } finally {
    open.mockRestore();
  }
  expect(window.localStorage.getItem(key)).toBe(raw);
  expect(await db.readKeyValue(activityEventsDatabaseKeyForScope('guest'))).toBeNull();
  expect(await readDinnerConsumptionOutbox('guest', () => {})).toEqual(committed === null ? [] : [committed.outbox]);
  setActiveDataScope('guest');
  await waitForScopedWrites('guest');
  if (committed === null) await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event });
});

it.each(snapshots)('fallback-only commit preserves corrupt $name snapshots without creating a journal', async (snapshot) => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  const key = snapshot.storageKey('guest');
  window.localStorage.setItem(key, '{broken');
  try {
    await expect(commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event })).rejects.toThrow();
    expect(window.localStorage.getItem(key)).toBe('{broken');
    expect(window.localStorage.getItem(db.LOCAL_STORAGE_JOURNAL_KEY)).toBeNull();
    expect(await readDinnerConsumptionOutbox('guest')).toEqual([]);
  } finally {
    if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
  }
});

it.each(snapshots)('does not clean up an invalid $name mirror even with a valid primary', async (snapshot) => {
  await db.writeKeyValue(snapshot.databaseKey('guest'), snapshot.raw);
  const key = snapshot.storageKey('guest');
  window.localStorage.setItem(key, '{recoverable-fragment');
  const committed = await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event });
  expect(window.localStorage.getItem(key)).toBe('{recoverable-fragment');
  await reconcileDinnerConsumption({ operationId: command('guest').operationId, originalScope: 'guest', canonicalScope: 'guest', result: { entry, cookEvent: event, receipt: committed.receipt, pantrySnapshot: committed.pantrySnapshot }, assertContext: () => {} });
  expect(window.localStorage.getItem(key)).toBe('{recoverable-fragment');
});
