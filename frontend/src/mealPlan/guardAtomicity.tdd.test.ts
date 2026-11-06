import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanCommand, PlanState } from '@ikuck/shared/contracts';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { scopeStorageKey } from '../sync/scopeContext';
import { commitMealPlanCommand, enqueueMealPlanCommand, readMealPlanOutbox, readMealPlanSnapshot, saveGuestPlanState, saveMealPlanRead } from './storage';

const scope = 'account:guard-user';
const original: PlanState = {
  date: '2026-10-29', revision: '123e4567-e89b-42d3-a456-426614174000',
  serverSequence: 1, kind: 'manual', recipeId: 'first-recipe',
};

beforeEach(async () => { await deleteLocalDatabase(); });

describe('meal plan invalidation during IndexedDB transactions', () => {
  it('rolls back a stale read merge after its snapshot put and preserves the earlier committed snapshot', async () => {
    await saveMealPlanRead(scope, [original.date], [{ date: original.date, state: original }]);
    const before = await readMealPlanSnapshot(scope);
    const updated = { ...original, revision: '223e4567-e89b-42d3-a456-426614174000', serverSequence: 2, recipeId: 'new-recipe' };
    let current = true;
    const nativePut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = nativePut.apply(this, args);
      if (this.name === 'keyValue' && args[1] === scopeStorageKey(scope, 'meal-plan-v2')) {
        request.addEventListener('success', () => { current = false; }, { once: true });
      }
      return request;
    });
    const guard: () => void = () => current ? undefined : false;
    try {
      await expect(saveMealPlanRead(scope, [updated.date], [{ date: updated.date, state: updated }], undefined, guard))
        .rejects.toThrow(/guard.*assert/i);
    } finally { put.mockRestore(); }
    expect(current).toBe(false);
    expect(await readMealPlanSnapshot(scope)).toEqual(before);
  });

  it('rolls back a stale import receipt without losing its source, outbox, or committed target', async () => {
    const command: PlanCommand = {
      version: 2, scope, date: original.date, operationId: 'import-operation', deviceId: 'device-1',
      clientUpdatedAt: '2026-10-28T12:00:00.000Z', action: 'manual_set', recipeId: original.recipeId,
    };
    await saveGuestPlanState(original);
    await saveMealPlanRead(scope, [original.date], [{ date: original.date, state: original }]);
    await enqueueMealPlanCommand(scope, command, { sourceScope: 'guest', sourceRevision: original.revision });
    const guestBefore = await readMealPlanSnapshot('guest');
    const targetBefore = await readMealPlanSnapshot(scope);
    const queueBefore = await readMealPlanOutbox([scope]);
    const confirmed = { ...original, revision: '223e4567-e89b-42d3-a456-426614174000', serverSequence: 2 };
    let current = true;
    const nativePut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = nativePut.apply(this, args);
      if (this.name === 'keyValue' && args[1] === scopeStorageKey(scope, 'meal-plan-v2')) {
        request.addEventListener('success', () => { current = false; }, { once: true });
      }
      return request;
    });
    const guard: () => void = () => current ? undefined : false;
    try {
      await expect(commitMealPlanCommand(scope, scope, command,
        { version: 2, operationId: command.operationId, outcome: 'applied', current: confirmed }, confirmed,
        { source: { scope: 'guest', date: original.date, revision: original.revision, receiptState: confirmed }, assertCurrent: guard }))
        .rejects.toThrow(/guard.*assert/i);
    } finally { put.mockRestore(); }
    expect(current).toBe(false);
    expect(await readMealPlanSnapshot('guest')).toEqual(guestBefore);
    expect(await readMealPlanSnapshot(scope)).toEqual(targetBefore);
    expect(await readMealPlanOutbox([scope])).toEqual(queueBefore);
  });
});
