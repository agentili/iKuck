import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanCommand, PlanState } from '@ikuck/shared/contracts';
import { closeLocalDatabase, deleteLocalDatabase, openLocalDatabase } from '../storage/indexedDb';
import { scopeStorageKey } from '../sync/scopeContext';
import {
  clearMealPlanSnapshot,
  commitMealPlanCommand,
  createLocalPlanState,
  enqueueMealPlanCommand,
  readMealPlanOutbox,
  readMealPlanSnapshot,
  saveGuestPlanState,
  saveMealPlanRead,
  readMealPlanBootstrap,
  applyMealPlanSyncPage,
  activateMealPlanBootstrap,
  createMealPlanCapabilityFingerprint,
  saveMealPlanBootstrapPage,
} from './storage';

const state: PlanState = {
  date: '2026-10-29', revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 1,
  kind: 'manual', recipeId: 'pollo-al-limone',
};
const command: PlanCommand = {
  version: 2, scope: 'house:house-1', date: state.date, operationId: 'operation-1', deviceId: 'device-1',
  clientUpdatedAt: '2026-10-28T12:00:00.000Z', action: 'manual_set', recipeId: 'pollo-al-limone',
};

beforeEach(async () => {
  await deleteLocalDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('meal plan IndexedDB persistence', () => {
  it('rejects a boolean guard hidden behind a void type without modifying the guest snapshot', async () => {
    const booleanGuard: () => void = () => false;
    await expect(saveGuestPlanState(state, {}, booleanGuard)).rejects.toThrow(/guard.*assert/i);
    expect((await readMealPlanSnapshot('guest')).states).toEqual({});
  });

  it('aborts a stale auto-enqueue after the queue put while retaining an earlier committed command', async () => {
    const prior = { ...command, operationId: 'committed' };
    await enqueueMealPlanCommand('house:house-1', prior);
    const before = await readMealPlanSnapshot('house:house-1');
    let current = true;
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args);
      if (this.name === 'syncQueue' && (args[0] as { mutationId?: string }).mutationId === 'stale') {
        request.addEventListener('success', () => { current = false; }, { once: true });
      }
      return request;
    });
    const hiddenPredicate: () => void = () => current ? undefined : false;
    try {
      const stale: PlanCommand = { ...command, operationId: 'stale', action: 'auto_create', baseRevision: null };
      await expect(enqueueMealPlanCommand('house:house-1', stale, {}, hiddenPredicate))
        .rejects.toThrow(/guard.*assert/i);
    } finally {
      put.mockRestore();
    }
    expect(await readMealPlanOutbox(['house:house-1'])).toMatchObject([{ mutationId: 'committed' }]);
    expect(await readMealPlanSnapshot('house:house-1')).toEqual(before);
  });

  it('aborts legacy queue migration when a hidden boolean guard becomes false', async () => {
    const db = await openLocalDatabase();
    const legacy = { mutationId: 'legacy', entityType: 'other' };
    await db.put('syncQueue', legacy);
    let current = true;
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args);
      if (this.name === 'syncQueue' && (args[0] as { mutationId?: string }).mutationId === 'legacy') {
        request.addEventListener('success', () => { current = false; }, { once: true });
      }
      return request;
    });
    const hiddenPredicate: () => void = () => current ? undefined : false;
    try {
      await expect(readMealPlanOutbox(['guest'], hiddenPredicate)).rejects.toThrow(/guard.*assert/i);
    } finally {
      put.mockRestore();
    }
    expect(await db.get('syncQueue', 'legacy')).toEqual(legacy);
  });

  it('purges historical staging with the revoked scope so a re-added member starts at zero', async () => {
    const scope = 'house:house-1';
    const fingerprint = createMealPlanCapabilityFingerprint({ version: 2, syncReadVersion: 2 });
    await saveMealPlanRead(scope, [state.date], [{ date: state.date, state }]);
    await saveMealPlanBootstrapPage(scope, fingerprint, 0, { changes: [{ state, serverSequence: 1 }], nextCursor: 1 });
    await saveGuestPlanState(createLocalPlanState(state.date, 'manual', 'guest-choice'));

    await clearMealPlanSnapshot(scope);

    expect(await readMealPlanBootstrap(scope, fingerprint)).toMatchObject({ cursor: 0, states: {} });
    expect(Object.keys((await readMealPlanSnapshot(scope)).states)).toHaveLength(0);
    expect(Object.keys((await readMealPlanSnapshot('guest')).states)).toHaveLength(1);
  });

  it('keeps guest, account and house snapshots isolated', async () => {
    await saveGuestPlanState(state);
    await saveMealPlanRead('account:user-1', [state.date], [{ date: state.date, state }]);
    await saveMealPlanRead('house:house-1', [state.date], [{ date: state.date, state: null }]);

    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [state.date]: { recipeId: state.recipeId } } });
    await expect(readMealPlanSnapshot('account:user-1')).resolves.toMatchObject({ states: { [state.date]: { recipeId: state.recipeId } } });
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({ states: {}, observedDates: [state.date] });
  });

  it('aborts a guest write when its action fence changes during the IndexedDB transaction read', async () => {
    let current = true;
    const originalGet = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalGet.call(this, key);
      if (this.transaction.mode === 'readwrite' && key === scopeStorageKey('guest', 'meal-plan-v2')) {
        request.addEventListener('success', () => { current = false; });
      }
      return request;
    });

    await expect(saveGuestPlanState(state, {}, () => {
      if (!current) throw new Error('action is no longer current');
    })).rejects.toThrow('action is no longer current');
    get.mockRestore();

    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: {} });
  });

  it('aborts an outbox read when its session fence changes during an IndexedDB queue read', async () => {
    let current = true;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalGetAll.apply(this, args);
      if (this.name === 'syncQueue' && this.transaction.mode === 'readwrite') {
        request.addEventListener('success', () => { current = false; });
      }
      return request;
    });

    try {
      await expect(readMealPlanOutbox(['house:house-1'], () => {
        if (!current) throw new Error('action is no longer current');
      })).rejects.toThrow('action is no longer current');
    } finally {
      getAll.mockRestore();
    }
  });

  it('persists a command to the scoped outbox and commits its server result with queue acknowledgement', async () => {
    const remoteCommand: PlanCommand = { ...command, operationId: 'operation-2' };
    await enqueueMealPlanCommand('house:house-1', remoteCommand);

    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toHaveLength(1);
    await commitMealPlanCommand('house:house-1', 'house:house-1', remoteCommand, {
      version: 2, operationId: remoteCommand.operationId, outcome: 'applied', current: state,
    }, state);

    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toEqual([]);
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({ states: { [state.date]: state } });
  });

  it('preserves local enqueue order across equal timestamps and a database reload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
    const firstCreated: PlanCommand = { ...command, operationId: 'z-first-created', recipeId: 'first-recipe' };
    const secondCreated: PlanCommand = { ...command, operationId: 'a-second-created', recipeId: 'second-recipe' };
    await enqueueMealPlanCommand('house:house-1', firstCreated, {
      optimisticState: createLocalPlanState(state.date, 'manual', 'first-recipe'),
    });
    await enqueueMealPlanCommand('house:house-1', secondCreated, {
      optimisticState: createLocalPlanState(state.date, 'manual', 'second-recipe'),
    });

    await closeLocalDatabase();

    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toMatchObject([
      { mutationId: firstCreated.operationId },
      { mutationId: secondCreated.operationId },
    ]);
  });

  it('rebuilds the date overlay from the later pending command after acknowledging the first', async () => {
    const firstCommand: PlanCommand = { ...command, operationId: 'first-for-date', recipeId: 'first-recipe' };
    const secondCommand: PlanCommand = { ...command, operationId: 'second-for-date', recipeId: 'second-recipe' };
    const firstOptimistic = createLocalPlanState(state.date, 'manual', 'first-recipe');
    const secondOptimistic = createLocalPlanState(state.date, 'manual', 'second-recipe');
    const firstConfirmed: PlanState = { ...firstOptimistic, serverSequence: 3 };
    await enqueueMealPlanCommand('house:house-1', firstCommand, { optimisticState: firstOptimistic });
    await enqueueMealPlanCommand('house:house-1', secondCommand, { optimisticState: secondOptimistic });

    await commitMealPlanCommand('house:house-1', 'house:house-1', firstCommand, {
      version: 2, operationId: firstCommand.operationId, outcome: 'applied', current: firstConfirmed,
    }, firstConfirmed);

    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({
      states: { [state.date]: firstConfirmed },
      overlays: { [state.date]: secondOptimistic },
    });
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toMatchObject([
      { mutationId: secondCommand.operationId, optimisticState: secondOptimistic },
    ]);
  });

  it('clears a resolved conflict only after a matching applied receipt and persists that receipt atomically', async () => {
    const originalCommand: PlanCommand = { ...command, operationId: 'original-conflict', recipeId: 'retry-recipe' };
    await enqueueMealPlanCommand('house:house-1', originalCommand);
    await commitMealPlanCommand('house:house-1', 'house:house-1', originalCommand, {
      version: 2, operationId: originalCommand.operationId, outcome: 'conflict', current: state,
    }, state);
    const retryCommand: PlanCommand = { ...originalCommand, operationId: 'retry-operation' };
    const retryOptimistic = createLocalPlanState(state.date, 'manual', 'retry-recipe');
    await enqueueMealPlanCommand('house:house-1', retryCommand, {
      optimisticState: retryOptimistic,
      resolvesConflictId: originalCommand.operationId,
    });
    const applied: PlanState = {
      ...state,
      revision: '323e4567-e89b-42d3-a456-426614174003',
      serverSequence: 2,
      recipeId: 'retry-recipe',
    };
    const receipt = { version: 2 as const, operationId: retryCommand.operationId, outcome: 'applied' as const, current: applied };
    const inconsistentRead = { ...applied, revision: '423e4567-e89b-42d3-a456-426614174004', recipeId: 'different-choice' };

    await expect(commitMealPlanCommand('house:house-1', 'house:house-1', retryCommand, receipt, inconsistentRead, {
      resolvesConflictId: originalCommand.operationId,
    })).rejects.toThrow(/lettura.*non conferma/i);
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({
      conflicts: [expect.objectContaining({ id: originalCommand.operationId })],
      overlays: { [state.date]: retryOptimistic },
    });
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toMatchObject([
      { mutationId: retryCommand.operationId, resolvesConflictId: originalCommand.operationId },
    ]);

    await commitMealPlanCommand('house:house-1', 'house:house-1', retryCommand, receipt, applied, {
      resolvesConflictId: originalCommand.operationId,
    });
    await closeLocalDatabase();

    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({
      conflicts: [],
      overlays: {},
      receipts: { [retryCommand.operationId]: receipt },
    });
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toEqual([]);
  });

  it('aborts receipt, state, conflict and queue acknowledgement together when the scope fence changes', async () => {
    const originalCommand: PlanCommand = { ...command, operationId: 'atomic-original-conflict', recipeId: 'retry-recipe' };
    await enqueueMealPlanCommand('house:house-1', originalCommand);
    await commitMealPlanCommand('house:house-1', 'house:house-1', originalCommand, {
      version: 2, operationId: originalCommand.operationId, outcome: 'conflict', current: state,
    }, state);
    const retryCommand: PlanCommand = { ...originalCommand, operationId: 'atomic-retry' };
    const optimistic = createLocalPlanState(state.date, 'manual', 'retry-recipe');
    await enqueueMealPlanCommand('house:house-1', retryCommand, {
      optimisticState: optimistic,
      resolvesConflictId: originalCommand.operationId,
    });
    const applied: PlanState = {
      ...state, revision: '323e4567-e89b-42d3-a456-426614174003', serverSequence: 2, recipeId: 'retry-recipe',
    };
    let current = true;
    const originalDelete = IDBObjectStore.prototype.delete;
    const deleteRequest = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalDelete.call(this, key);
      if (this.name === 'syncQueue' && this.transaction.mode === 'readwrite') {
        request.addEventListener('success', () => { current = false; }, { once: true });
      }
      return request;
    });

    try {
      await expect(commitMealPlanCommand('house:house-1', 'house:house-1', retryCommand, {
        version: 2, operationId: retryCommand.operationId, outcome: 'applied', current: applied,
      }, applied, {
        resolvesConflictId: originalCommand.operationId,
        assertCurrent: () => { if (!current) throw new Error('scope changed during acknowledgement'); },
      })).rejects.toThrow('scope changed during acknowledgement');
    } finally {
      deleteRequest.mockRestore();
    }

    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({
      states: { [state.date]: state },
      overlays: { [state.date]: optimistic },
      conflicts: [expect.objectContaining({ id: originalCommand.operationId })],
      receipts: {},
    });
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toMatchObject([
      { mutationId: retryCommand.operationId, resolvesConflictId: originalCommand.operationId },
    ]);
  });

  it('removes only the exact imported guest revision after the house command is acknowledged', async () => {
    const guestChoice = createLocalPlanState(state.date, 'manual', state.recipeId);
    await saveGuestPlanState(guestChoice);
    const houseCommand: PlanCommand = { ...command, operationId: 'operation-import' };
    await enqueueMealPlanCommand('house:house-1', houseCommand, {
      sourceScope: 'guest', sourceRevision: guestChoice.revision,
    });

    await commitMealPlanCommand('house:house-1', 'house:house-1', houseCommand, {
      version: 2, operationId: houseCommand.operationId, outcome: 'applied', current: state,
    }, state, {
      source: { scope: 'guest', date: state.date, revision: guestChoice.revision, receiptState: state },
    });

    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: {} });
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({ states: { [state.date]: state } });
    await expect(readMealPlanOutbox(['house:house-1'])).resolves.toEqual([]);
  });

  it('keeps a guest source on a server conflict instead of deleting an unshared choice', async () => {
    const guestChoice = createLocalPlanState(state.date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(guestChoice);
    const houseCommand: PlanCommand = { ...command, operationId: 'operation-conflict', recipeId: 'pollo-al-limone' };
    await enqueueMealPlanCommand('house:house-1', houseCommand, {
      sourceScope: 'guest', sourceRevision: guestChoice.revision,
    });

    await commitMealPlanCommand('house:house-1', 'house:house-1', houseCommand, {
      version: 2, operationId: houseCommand.operationId, outcome: 'conflict', current: state,
    }, state, {
      source: { scope: 'guest', date: state.date, revision: guestChoice.revision, receiptState: state },
    });

    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [state.date]: guestChoice } });
    await expect(readMealPlanSnapshot('house:house-1')).resolves.toMatchObject({ conflicts: [expect.objectContaining({ id: houseCommand.operationId })] });
  });

  it('stages the full history non-destructively and atomically activates it without dropping overlays or outbox', async () => {
    const scope = 'house:house-1';
    const capability = { version: 2 as const, syncReadVersion: 2 as const };
    const fingerprint = createMealPlanCapabilityFingerprint(capability);
    const historic: PlanState = {
      date: '2020-01-01', revision: '123e4567-e89b-42d3-a456-426614174001', serverSequence: 7,
      kind: 'deleted', recipeId: null,
    };
    const optimistic = createLocalPlanState('2026-10-30', 'manual', 'pasta-e-ceci');
    const pending: PlanCommand = { ...command, date: optimistic.date, operationId: 'pending-bootstrap-preserved' };
    await saveMealPlanRead(scope, [state.date], [{ date: state.date, state }]);
    await enqueueMealPlanCommand(scope, pending, { optimisticState: optimistic });

    await saveMealPlanBootstrapPage(scope, fingerprint, 0, {
      changes: [{ state: historic, serverSequence: historic.serverSequence }], nextCursor: historic.serverSequence,
    });
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({ states: { [state.date]: state }, bootstrap: null });
    await expect(readMealPlanBootstrap(scope, fingerprint)).resolves.toMatchObject({ cursor: 7, states: { '2020-01-01': historic } });

    await activateMealPlanBootstrap(scope, fingerprint);

    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({
      states: { '2020-01-01': historic },
      overlays: { [optimistic.date]: optimistic },
      observedDates: ['2020-01-01'],
      bootstrap: { version: 2, capabilityFingerprint: fingerprint, cursor: 7 },
    });
    await expect(readMealPlanOutbox([scope])).resolves.toHaveLength(1);
    await expect(readMealPlanBootstrap(scope, fingerprint)).resolves.toMatchObject({ cursor: 0, states: {} });
  });

  it('commits an incremental plan page and its cursor together without replacing a newer state', async () => {
    const scope = 'account:user-1';
    const capability = { version: 2 as const, syncReadVersion: 2 as const };
    const fingerprint = createMealPlanCapabilityFingerprint(capability);
    const first: PlanState = { ...state, date: '2020-01-01', serverSequence: 7 };
    const newer: PlanState = { ...first, revision: '123e4567-e89b-42d3-a456-426614174002', serverSequence: 11, recipeId: 'recipe-new' };
    await saveMealPlanBootstrapPage(scope, fingerprint, 0, { changes: [{ state: first, serverSequence: 7 }], nextCursor: 7 });
    await activateMealPlanBootstrap(scope, fingerprint);

    await applyMealPlanSyncPage(scope, fingerprint, 7, {
      changes: [{ state: newer, serverSequence: 11 }], nextCursor: 11,
    });

    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({
      states: { '2020-01-01': newer },
      bootstrap: { version: 2, capabilityFingerprint: fingerprint, cursor: 11 },
    });
    await expect(applyMealPlanSyncPage(scope, fingerprint, 7, { changes: [], nextCursor: 7 }))
      .rejects.toThrow(/cursore.*cambiato/i);
  });

  it('does not regress a confirmed state received while the historical staging scan was in flight', async () => {
    const scope = 'house:house-1';
    const fingerprint = createMealPlanCapabilityFingerprint({ version: 2, syncReadVersion: 2 });
    const newer: PlanState = { ...state, revision: crypto.randomUUID(), serverSequence: 10, recipeId: 'newer-choice' };
    await saveMealPlanBootstrapPage(scope, fingerprint, 0, {
      changes: [{ state, serverSequence: state.serverSequence }], nextCursor: state.serverSequence,
    });
    await saveMealPlanRead(scope, [state.date], [{ date: state.date, state: newer }]);

    await activateMealPlanBootstrap(scope, fingerprint);

    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({
      states: { [state.date]: newer }, bootstrap: { cursor: state.serverSequence },
    });
  });
});
