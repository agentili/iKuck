import { beforeEach, expect, it, vi } from 'vitest';
import type { CookEvent } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import * as db from './indexedDb';
import { commitDinnerConsumption, readDinnerConsumptionOutbox, reconcileDinnerConsumption } from './dinnerConsumptionStorage';
import { pantryDatabaseKeyForScope, pantryStorageKeyForScope, serializePantrySnapshot } from './pantryStorage';
import { setActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { waitForScopedWrites } from '../sync/scopeWriteFence';
import { readSyncCursor } from '../sync/syncQueue';

const timestamp = '2026-10-07T09:00:00.000Z';
const event: CookEvent = { id: 'dinner-new', recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 2, cookedAt: timestamp, note: null, createdAt: timestamp, updatedAt: timestamp };
const entry: DinnerEntry = { id: event.id, date: '2026-10-07', text: 'Pasta', servings: 2, note: null, recipes: [], authorId: null, createdAt: timestamp, updatedAt: timestamp };
const command = (scope: SyncScope): DinnerConsumptionCommand => ({ operationId: 'pantry-recovery-op', entryId: entry.id, scope, servings: 2, ingredients: [] });
const valid = serializePantrySnapshot({ pantryItems: [], stapleIds: [], pantryLots: [] });
const corruptSnapshots = [
  { name: 'BROKEN quantity', lots: [{ id: 'recoverable-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 'BROKEN', unit: 'g', expiresAt: null, createdAt: timestamp, updatedAt: timestamp }] },
  { name: 'non-array lots', lots: { recoverable: 'lot-fragment' } },
  { name: 'null lots', lots: null },
];
const corruptRaw = (lots: unknown) => JSON.stringify({ version: 1, state: { pantryItems: [], stapleIds: [], pantryLots: lots } });
const localImage = () => Object.fromEntries(Object.keys(window.localStorage).sort().map((key) => [key, window.localStorage.getItem(key)]));

async function withBackend(backend: 'IDB' | 'journal', action: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
  if (backend === 'journal') Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  try { await action(); } finally {
    if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
  }
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.deleteLocalDatabase();
  window.localStorage.clear();
  setActiveDataScope('guest');
});

for (const backend of ['IDB', 'journal'] as const) {
  for (const operation of ['commit', 'reconcile'] as const) {
    for (const location of backend === 'IDB' ? ['primary', 'fallback'] as const : ['fallback'] as const) {
      it.each(corruptSnapshots)(`${backend} ${operation} refuses $name in ${location}, preserves all copies/outbox and recovers`, async ({ lots }) => {
        await withBackend(backend, async () => {
          const committed = operation === 'reconcile' ? await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event }) : null;
          const mutation = { mutationId: 'queued-dinner', scope: 'guest', entityType: 'cook_event', entityId: event.id, operation: 'upsert', payload: event, clientUpdatedAt: timestamp } as const;
          const database = backend === 'IDB' ? await db.openLocalDatabase() : null;
          if (database) {
            await db.writeQueueValue(mutation);
            await db.writeMeta('syncCursor:guest', 17);
          }
          const raw = corruptRaw(lots);
          if (database) {
            if (location === 'primary') await db.writeKeyValue('pantry', raw);
            else await db.deleteKeyValue('pantry');
          }
          window.localStorage.setItem('ikuck-pantry-v1', raw);
          const beforeLocal = localImage();
          const beforeValues = database ? await database.getAll(db.KEY_VALUE_STORE) : null;
          const beforeCursor = database ? await readSyncCursor('guest') : null;
          const perform = () => committed === null ? commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event })
            : reconcileDinnerConsumption({ operationId: command('guest').operationId, originalScope: 'guest', canonicalScope: 'guest', assertContext: () => {}, result: { entry, cookEvent: event, receipt: committed.receipt, pantrySnapshot: committed.pantrySnapshot } });
          await expect(perform()).rejects.toThrow('Invalid local pantry snapshot');
          expect(localImage()).toEqual(beforeLocal);
          expect(window.localStorage.getItem(db.LOCAL_STORAGE_JOURNAL_KEY)).toBeNull();
          expect(await readDinnerConsumptionOutbox('guest')).toEqual(committed ? [committed.outbox] : []);
          if (database) {
            expect(await database.getAll(db.KEY_VALUE_STORE)).toEqual(beforeValues);
            expect(await db.readQueueValues('guest')).toEqual([mutation]);
            expect(await readSyncCursor('guest')).toBe(beforeCursor);
          }
          await waitForScopedWrites('guest');
          // Recovery is explicit: replace the damaged fixture, not a side effect of failure.
          if (database && location === 'primary') await db.writeKeyValue('pantry', valid);
          window.localStorage.setItem('ikuck-pantry-v1', valid);
          await perform();
          expect(await readDinnerConsumptionOutbox('guest')).toHaveLength(committed ? 0 : 1);
          if (database) {
            expect(await db.readQueueValues('guest')).toEqual(committed ? [] : [mutation]);
            expect(await readSyncCursor('guest')).toBe(beforeCursor);
          }
        });
      });
    }
  }

  it(`${backend} accepts legacy pantry with absent lots, retaining the ingredient`, async () => {
    await withBackend(backend, async () => {
      const legacy = JSON.stringify({ version: 1, state: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'] } });
      window.localStorage.setItem('ikuck-pantry-v1', legacy);
      const committed = await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event });
      expect(committed.pantrySnapshot.pantryLots).toEqual([expect.objectContaining({ ingredientId: 'pasta', quantity: null, unit: null })]);
      expect(committed.pantrySnapshot.stapleIds).toEqual(['salt']);
      expect(await readDinnerConsumptionOutbox('guest')).toEqual([committed.outbox]);
    });
  });

  it.each(['source', 'target'] as const)(`${backend} migration protects %s pantry according to participation`, async (side) => {
    await withBackend(backend, async () => {
      const source = 'account:pantry-recovery';
      const target = 'house:pantry-recovery';
      setActiveDataScope(source);
      const committed = await commitDinnerConsumption({ command: command(source), entry, cookEvent: event });
      setActiveDataScope(target);
      const scope = side === 'source' ? source : target;
      const raw = corruptRaw(corruptSnapshots[0].lots);
      const key = pantryStorageKeyForScope(scope);
      if (backend === 'IDB') await db.writeKeyValue(pantryDatabaseKeyForScope(scope), raw);
      window.localStorage.setItem(key, raw);
      const beforeLocal = localImage();
      const database = backend === 'IDB' ? await db.openLocalDatabase() : null;
      const mutation = { mutationId: 'queued-migration', scope: source, entityType: 'cook_event', entityId: event.id, operation: 'upsert', payload: event, clientUpdatedAt: timestamp } as const;
      if (database) {
        await db.writeQueueValue(mutation);
        await db.writeMeta(`syncCursor:${source}`, 17);
        await db.writeMeta(`syncCursor:${target}`, 23);
      }
      const beforeValues = database ? await database.getAll(db.KEY_VALUE_STORE) : null;
      const perform = () => reconcileDinnerConsumption({ operationId: command(source).operationId, originalScope: source, canonicalScope: target, assertContext: () => {}, result: { entry, cookEvent: event, receipt: { ...committed.receipt, scope: target }, pantrySnapshot: committed.pantrySnapshot } });
      if (side === 'target') {
        await expect(perform()).rejects.toThrow('Invalid local pantry snapshot');
        expect(localImage()).toEqual(beforeLocal);
        if (database) expect(await database.getAll(db.KEY_VALUE_STORE)).toEqual(beforeValues);
        expect(await readDinnerConsumptionOutbox(source, () => {})).toEqual([committed.outbox]);
        expect(await readDinnerConsumptionOutbox(target)).toEqual([]);
        if (database) {
          expect(await db.readQueueValues(source)).toEqual([mutation]);
          expect(await readSyncCursor(source)).toBe(17);
          expect(await readSyncCursor(target)).toBe(23);
        }
        await waitForScopedWrites(source);
        await waitForScopedWrites(target);
        if (database) await db.writeKeyValue(pantryDatabaseKeyForScope(target), valid);
        window.localStorage.setItem(key, valid);
      }
      await perform();
      expect(await readDinnerConsumptionOutbox(source, () => {})).toEqual([]);
      expect(await readDinnerConsumptionOutbox(target)).toEqual([]);
      if (database) {
        expect(await db.readQueueValues(source)).toEqual([]);
        expect(await readSyncCursor(source)).toBe(17);
        expect(await readSyncCursor(target)).toBe(23);
      }
      // Source pantry is neither read, rewritten nor cleaned during migration.
      if (side === 'source') {
        expect(window.localStorage.getItem(key)).toBe(raw);
        if (database) expect(await db.readKeyValue(pantryDatabaseKeyForScope(source))).toBe(raw);
      }
    });
  });
}

for (const operation of ['commit', 'reconcile'] as const) {
  it.each(corruptSnapshots)(`${operation} succeeds with valid primary but preserves $name mirror`, async ({ lots }) => {
    await db.writeKeyValue('pantry', valid);
    const committed = operation === 'reconcile' ? await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event }) : null;
    const raw = corruptRaw(lots);
    window.localStorage.setItem('ikuck-pantry-v1', raw);
    if (committed) await reconcileDinnerConsumption({ operationId: command('guest').operationId, originalScope: 'guest', canonicalScope: 'guest', assertContext: () => {}, result: { entry, cookEvent: event, receipt: committed.receipt, pantrySnapshot: committed.pantrySnapshot } });
    else await commitDinnerConsumption({ command: command('guest'), entry, cookEvent: event });
    expect(window.localStorage.getItem('ikuck-pantry-v1')).toBe(raw);
    expect(await readDinnerConsumptionOutbox('guest')).toHaveLength(committed ? 0 : 1);
  });
}
