import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { CookEvent } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { setActiveDataScope, scopeStorageKey } from '../sync/scopeContext';
import { resumeScope, revokeScope } from '../sync/scopeWriteFence';
import { closeLocalDatabase, deleteLocalDatabase, deleteQueueScope, DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX, LOCAL_STORAGE_JOURNAL_KEY, readQueueValues } from './indexedDb';
import * as indexedDb from './indexedDb';
import { dinnerEntriesStorageKeyForScope, readDinnerEntries, serializeDinnerEntriesSnapshot, writeDinnerEntries } from './dinnerDiaryStorage';
import { pantryStorageKeyForScope, readPantrySnapshot, serializePantrySnapshot, writePantrySnapshot } from './pantryStorage';
import { readCookEvents } from './activityStorage';
import {
  acknowledgeDinnerConsumption,
  commitDinnerConsumption,
  readDinnerConsumptionOutbox,
  readDinnerConsumptionReceipt,
} from './dinnerConsumptionStorage';

const timestamp = '2026-10-07T09:00:00.000Z';
const entry: DinnerEntry = {
  id: 'dinner-1', date: '2026-10-07', text: 'Pasta e pomodoro', servings: 2,
  note: null, recipes: [], authorId: null, createdAt: timestamp, updatedAt: timestamp,
};
const event: CookEvent = {
  id: entry.id, recipeId: 'recipe-1', recipeTitle: 'Pasta e pomodoro', servings: 2,
  cookedAt: timestamp, note: null, createdAt: timestamp, updatedAt: timestamp,
};
const command: DinnerConsumptionCommand = {
  operationId: 'consume-op-1', entryId: entry.id, scope: 'guest', servings: 2,
  ingredients: [
    { ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true },
    { ingredientId: 'tomato', name: 'Pomodoro', amount: 'q.b.', optional: false, used: true },
  ],
};

const lot = (id: string, ingredientId: string, quantity: number | null, unit: 'g' | null) => ({
  id, ingredientId, label: ingredientId, known: true, quantity, unit, expiresAt: null,
  createdAt: timestamp, updatedAt: timestamp,
});

describe('dinner consumption storage', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    window.localStorage.clear();
    setActiveDataScope('guest');
    resumeScope('guest');
  });

  it('atomically commits the dinner, residual pantry, receipt, and durable outbox', async () => {
    const existingEntry: DinnerEntry = { ...entry, id: 'older-dinner', text: 'Riso' };
    await writeDinnerEntries([existingEntry], 'guest');
    await writePantrySnapshot({
      pantryItems: [], stapleIds: ['salt'],
      pantryLots: [lot('pasta-lot', 'pasta', 500, 'g'), lot('tomato-presence', 'tomato', null, null), lot('rice-lot', 'rice', 250, 'g')],
    }, 'guest');

    const result = await commitDinnerConsumption({ command, entry, updatedAt: timestamp });

    expect(result).toMatchObject({
      duplicate: false,
      entry,
      pantrySnapshot: {
        pantryItems: [expect.objectContaining({ id: 'pasta' }), expect.objectContaining({ id: 'rice' })],
        stapleIds: ['salt'],
        pantryLots: [
          expect.objectContaining({ id: 'pasta-lot', quantity: 300, unit: 'g' }),
          expect.objectContaining({ id: 'rice-lot', quantity: 250, unit: 'g' }),
        ],
      },
      receipt: expect.objectContaining({ operationId: command.operationId, entryId: entry.id, scope: 'guest' }),
      outbox: expect.objectContaining({ operationId: command.operationId, entryId: entry.id, scope: 'guest', status: 'pending', command }),
    });
    await expect(readDinnerEntries('guest')).resolves.toEqual([existingEntry, entry]);
    await expect(readPantrySnapshot('guest')).resolves.toMatchObject({
      pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 300 }), expect.objectContaining({ id: 'rice-lot', quantity: 250 })],
      stapleIds: ['salt'],
    });
    await expect(readDinnerConsumptionReceipt(command.operationId)).resolves.toEqual(result.receipt);
    await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([result.outbox]);
    await expect(readQueueValues('guest')).resolves.toEqual([]);
  });

  it('commits cook-event history with pantry, diary, and outbox in one fallback journal', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    try {
      await writePantrySnapshot({ pantryItems: [], stapleIds: ['salt'], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] }, 'guest');

      const first = await commitDinnerConsumption({ command, entry, cookEvent: event, updatedAt: timestamp });
      const retry = await commitDinnerConsumption({ command, entry, cookEvent: event, updatedAt: timestamp });

      expect(first.duplicate).toBe(false);
      expect(retry.duplicate).toBe(true);
      await expect(readCookEvents('guest')).resolves.toEqual([event]);
      await expect(readDinnerEntries('guest')).resolves.toEqual([entry]);
      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 300 })] });
      await expect(readDinnerConsumptionOutbox('guest')).resolves.toMatchObject([{ cookEvent: event, command }]);
      expect(window.localStorage.getItem(LOCAL_STORAGE_JOURNAL_KEY)).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });

  it('preserves cached pantry data when the IndexedDB connection cannot be opened', async () => {
    const pantry = { pantryItems: [], stapleIds: [], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] };
    await writePantrySnapshot(pantry, 'guest');
    const pantryKey = pantryStorageKeyForScope('guest');
    const mirrorBefore = window.localStorage.getItem(pantryKey);
    const failure = new Error('IndexedDB unavailable for this transaction');
    const open = vi.spyOn(indexedDb, 'openLocalDatabase').mockRejectedValueOnce(failure);

    try {
      await expect(commitDinnerConsumption({ command, entry, updatedAt: timestamp })).rejects.toThrow(failure);
      expect(window.localStorage.getItem(pantryKey)).toBe(mirrorBefore);
    } finally {
      open.mockRestore();
    }
  });

  it('applies a retried operation once after reopening the local database', async () => {
    await writePantrySnapshot({
      pantryItems: [], stapleIds: [], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')],
    }, 'guest');
    const first = await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
    await closeLocalDatabase();

    const retry = await commitDinnerConsumption({ command, entry, updatedAt: timestamp });

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    await expect(readPantrySnapshot('guest')).resolves.toMatchObject({
      pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 300 })],
    });
    await expect(readDinnerEntries('guest')).resolves.toEqual([entry]);
    await expect(readDinnerConsumptionOutbox('guest')).resolves.toHaveLength(1);
  });

  it('rejects a new operation ID for an already-consumed dinner entry', async () => {
    await writePantrySnapshot({ pantryItems: [], stapleIds: [], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] }, 'guest');
    await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
    const secondCommand: DinnerConsumptionCommand = { ...command, operationId: 'consume-op-duplicate-entry' };

    await expect(commitDinnerConsumption({ command: secondCommand, entry, updatedAt: timestamp })).rejects.toMatchObject({ code: 'dinner_consumption_conflict' });

    await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 300 })] });
    await expect(readDinnerConsumptionOutbox('guest')).resolves.toHaveLength(1);
    await expect(readDinnerConsumptionReceipt(secondCommand.operationId, 'guest')).resolves.toBeNull();
  });

  it('rejects a consumption command whose servings differ from the committed dinner', async () => {
    const mismatchedEntry: DinnerEntry = { ...entry, id: 'dinner-mismatched-servings', servings: 1 };
    const mismatchedCommand: DinnerConsumptionCommand = {
      ...command, operationId: 'consume-op-mismatched-servings', entryId: mismatchedEntry.id, servings: 2,
    };
    await writePantrySnapshot({ pantryItems: [], stapleIds: [], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] }, 'guest');

    await expect(commitDinnerConsumption({ command: mismatchedCommand, entry: mismatchedEntry, updatedAt: timestamp }))
      .rejects.toMatchObject({ code: 'dinner_consumption_conflict' });

    await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 500 })] });
    await expect(readDinnerEntries('guest')).resolves.toEqual([]);
    await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([]);
  });

  it('removes a lot when the confirmed quantity exactly exhausts it', async () => {
    const exactEntry: DinnerEntry = { ...entry, id: 'dinner-exact', text: 'Pasta' };
    const exactCommand: DinnerConsumptionCommand = {
      ...command, operationId: 'consume-op-exact', entryId: exactEntry.id,
      ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '250 g', optional: false, used: true }],
    };
    await writePantrySnapshot({ pantryItems: [], stapleIds: [], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] }, 'guest');

    const result = await commitDinnerConsumption({ command: exactCommand, entry: exactEntry, updatedAt: timestamp });

    expect(result.plan.deleteLotIds).toEqual(['pasta-lot']);
    expect(result.plan.missingIngredients).toEqual([]);
    expect(result.pantrySnapshot.pantryLots).toEqual([]);
    expect(result.pantrySnapshot.pantryItems).toEqual([]);
  });

  it('acknowledges a fallback outbox record recovered from a committed journal', async () => {
    const result = await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    const recordKey = scopeStorageKey('guest', `${DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX}${encodeURIComponent(command.operationId)}`);
    const before = { [recordKey]: null };
    const after = { [recordKey]: JSON.stringify(result.outbox) };
    window.localStorage.setItem(LOCAL_STORAGE_JOURNAL_KEY, JSON.stringify({ version: 1, state: 'committed', before, after }));

    try {
      await acknowledgeDinnerConsumption(command.operationId, 'guest');

      await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([]);
      await expect(readDinnerConsumptionReceipt(command.operationId)).resolves.toEqual(result.receipt);
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });

  it('commits the receipt as an acknowledged idempotency record', async () => {
    const result = await commitDinnerConsumption({ command, entry, updatedAt: timestamp });

    await acknowledgeDinnerConsumption(command.operationId, 'guest');

    await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([]);
    await expect(readDinnerConsumptionReceipt(command.operationId)).resolves.toEqual(result.receipt);
    await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [] });
  });

  it('removes only exhausted lots and reports a partial deficit without negative stock', async () => {
    const partialEntry: DinnerEntry = { ...entry, id: 'dinner-short', text: 'Farina' };
    const partialCommand: DinnerConsumptionCommand = {
      ...command, operationId: 'consume-op-short', entryId: partialEntry.id,
      ingredients: [{ ingredientId: 'flour', name: 'Farina', amount: '100 g', optional: false, used: true }],
    };
    await writePantrySnapshot({ pantryItems: [], stapleIds: [], pantryLots: [lot('flour-lot', 'flour', 50, 'g')] }, 'guest');

    const result = await commitDinnerConsumption({ command: partialCommand, entry: partialEntry, updatedAt: timestamp });

    expect(result.plan.deleteLotIds).toEqual(['flour-lot']);
    expect(result.plan.missingIngredients).toMatchObject([{ ingredientId: 'flour', requiredQuantity: 200, deficit: 150, unit: 'g' }]);
    expect(result.pantrySnapshot.pantryLots).toEqual([]);
    expect(result.pantrySnapshot.pantryItems).toEqual([]);
  });

  it('removes dinner receipts and pending commands when their scope is purged', async () => {
    await commitDinnerConsumption({ command, entry, updatedAt: timestamp });

    await deleteQueueScope('guest');

    await expect(readDinnerConsumptionReceipt(command.operationId, 'guest')).resolves.toBeNull();
    await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([]);
  });

  it('purges localStorage outbox records even when IndexedDB is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    try {
      await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
      await expect(readDinnerConsumptionOutbox('guest')).resolves.toHaveLength(1);

      await deleteQueueScope('guest');

      await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([]);
      await expect(readDinnerConsumptionReceipt(command.operationId, 'guest')).resolves.toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });

  it('rejects a commit after its scope has been revoked', async () => {
    revokeScope('guest');

    await expect(commitDinnerConsumption({ command, entry, updatedAt: timestamp })).rejects.toMatchObject({ code: 'scope_revoked' });
    await expect(readDinnerEntries('guest')).resolves.toEqual([]);
    await expect(readPantrySnapshot('guest')).resolves.toBeNull();
    await expect(readDinnerConsumptionReceipt(command.operationId, 'guest')).rejects.toMatchObject({ code: 'scope_revoked' });
  });

  it('recovers an interrupted localStorage transaction to its before-image', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    try {
      const oldPantry = { pantryItems: [], stapleIds: ['salt'], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] };
      const nextPantry = { ...oldPantry, pantryLots: [lot('pasta-lot', 'pasta', 300, 'g')] };
      const pantryKey = pantryStorageKeyForScope('guest');
      const entriesKey = dinnerEntriesStorageKeyForScope('guest');
      const recordKey = scopeStorageKey('guest', `${DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX}crash-op`);
      const before = { [pantryKey]: serializePantrySnapshot(oldPantry), [entriesKey]: serializeDinnerEntriesSnapshot([]), [recordKey]: null };
      const after = { [pantryKey]: serializePantrySnapshot(nextPantry), [entriesKey]: serializeDinnerEntriesSnapshot([entry]), [recordKey]: JSON.stringify({ operationId: 'crash-op' }) };
      window.localStorage.setItem(pantryKey, before[pantryKey]!);
      window.localStorage.setItem(entriesKey, before[entriesKey]!);
      window.localStorage.setItem(LOCAL_STORAGE_JOURNAL_KEY, JSON.stringify({ version: 1, state: 'prepared', before, after }));
      window.localStorage.setItem(pantryKey, after[pantryKey]!);
      window.localStorage.setItem(entriesKey, after[entriesKey]!);

      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 500 })] });
      await expect(readDinnerEntries('guest')).resolves.toEqual([]);
      expect(window.localStorage.getItem(recordKey)).toBeNull();
      expect(window.localStorage.getItem(LOCAL_STORAGE_JOURNAL_KEY)).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });

  it('finishes a committed localStorage journal after an interrupted mirror write', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    try {
      const pantryKey = pantryStorageKeyForScope('guest');
      const entriesKey = dinnerEntriesStorageKeyForScope('guest');
      const recordKey = scopeStorageKey('guest', `${DINNER_CONSUMPTION_RECORD_STORAGE_PREFIX}committed-op`);
      const before = { [pantryKey]: serializePantrySnapshot({ pantryItems: [], stapleIds: [] }), [entriesKey]: null, [recordKey]: null };
      const after = {
        [pantryKey]: serializePantrySnapshot({ pantryItems: [], stapleIds: [], pantryLots: [lot('pasta-lot', 'pasta', 300, 'g')] }),
        [entriesKey]: serializeDinnerEntriesSnapshot([entry]),
        [recordKey]: JSON.stringify({ operationId: 'committed-op' }),
      };
      window.localStorage.setItem(LOCAL_STORAGE_JOURNAL_KEY, JSON.stringify({ version: 1, state: 'committed', before, after }));
      window.localStorage.setItem(pantryKey, after[pantryKey]!);

      await expect(readDinnerEntries('guest')).resolves.toEqual([entry]);
      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 300 })] });
      expect(window.localStorage.getItem(recordKey)).toBe(after[recordKey]);
      expect(window.localStorage.getItem(LOCAL_STORAGE_JOURNAL_KEY)).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });

  it('commits the fallback snapshots and outbox through one recoverable journal', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    const olderEntry: DinnerEntry = { ...entry, id: 'older-dinner', text: 'Riso' };
    try {
      await writePantrySnapshot({ pantryItems: [], stapleIds: ['salt'], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] }, 'guest');
      await writeDinnerEntries([olderEntry], 'guest');

      const result = await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
      const retry = await commitDinnerConsumption({ command, entry, updatedAt: timestamp });

      expect(result.duplicate).toBe(false);
      expect(retry.duplicate).toBe(true);
      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 300 })] });
      await expect(readDinnerEntries('guest')).resolves.toEqual([olderEntry, entry]);
      await expect(readDinnerConsumptionOutbox('guest')).resolves.toHaveLength(1);
      expect(window.localStorage.getItem(LOCAL_STORAGE_JOURNAL_KEY)).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });

  it('rolls back all fallback values when a localStorage quota error interrupts the journal', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    const olderEntry: DinnerEntry = { ...entry, id: 'older-dinner', text: 'Riso' };
    const originalSetItem = Storage.prototype.setItem;
    let injected = false;
    let shouldInject = false;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (shouldInject && !injected && this === window.localStorage && key === dinnerEntriesStorageKeyForScope('guest')) {
        injected = true;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });
    try {
      await writePantrySnapshot({ pantryItems: [], stapleIds: ['salt'], pantryLots: [lot('pasta-lot', 'pasta', 500, 'g')] }, 'guest');
      await writeDinnerEntries([olderEntry], 'guest');
      shouldInject = true;

      await expect(commitDinnerConsumption({ command, entry, updatedAt: timestamp })).rejects.toMatchObject({ name: 'QuotaExceededError' });

      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: 'pasta-lot', quantity: 500 })], stapleIds: ['salt'] });
      await expect(readDinnerEntries('guest')).resolves.toEqual([olderEntry]);
      await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([]);
      expect(window.localStorage.getItem(LOCAL_STORAGE_JOURNAL_KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    }
  });

  it('rejects reading a pending command after the active scope has changed', async () => {
    await writePantrySnapshot({ pantryItems: [], stapleIds: [] }, 'guest');
    await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
    setActiveDataScope('account:another-user');

    await expect(readDinnerConsumptionOutbox('guest')).rejects.toMatchObject({ code: 'scope_changed' });
  });

  it('discards a receipt read that finishes after the active scope changes', async () => {
    await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
    let releaseOpen: (() => void) | undefined;
    let signalOpen: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalOpen = resolve; });
    const paused = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const originalOpen = indexedDb.openLocalDatabase;
    const open = vi.spyOn(indexedDb, 'openLocalDatabase').mockImplementation(async () => {
      signalOpen?.();
      await paused;
      return originalOpen();
    });

    try {
      const reading = readDinnerConsumptionReceipt(command.operationId, 'guest');
      await started;
      setActiveDataScope('account:another-user');
      releaseOpen?.();
      await expect(reading).rejects.toMatchObject({ code: 'scope_changed' });
    } finally {
      releaseOpen?.();
      open.mockRestore();
    }
  });

  it('discards an outbox read that finishes after the active scope changes', async () => {
    await commitDinnerConsumption({ command, entry, updatedAt: timestamp });
    let releaseOpen: (() => void) | undefined;
    let signalOpen: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalOpen = resolve; });
    const paused = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const originalOpen = indexedDb.openLocalDatabase;
    const open = vi.spyOn(indexedDb, 'openLocalDatabase').mockImplementation(async () => {
      signalOpen?.();
      await paused;
      return originalOpen();
    });

    try {
      const reading = readDinnerConsumptionOutbox('guest');
      await started;
      setActiveDataScope('account:another-user');
      releaseOpen?.();
      await expect(reading).rejects.toMatchObject({ code: 'scope_changed' });
    } finally {
      releaseOpen?.();
      open.mockRestore();
    }
  });
});
