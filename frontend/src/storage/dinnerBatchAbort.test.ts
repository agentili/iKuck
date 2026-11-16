import { beforeEach, expect, it, vi } from 'vitest';
import type { CookEvent } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import * as db from './indexedDb';
import { commitDinnerConsumption, readDinnerConsumptionOutbox, reconcileDinnerConsumption } from './dinnerConsumptionStorage';
import { activityEventsStorageKeyForScope, readCookEvents, serializeCookEventsSnapshot } from './activityStorage';
import { setActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { waitForScopedWrites } from '../sync/scopeWriteFence';
import { readSyncCursor } from '../sync/syncQueue';

const timestamp = '2026-10-07T09:00:00.000Z';
const event: CookEvent = { id: 'dinner-new', recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 2, cookedAt: timestamp, note: null, createdAt: timestamp, updatedAt: timestamp };
const oldEvent: CookEvent = { ...event, id: 'old-event' };
const entry: DinnerEntry = { id: event.id, date: '2026-10-07', text: 'Pasta', servings: 2, note: null, recipes: [], authorId: null, createdAt: timestamp, updatedAt: timestamp };
const command = (scope: SyncScope): DinnerConsumptionCommand => ({ operationId: 'batch-abort-op', entryId: entry.id, scope, servings: 2, ingredients: [] });

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.deleteLocalDatabase();
  window.localStorage.clear();
  setActiveDataScope('guest');
});

for (const operation of ['commit', 'reconcile', 'migration'] as const) {
  it.each(['receipt', 'second snapshot'] as const)(`${operation} drains requests after synchronous %s put failure without hiding root error`, async (fault) => {
    const source: SyncScope = 'guest';
    const target: SyncScope = operation === 'migration' ? 'house:batch-abort' : source;
    window.localStorage.setItem(activityEventsStorageKeyForScope(source), serializeCookEventsSnapshot([oldEvent]));
    const committed = operation === 'commit' ? null : await commitDinnerConsumption({ command: command(source), entry, cookEvent: event });
    setActiveDataScope(target);
    const mirrorKey = activityEventsStorageKeyForScope(target);
    const mirror = serializeCookEventsSnapshot(target === source ? [oldEvent, ...(committed ? [event] : [])] : [oldEvent]);
    window.localStorage.setItem(mirrorKey, mirror);
    const queued = { mutationId: 'queued-dinner', scope: source, entityType: 'cook_event', entityId: event.id, operation: 'upsert', payload: event, clientUpdatedAt: timestamp } as const;
    await db.writeQueueValue(queued);
    await db.writeMeta(`syncCursor:${source}`, 17);
    if (target !== source) await db.writeMeta(`syncCursor:${target}`, 23);
    const database = await db.openLocalDatabase();
    const beforeValues = await database.getAll(db.KEY_VALUE_STORE);
    const beforeKeys = await database.getAllKeys(db.KEY_VALUE_STORE);
    const beforeRecords = await database.getAll(db.DINNER_CONSUMPTION_STORE);
    const beforeCursor = await readSyncCursor(target);
    const sourceCursor = await readSyncCursor(source);
    const beforeLocal = Object.fromEntries(Object.keys(window.localStorage).map((key) => [key, window.localStorage.getItem(key)]));
    const failure = new DOMException('injected batch failure', 'QuotaExceededError');
    const put = IDBObjectStore.prototype.put;
    let snapshotWrites = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === db.KEY_VALUE_STORE) snapshotWrites += 1;
      if ((fault === 'receipt' && this.name === db.DINNER_CONSUMPTION_STORE)
        || (fault === 'second snapshot' && this.name === db.KEY_VALUE_STORE && snapshotWrites === 2)) {
        this.transaction.abort();
        throw failure;
      }
      return put.apply(this, args);
    });
    const perform = () => committed === null ? commitDinnerConsumption({ command: command(source), entry, cookEvent: event })
      : reconcileDinnerConsumption({ operationId: command(source).operationId, originalScope: source, canonicalScope: target, assertContext: () => {}, result: { entry, cookEvent: event, receipt: { ...committed.receipt, scope: target }, pantrySnapshot: committed.pantrySnapshot } });
    try {
      await expect(perform()).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
    expect(await database.getAll(db.KEY_VALUE_STORE)).toEqual(beforeValues);
    expect(await database.getAllKeys(db.KEY_VALUE_STORE)).toEqual(beforeKeys);
    expect(await database.getAll(db.DINNER_CONSUMPTION_STORE)).toEqual(beforeRecords);
    expect(await readDinnerConsumptionOutbox(source, () => {})).toEqual(committed ? [committed.outbox] : []);
    expect(await db.readQueueValues(source)).toEqual([queued]);
    expect(await readSyncCursor(target)).toBe(beforeCursor);
    expect(await readSyncCursor(source)).toBe(sourceCursor);
    expect(Object.fromEntries(Object.keys(window.localStorage).map((key) => [key, window.localStorage.getItem(key)]))).toEqual(beforeLocal);
    await waitForScopedWrites(source);
    await waitForScopedWrites(target);
    await perform();
    expect(await readCookEvents(target)).toEqual([oldEvent, event]);
    expect(await readDinnerConsumptionOutbox(source, () => {})).toHaveLength(committed ? 0 : 1);
    expect(await db.readQueueValues(source)).toEqual(committed ? [] : [queued]);
    expect(await readSyncCursor(target)).toBe(beforeCursor);
    expect(await readSyncCursor(source)).toBe(sourceCursor);
    if (target !== source) expect(await readCookEvents(source)).toEqual([oldEvent]);
  });
}
