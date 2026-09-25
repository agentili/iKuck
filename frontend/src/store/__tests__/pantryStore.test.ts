import { DEFAULT_STAPLE_IDS } from '../../domain/ingredients';
import { vi } from 'vitest';
import * as pantryStorage from '../../storage/pantryStorage';
import { deleteLocalDatabase, readKeyValue, writeKeyValue } from '../../storage/indexedDb';
import { GUEST_SYNC_SCOPE, readQueuedMutations, syncNow, waitForPendingQueueWrites } from '../../sync/syncQueue';
import { setActiveDataScope } from '../../sync/scopeContext';
import { hydratePantryStore, usePantryStore } from '../localPantryStore';
import { usePersistenceStatusStore } from '../persistenceStatusStore';

describe('pantry store', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    window.localStorage.clear();
    setActiveDataScope('guest');
    usePersistenceStatusStore.getState().reset();
    usePantryStore.setState({
      hasHydrated: false,
      pantryItems: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
      pantryLots: [],
    });
    await readKeyValue('pantry');
    await deleteLocalDatabase();
  });

  it('starts with default staples and no pantry items', () => {
    const state = usePantryStore.getState();

    expect(state.pantryItems).toEqual([]);
    expect(state.stapleIds).toEqual([...DEFAULT_STAPLE_IDS]);
  });

  it('rehydrates the pantry from the newly active house scope', async () => {
    setActiveDataScope('guest');
    await pantryStorage.writePantrySnapshot({
      pantryItems: [{ id: 'guest-item', label: 'Guest', known: false }],
      stapleIds: [],
    });
    await hydratePantryStore();

    setActiveDataScope('house:house-a');
    await pantryStorage.writePantrySnapshot({
      pantryItems: [{ id: 'house-item', label: 'House', known: false }],
      stapleIds: [],
    });
    await hydratePantryStore();

    expect(usePantryStore.getState().pantryItems).toEqual([{ id: 'house-item', label: 'House', known: false }]);
    expect(usePantryStore.getState().hasHydrated).toBe(true);
    setActiveDataScope('guest');
  });

  it('retries hydration for the new scope after an older hydration is still in flight', async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const rehydrate = vi.spyOn(usePantryStore.persist, 'rehydrate').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const firstHydration = hydratePantryStore();
    await vi.waitFor(() => expect(calls).toBe(1));

    setActiveDataScope('house:hydration-race');
    const secondHydration = hydratePantryStore();
    releaseFirst?.();
    await Promise.all([firstHydration, secondHydration]);

    expect(calls).toBe(2);
    expect(usePantryStore.getState().hasHydrated).toBe(true);
    rehydrate.mockRestore();
    setActiveDataScope('guest');
  });

  it('preserves an existing persisted house pantry while switching away and back', async () => {
    const houseScope = 'house:house-persisted' as const;
    await pantryStorage.writePantrySnapshot({
      pantryItems: [{ id: 'house-item', label: 'House', known: true }],
      stapleIds: [],
      pantryLots: [{
        id: 'house-lot', ingredientId: 'house-item', label: 'House', known: true, quantity: 500, unit: 'g',
        expiresAt: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
      }],
    }, houseScope);
    setActiveDataScope(houseScope);
    await hydratePantryStore();
    setActiveDataScope('account:user-1');
    setActiveDataScope(houseScope);
    await hydratePantryStore();

    expect(usePantryStore.getState().pantryLots).toEqual([expect.objectContaining({ id: 'house-lot', quantity: 500 })]);
  });

  it('exposes hydration state and becomes ready after IndexedDB rehydration', async () => {
    expect(usePantryStore.getState().hasHydrated).toBe(false);

    await hydratePantryStore();

    expect(usePantryStore.getState().hasHydrated).toBe(true);
  });

  it('adds unique ingredients while preserving the first label', () => {
    usePantryStore.getState().addIngredients([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'tomato', label: 'Pomodori', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);
  });

  it('removes one pantry ingredient by id', () => {
    usePantryStore.getState().addIngredients([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);

    usePantryStore.getState().removeIngredient('tomato');

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'tuna', label: 'Tonno', known: true },
    ]);
  });

  it('toggles a staple without affecting pantry ingredients', () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);
    usePantryStore.getState().toggleStaple('salt');

    expect(usePantryStore.getState().stapleIds).not.toContain('salt');
    expect(usePantryStore.getState().pantryItems).toHaveLength(1);

    usePantryStore.getState().toggleStaple('salt');
    expect(usePantryStore.getState().stapleIds).toContain('salt');
  });

  it('combines known pantry ingredients with enabled staples', () => {
    usePantryStore.getState().addIngredients([
      { id: 'pasta', label: 'Pasta', known: true },
      { id: 'custom:tempeh', label: 'Tempeh', known: false },
    ]);
    usePantryStore.getState().toggleStaple('salt');

    expect(usePantryStore.getState().getAvailableIngredientIds()).toEqual([
      'pasta',
      'water',
      'black_pepper',
      'olive_oil',
    ]);
  });

  it('creates a presence-only lot when adding an ingredient without details', () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);

    expect(usePantryStore.getState().pantryLots).toEqual([
      expect.objectContaining({
        id: 'pasta',
        ingredientId: 'pasta',
        quantity: null,
        unit: null,
        expiresAt: null,
      }),
    ]);
  });

  it('keeps two lots for one ingredient and aggregates recipe-facing presence', () => {
    usePantryStore.getState().addPantryLot({
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: 500,
      unit: 'g',
      expiresAt: '2026-10-01',
    });
    usePantryStore.getState().addPantryLot({
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: 1,
      unit: 'kg',
      expiresAt: null,
    });

    expect(usePantryStore.getState().pantryLots).toHaveLength(2);
    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(usePantryStore.getState().getPantryQuantitySummary()[0]).toMatchObject({
      totalQuantity: 1500,
      totalUnit: 'g',
      lotCount: 2,
      earliestExpiresAt: '2026-10-01',
    });
  });

  it('removes one lot without removing sibling lots', () => {
    const firstId = usePantryStore.getState().addPantryLot({
      ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g', expiresAt: null,
    });
    usePantryStore.getState().addPantryLot({
      ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 1, unit: 'kg', expiresAt: null,
    });

    usePantryStore.getState().removePantryLot(firstId!);

    expect(usePantryStore.getState().pantryLots).toHaveLength(1);
    expect(usePantryStore.getState().pantryItems).toHaveLength(1);
  });

  it('restores a removed lot with the same identity', () => {
    usePantryStore.getState().addPantryLot({
      ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g', expiresAt: null,
    });
    const removedLot = usePantryStore.getState().pantryLots[0];

    usePantryStore.getState().removePantryLot(removedLot.id);

    expect(usePantryStore.getState().restorePantryLot(removedLot)).toBe(true);
    expect(usePantryStore.getState().pantryLots).toContainEqual(removedLot);
  });

  it('updates quantity and expiry details without losing the lot id', () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);
    const id = usePantryStore.getState().pantryLots[0].id;
    const updated = usePantryStore.getState().updatePantryLot(id, {
      quantity: 320,
      unit: 'g',
      expiresAt: '2026-09-20',
    });

    expect(updated).toBe(true);
    expect(usePantryStore.getState().pantryLots[0]).toMatchObject({ id, quantity: 320, unit: 'g', expiresAt: '2026-09-20' });
  });

  it('queues pantry and staple changes without delaying the local state update', async () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);
    usePantryStore.getState().toggleStaple('salt');
    await waitForPendingQueueWrites();

    const mutations = await readQueuedMutations(GUEST_SYNC_SCOPE);
    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'pantry_lot',
        entityId: 'pasta',
        operation: 'upsert',
      }),
      expect.objectContaining({
        entityType: 'staple_preference',
        entityId: 'salt',
        operation: 'upsert',
        payload: { enabled: false },
      }),
    ]));
  });

  it('surfaces a pantry persistence failure while keeping the local change available', async () => {
    vi.spyOn(pantryStorage, 'writePantrySnapshot').mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);

    await vi.waitFor(() => expect(usePersistenceStatusStore.getState().statuses.pantry.state).toBe('memory-only'));
    expect(usePantryStore.getState().pantryItems).toEqual([{ id: 'pasta', label: 'Pasta', known: true }]);
  });

  it('applies a server change without creating a second local mutation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      changes: [{
        mutationId: 'server-change',
        deviceId: 'server-device',
        entityType: 'pantry_item',
        entityId: 'tomato',
        operation: 'upsert',
        payload: { id: 'tomato', label: 'Pomodoro', known: true },
        clientUpdatedAt: '2026-09-12T12:00:00.000Z',
        serverSequence: 1,
      }],
      nextCursor: 1,
    }), { status: 200 }));

    await syncNow({
      fetch,
      session: {
        userId: 'user-1',
        emailVerifiedAt: '2026-09-12T10:00:00.000Z',
        csrfToken: 'csrf-1',
      },
    });
    await waitForPendingQueueWrites();

    expect(usePantryStore.getState().pantryItems).toContainEqual({
      id: 'tomato',
      label: 'Pomodoro',
      known: true,
    });
    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toEqual([]);
  });

  it('persists pantry and staples across rehydration', async () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);
    usePantryStore.getState().toggleStaple('salt');
    const persisted = await readKeyValue<string>('pantry');
    expect(persisted).not.toBeNull();
    usePantryStore.setState({ pantryItems: [], stapleIds: [], hasHydrated: false });
    await readKeyValue('pantry');
    await writeKeyValue('pantry', persisted!);

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(usePantryStore.getState().stapleIds).not.toContain('salt');
  });

  it('recovers from unreadable persisted data', async () => {
    await writeKeyValue('pantry', '{not-json');

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([]);
    expect(usePantryStore.getState().stapleIds).toEqual([...DEFAULT_STAPLE_IDS]);
    await expect(readKeyValue<string>('pantry').then((raw) => JSON.parse(raw!))).resolves.toMatchObject({
      state: { pantryItems: [], stapleIds: [...DEFAULT_STAPLE_IDS] },
    });
  });

  it('migrates an existing iRicetto pantry to the iKuck storage key', async () => {
    const legacyPersisted = JSON.stringify({
      state: {
        pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
        stapleIds: [...DEFAULT_STAPLE_IDS],
      },
      version: 1,
    });
    window.localStorage.removeItem('ikuck-pantry-v1');
    window.localStorage.setItem('iricetto-pantry-v1', legacyPersisted);

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(window.localStorage.getItem('iricetto-pantry-v1')).toBeNull();
    await expect(readKeyValue<string>('pantry')).resolves.toMatch(/"pantryLots":\[\{"id":"pasta"/);
  });
});
