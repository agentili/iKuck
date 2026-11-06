import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanState } from '@ikuck/shared/contracts';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { scopeStorageKey } from '../sync/scopeContext';
import type { MealPlanApi } from './api';
import { importGuestMealPlan } from './service';
import { createLocalPlanState, readMealPlanOutbox, readMealPlanSnapshot, saveGuestPlanState, saveMealPlanRead } from './storage';

const date = '2026-11-03';
const scope = 'account:import-user' as const;
const originalTime = '2026-10-01T10:00:00.000Z';

function createImportApi() {
  const states = new Map<string, PlanState>();
  const api: MealPlanApi = {
    getCapabilities: vi.fn<MealPlanApi['getCapabilities']>(async () => ({ version: 2, syncReadVersion: 2 })),
    readSyncPage: vi.fn<MealPlanApi['readSyncPage']>(async (_scope, _device, cursor) => ({ changes: [], nextCursor: cursor })),
    readStates: vi.fn<MealPlanApi['readStates']>(async (_scope, dates) => dates.map((day) => ({ date: day, state: states.get(day) ?? null }))),
    sendCommand: vi.fn(),
    importCommands: vi.fn<MealPlanApi['importCommands']>(async (_scope, items) => ({
      version: 2,
      results: items.map((item) => {
        const current: PlanState = item.command.action === 'manual_delete'
          ? { date: item.command.date, revision: crypto.randomUUID(), serverSequence: 1, kind: 'deleted', recipeId: null }
          : { date: item.command.date, revision: crypto.randomUUID(), serverSequence: 1,
            kind: item.command.action === 'manual_set' ? 'manual' : 'automatic', recipeId: item.command.recipeId };
        states.set(current.date, current);
        return { sourceId: item.sourceId, localRevision: item.localRevision,
          result: { version: 2, operationId: item.command.operationId, outcome: 'applied', current } };
      }),
    })),
    getHouseTimeZone: vi.fn(),
    initializeHouseTimeZone: vi.fn(),
    updateHouseTimeZone: vi.fn(),
    readRecovery: vi.fn<MealPlanApi['readRecovery']>(async () => ({ version: 2, conflicts: [], quarantined: [] })),
    resolveRecovery: vi.fn<MealPlanApi['resolveRecovery']>(async () => ({ version: 2, operationId: crypto.randomUUID(), outcome: 'applied', current: null })),
  };
  return { api, states };
}

beforeEach(async () => {
  await deleteLocalDatabase();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(originalTime));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('guest plan import provenance', () => {
  it('aborts both overlay and command if the session changes during the final IndexedDB queue write', async () => {
    const guest = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(guest);
    const { api } = createImportApi();
    let current = true;
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      if (this.name === 'syncQueue') request.addEventListener('success', () => { current = false; });
      return request;
    });

    await expect(importGuestMealPlan({ scope, csrfToken: 'csrf', deviceId: 'device', api, assertCurrent: () => { if (!current) throw new Error("La sessione o la Casa è cambiata durante l'importazione del Piano."); } }))
      .rejects.toThrow(/sessione|Casa/i);
    put.mockRestore();

    expect(api.importCommands).not.toHaveBeenCalled();
    await expect(readMealPlanOutbox([scope])).resolves.toHaveLength(0);
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({ overlays: {} });
    expect(Object.keys((await readMealPlanSnapshot(scope)).overlays)).toHaveLength(0);
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [date]: guest } });
  });

  it('keeps the outbox and guest source when the session changes inside the acknowledgement transaction', async () => {
    const guest = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(guest);
    const { api } = createImportApi();
    let current = true;
    let acknowledging = false;
    const apply = vi.mocked(api.importCommands).getMockImplementation()!;
    vi.mocked(api.importCommands).mockImplementation(async (...args) => {
      const receipt = await apply(...args);
      acknowledging = true;
      return receipt;
    });
    const originalGet = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalGet.call(this, key);
      if (acknowledging && this.transaction.mode === 'readwrite' && key === scopeStorageKey(scope, 'meal-plan-v2')) {
        request.addEventListener('success', () => { current = false; });
      }
      return request;
    });

    await expect(importGuestMealPlan({ scope, csrfToken: 'csrf', deviceId: 'device', api, assertCurrent: () => { if (!current) throw new Error("La sessione o la Casa è cambiata durante l'importazione del Piano."); } }))
      .rejects.toThrow(/sessione|Casa/i);
    get.mockRestore();

    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [date]: guest } });
    await expect(readMealPlanOutbox([scope])).resolves.toHaveLength(1);
  });

  it('preserves an ambiguous guest origin instead of reclassifying an automatic action as manual', async () => {
    const ambiguous = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(ambiguous, { originalAction: 'auto_create' });
    const { api } = createImportApi();

    const result = await importGuestMealPlan({ scope, csrfToken: 'csrf', deviceId: 'device', api });

    expect(api.importCommands).not.toHaveBeenCalled();
    expect(result.preservedConflicts).toBe(1);
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [date]: ambiguous } });
  });

  it('imports only the guest revision captured at confirmation, not an edit made during bootstrap', async () => {
    const confirmed = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    const concurrent = createLocalPlanState(date, 'manual', 'newer-guest');
    await saveGuestPlanState(confirmed);
    const { api } = createImportApi();
    vi.mocked(api.getCapabilities).mockImplementationOnce(async () => {
      await saveGuestPlanState(concurrent);
      return { version: 2, syncReadVersion: 2 };
    });

    await importGuestMealPlan({ scope, csrfToken: 'csrf', deviceId: 'device', api });

    expect(api.importCommands).toHaveBeenCalledWith(scope, [expect.objectContaining({ localRevision: confirmed.revision,
      command: expect.objectContaining({ recipeId: confirmed.recipeId }) })], 'csrf');
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [date]: concurrent } });
  });

  it('retains the guest source when a newer confirmed snapshot wins while the acknowledgement is in flight', async () => {
    const guest = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(guest);
    const { api } = createImportApi();
    const apply = vi.mocked(api.importCommands).getMockImplementation()!;
    const newer: PlanState = { date, revision: crypto.randomUUID(), serverSequence: 5, kind: 'manual', recipeId: 'newer-choice' };
    vi.mocked(api.importCommands).mockImplementation(async (...args) => {
      const receipt = await apply(...args);
      await saveMealPlanRead(scope, [date], [{ date, state: newer }]);
      return receipt;
    });

    const result = await importGuestMealPlan({ scope, csrfToken: 'csrf', deviceId: 'device', api });

    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [date]: guest } });
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({ states: { [date]: newer } });
    expect(result.preservedConflicts).toBe(1);
  });

  it('keeps independent idempotent outboxes when the same guest revision is explicitly imported into two accounts', async () => {
    const guest = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(guest);
    const { api } = createImportApi();
    vi.mocked(api.importCommands).mockRejectedValue(new Error('response lost'));
    for (const target of [scope, 'account:another-user'] as const) {
      await expect(importGuestMealPlan({ scope: target, csrfToken: 'csrf', deviceId: 'device', api }))
        .rejects.toThrow('response lost');
    }

    const first = await readMealPlanOutbox([scope]);
    const second = await readMealPlanOutbox(['account:another-user']);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.mutationId).not.toBe(second[0]?.mutationId);
  });

  it('retains the guest source if the target changed after the receipt, even to the same recipe', async () => {
    const guest = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(guest);
    const { api, states } = createImportApi();
    vi.mocked(api.readStates).mockImplementation(async (_scope, dates) => dates.map((day) => {
      const state = states.get(day);
      return { date: day, state: state === undefined ? null : { ...state, revision: crypto.randomUUID(), serverSequence: 2 } };
    }));

    await importGuestMealPlan({ scope, csrfToken: 'csrf', deviceId: 'device', api });

    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: { [date]: guest } });
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({
      conflicts: [expect.objectContaining({ sourceScope: 'guest', sourceRevision: guest.revision })],
    });
  });

  it('preserves the guest action timestamp instead of converting an old choice into a new manual edit', async () => {
    const guest = createLocalPlanState(date, 'manual', 'pasta-e-ceci');
    await saveGuestPlanState(guest);
    vi.setSystemTime(new Date('2026-10-28T10:00:00.000Z'));
    const { api } = createImportApi();

    await importGuestMealPlan({ scope, csrfToken: 'csrf', deviceId: 'device', api });

    expect(api.importCommands).toHaveBeenCalledWith(scope, [expect.objectContaining({
      source: 'guest', sourceId: date, localRevision: guest.revision,
      command: expect.objectContaining({ action: 'manual_set', clientUpdatedAt: originalTime }),
    })], 'csrf');
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: {} });
  });
});
