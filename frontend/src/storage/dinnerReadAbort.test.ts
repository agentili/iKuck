import { beforeEach, expect, it, vi } from 'vitest';
import type { CookEvent } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import * as db from './indexedDb';
import { commitDinnerConsumption, readDinnerConsumptionOutbox, reconcileDinnerConsumption } from './dinnerConsumptionStorage';
import { activityEventsDatabaseKeyForScope, activityEventsStorageKeyForScope, readCookEvents, serializeCookEventsSnapshot } from './activityStorage';
import { dinnerEntriesDatabaseKeyForScope } from './dinnerDiaryStorage';
import { pantryDatabaseKeyForScope } from './pantryStorage';
import { setActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { waitForScopedWrites } from '../sync/scopeWriteFence';

const timestamp = '2026-10-07T09:00:00.000Z';
const event: CookEvent = { id: 'dinner-read', recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 2, cookedAt: timestamp, note: null, createdAt: timestamp, updatedAt: timestamp };
const oldEvent: CookEvent = { ...event, id: 'old-event' };
const entry: DinnerEntry = { id: event.id, date: '2026-10-07', text: 'Pasta', servings: 2, note: null, recipes: [], authorId: null, createdAt: timestamp, updatedAt: timestamp };
const command: DinnerConsumptionCommand = { operationId: 'read-abort-op', entryId: entry.id, scope: 'guest', servings: 2, ingredients: [] };

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.deleteLocalDatabase();
  window.localStorage.clear();
  setActiveDataScope('guest');
});

for (const operation of ['commit', 'reconcile', 'migration'] as const) {
  const faults = operation === 'commit' ? ['diary', 'activity', 'entry index'] as const
    : operation === 'migration' ? ['diary', 'activity', 'target diary', 'target activity', 'second queue', 'pantry'] as const
      : ['diary', 'activity', 'pantry'] as const;
  it.each(faults)(`${operation} drains all earlier reads after synchronous %s failure`, async (fault) => {
    const source: SyncScope = 'guest';
    const target: SyncScope = operation === 'migration' ? 'house:read-abort' : source;
    window.localStorage.setItem(activityEventsStorageKeyForScope(source), serializeCookEventsSnapshot([oldEvent]));
    const committed = operation === 'commit' ? null : await commitDinnerConsumption({ command, entry, cookEvent: event });
    setActiveDataScope(target);
    window.localStorage.setItem(activityEventsStorageKeyForScope(target), serializeCookEventsSnapshot(target === source ? [oldEvent, ...(committed ? [event] : [])] : [oldEvent]));
    const queued = { mutationId: 'queued-dinner', scope: source, entityType: 'cook_event', entityId: event.id, operation: 'upsert', payload: event, clientUpdatedAt: timestamp } as const;
    const unrelated = { ...queued, mutationId: 'unrelated', entityId: oldEvent.id, payload: oldEvent, scope: target };
    await db.writeQueueValue(queued);
    await db.writeQueueValue(unrelated);
    await db.writeMeta(`syncCursor:${source}`, 17);
    if (target !== source) await db.writeMeta(`syncCursor:${target}`, 23);
    const database = await db.openLocalDatabase();
    const stores = [db.KEY_VALUE_STORE, db.DINNER_CONSUMPTION_STORE, db.SYNC_META_STORE, db.SYNC_QUEUE_STORE] as const;
    const snapshot = async () => Promise.all(stores.map(async (store) => ({ keys: await database.getAllKeys(store), values: await database.getAll(store) })));
    const localSnapshot = () => Object.fromEntries(Object.keys(window.localStorage).map((key) => [key, window.localStorage.getItem(key)]));
    const before = await snapshot();
    const beforeLocal = localSnapshot();
    const root = new DOMException('injected synchronous read failure', 'UnknownError');
    const get = IDBObjectStore.prototype.get;
    const indexGet = IDBIndex.prototype.get;
    const getAll = IDBIndex.prototype.getAll;
    const faultKey = fault === 'diary' ? dinnerEntriesDatabaseKeyForScope(source)
      : fault === 'target diary' ? dinnerEntriesDatabaseKeyForScope(target)
        : fault === 'activity' ? activityEventsDatabaseKeyForScope(source)
          : fault === 'target activity' ? activityEventsDatabaseKeyForScope(target)
            : fault === 'pantry' ? pantryDatabaseKeyForScope(target) : null;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === db.KEY_VALUE_STORE && key === faultKey) throw root;
      return get.call(this, key);
    });
    const indexSpy = vi.spyOn(IDBIndex.prototype, 'get').mockImplementation(function (this: IDBIndex, key) {
      if (fault === 'entry index' && this.objectStore.name === db.DINNER_CONSUMPTION_STORE) throw root;
      return indexGet.call(this, key);
    });
    const queueSpy = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex['getAll']>) {
      if (fault === 'second queue' && this.objectStore.name === db.SYNC_QUEUE_STORE && args[0] === target) throw root;
      return getAll.apply(this, args);
    });
    const perform = () => committed === null ? commitDinnerConsumption({ command, entry, cookEvent: event })
      : reconcileDinnerConsumption({ operationId: command.operationId, originalScope: source, canonicalScope: target, assertContext: () => {}, result: { entry, cookEvent: event, receipt: { ...committed.receipt, scope: target }, pantrySnapshot: committed.pantrySnapshot } });
    try {
      // Injection does not abort: the production catch must abort and drain.
      await expect(perform()).rejects.toBe(root);
    } finally {
      getSpy.mockRestore();
      indexSpy.mockRestore();
      queueSpy.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
    expect(localSnapshot()).toEqual(beforeLocal);
    expect(await readDinnerConsumptionOutbox(source, () => {})).toEqual(committed ? [committed.outbox] : []);
    await waitForScopedWrites(source);
    await waitForScopedWrites(target);
    const retried = await perform();
    expect(retried.outbox.status).toBe(committed ? 'acknowledged' : 'pending');
    expect(await readCookEvents(target)).toEqual([oldEvent, event]);
    expect(await readDinnerConsumptionOutbox(source, () => {})).toEqual(committed ? [] : [retried.outbox]);
    if (target !== source) {
      expect(await readCookEvents(source)).toEqual([oldEvent]);
      expect(await readDinnerConsumptionOutbox(target, () => {})).toEqual([]);
    }
    expect(await database.getAll(db.SYNC_QUEUE_STORE)).toEqual(committed ? [unrelated] : [queued, unrelated]);
    expect(await database.getAll(db.SYNC_META_STORE)).toEqual(before[2]!.values);
    expect(await database.getAll(db.DINNER_CONSUMPTION_STORE)).toEqual([retried.outbox]);
  });
}
