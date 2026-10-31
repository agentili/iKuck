import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanState } from '@ikuck/shared/contracts';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { scopeStorageKey } from '../sync/scopeContext';
import type { MealPlanApi } from './api';
import { synchronizeMealPlanScope } from './service';
import { createMealPlanCapabilityFingerprint, readMealPlanBootstrap, readMealPlanSnapshot } from './storage';

const scope = 'house:bootstrap-fence' as const;
const capability = { version: 2 as const, syncReadVersion: 2 as const };
const fingerprint = createMealPlanCapabilityFingerprint(capability);
const state: PlanState = { date: '2020-01-01', revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: 1,
  kind: 'manual', recipeId: 'pasta-e-ceci' };

beforeEach(async () => { await deleteLocalDatabase(); });
afterEach(() => vi.restoreAllMocks());

describe('meal plan bootstrap fencing', () => {
  it.each(['capability', 'incremental', 'anti-entropy'] as const)('fences %s writes inside IndexedDB, not only after the commit', async (phase) => {
    let current = true;
    let armed = phase === 'capability';
    let pages = 0;
    const newer: PlanState = { ...state, revision: crypto.randomUUID(), serverSequence: 2, recipeId: 'newer-recipe' };
    const originalGet = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalGet.call(this, key);
      if (armed && this.transaction.mode === 'readwrite' && key === scopeStorageKey(scope, 'meal-plan-v2')) {
        request.addEventListener('success', () => { current = false; });
      }
      return request;
    });
    const api = {
      getCapabilities: vi.fn(async () => capability),
      readSyncPage: vi.fn(async (_scope: string, _device: string, cursor: number) => {
        pages += 1;
        if (pages === 1) return { changes: [{ state, serverSequence: 1 }], nextCursor: 1 };
        if (phase === 'incremental') {
          armed = true;
          return { changes: [{ state: newer, serverSequence: 2 }], nextCursor: 2 };
        }
        return { changes: [], nextCursor: cursor };
      }),
      readStates: vi.fn(async () => {
        armed = true;
        return [{ date: state.date, state: newer }];
      }),
    } as unknown as MealPlanApi;

    await expect(synchronizeMealPlanScope({ scope, csrfToken: 'csrf', api, deviceId: 'device', assertCurrent: () => { if (!current) throw new Error('La sessione o la Casa è cambiata durante il bootstrap del piano.'); } }))
      .rejects.toThrow(/sessione|Casa/i);
    get.mockRestore();

    const snapshot = await readMealPlanSnapshot(scope);
    if (phase === 'capability') {
      expect(snapshot.capability).toBeNull();
      expect(snapshot.bootstrap).toBeNull();
    } else {
      expect(snapshot.states[state.date]).toEqual(state);
      expect(snapshot.bootstrap?.cursor).toBe(1);
    }
  });

  it('does not activate staging when the session changes during the snapshot transaction read', async () => {
    let current = true;
    let pageReceived = false;
    const originalGet = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalGet.call(this, key);
      if (pageReceived && this.transaction.mode === 'readwrite' && key === scopeStorageKey(scope, 'meal-plan-v2')) {
        request.addEventListener('success', () => { current = false; });
      }
      return request;
    });
    const api = {
      getCapabilities: vi.fn(async () => capability),
      readSyncPage: vi.fn(async () => {
        pageReceived = true;
        return { changes: [{ state, serverSequence: 1 }], nextCursor: 1 };
      }),
    } as unknown as MealPlanApi;

    await expect(synchronizeMealPlanScope({ scope, csrfToken: 'csrf', api, deviceId: 'device', assertCurrent: () => { if (!current) throw new Error('La sessione o la Casa è cambiata durante il bootstrap del piano.'); } }))
      .rejects.toThrow(/sessione|Casa/i);
    get.mockRestore();

    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({ states: {}, bootstrap: null });
    await expect(readMealPlanBootstrap(scope, fingerprint)).resolves.toMatchObject({ cursor: 1, states: { [state.date]: state } });
  });

  it('does not commit a staged page when the session changes during the underlying IndexedDB transaction read', async () => {
    let current = true;
    const originalGet = IDBObjectStore.prototype.get;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalGet.call(this, key);
      if (this.transaction.mode === 'readwrite' && key === scopeStorageKey(scope, 'meal-plan-bootstrap-v2')) {
        request.addEventListener('success', () => { current = false; });
      }
      return request;
    });
    const api = {
      getCapabilities: vi.fn(async () => capability),
      readSyncPage: vi.fn(async () => ({ changes: [{ state, serverSequence: 1 }], nextCursor: 1 })),
    } as unknown as MealPlanApi;

    await expect(synchronizeMealPlanScope({ scope, csrfToken: 'csrf', api, deviceId: 'device', assertCurrent: () => { if (!current) throw new Error('La sessione o la Casa è cambiata durante il bootstrap del piano.'); } }))
      .rejects.toThrow(/sessione|Casa/i);
    get.mockRestore();

    await expect(readMealPlanBootstrap(scope, fingerprint)).resolves.toMatchObject({ cursor: 0, states: {} });
    await expect(readMealPlanSnapshot(scope)).resolves.toMatchObject({ states: {}, bootstrap: null });
  });
});
