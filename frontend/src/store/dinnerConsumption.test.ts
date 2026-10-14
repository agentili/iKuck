import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import * as dinnerConsumptionStorage from '../storage/dinnerConsumptionStorage';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { readPantrySnapshot, writePantrySnapshot } from '../storage/pantryStorage';
import { setActiveDataScope, setPersonalDataScope } from '../sync/scopeContext';
import { resumeScope } from '../sync/scopeWriteFence';
import { usePantryStore } from './localPantryStore';
import { coordinateDinnerConsumption } from './dinnerConsumption';

const timestamp = '2026-10-07T09:00:00.000Z';
const entry: DinnerEntry = {
  id: 'coordinator-dinner-1', date: '2026-10-07', text: 'Pasta', servings: 2,
  note: null, recipes: [], authorId: null, createdAt: timestamp, updatedAt: timestamp,
};
const command: DinnerConsumptionCommand = {
  operationId: 'coordinator-operation-1', entryId: entry.id, scope: 'guest', servings: 2,
  ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
};
const lot = {
  id: 'coordinator-pasta-lot', ingredientId: 'pasta', label: 'Pasta', known: true,
  quantity: 500, unit: 'g' as const, expiresAt: null, createdAt: timestamp, updatedAt: timestamp,
};
const initialPantry = {
  pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'], pantryLots: [lot],
};

describe('dinner consumption coordinator', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    window.localStorage.clear();
    setPersonalDataScope('guest');
    setActiveDataScope('guest');
    resumeScope('guest');
    usePantryStore.setState({ ...initialPantry, hasHydrated: true });
    await writePantrySnapshot(initialPantry, 'guest');
  });

  it('publishes pantry changes only after the atomic history and receipt commit resolves', async () => {
    const actualCommit = dinnerConsumptionStorage.commitDinnerConsumption;
    let releaseCommit: (() => void) | undefined;
    let signalCommit: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => { signalCommit = resolve; });
    const paused = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commit = vi.spyOn(dinnerConsumptionStorage, 'commitDinnerConsumption').mockImplementation(async (input) => {
      signalCommit?.();
      await paused;
      return actualCommit(input);
    });

    try {
      const pending = coordinateDinnerConsumption({ command, entry, updatedAt: timestamp });
      await commitStarted;
      expect(usePantryStore.getState().pantryLots).toEqual([lot]);
      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ quantity: lot.quantity })] });

      releaseCommit?.();
      const result = await pending;

      const expectedRemaining = lot.quantity - 100 * command.servings;
      expect(result.pantrySnapshot.pantryLots).toEqual([expect.objectContaining({ quantity: expectedRemaining })]);
      expect(usePantryStore.getState().pantryLots).toEqual([expect.objectContaining({ id: lot.id, quantity: expectedRemaining })]);
      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [expect.objectContaining({ id: lot.id, quantity: expectedRemaining })] });
    } finally {
      releaseCommit?.();
      commit.mockRestore();
    }
  });

  it('does not publish the committed snapshot after the active scope changes', async () => {
    const actualCommit = dinnerConsumptionStorage.commitDinnerConsumption;
    let releaseCommit: (() => void) | undefined;
    let signalCommit: (() => void) | undefined;
    const commitFinished = new Promise<void>((resolve) => { signalCommit = resolve; });
    const paused = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commit = vi.spyOn(dinnerConsumptionStorage, 'commitDinnerConsumption').mockImplementation(async (input) => {
      const result = await actualCommit(input);
      signalCommit?.();
      await paused;
      return result;
    });

    try {
      const pending = coordinateDinnerConsumption({ command, entry, updatedAt: timestamp });
      await commitFinished;
      setActiveDataScope('account:next-session');
      releaseCommit?.();

      await expect(pending).rejects.toMatchObject({ code: 'scope_changed' });
      expect(usePantryStore.getState().pantryLots).toEqual([]);
      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({
        pantryLots: [expect.objectContaining({ id: lot.id, quantity: lot.quantity - 100 * command.servings })],
      });
    } finally {
      setActiveDataScope('guest');
      releaseCommit?.();
      commit.mockRestore();
    }
  });

  it('leaves the in-memory and persisted pantry unchanged when the commit fails', async () => {
    const failure = new Error('IndexedDB unavailable');
    const commit = vi.spyOn(dinnerConsumptionStorage, 'commitDinnerConsumption').mockRejectedValueOnce(failure);

    await expect(coordinateDinnerConsumption({ command, entry, updatedAt: timestamp })).rejects.toThrow(failure);

    expect(usePantryStore.getState().pantryLots).toEqual([lot]);
    await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [lot] });
    commit.mockRestore();
  });
});
