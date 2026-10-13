import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECIPES } from '../../domain/recipes';
import type { CookEvent } from '@ikuck/shared/contracts';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { closeLocalDatabase, deleteLocalDatabase, readMeta } from '../../storage/indexedDb';
import * as activityStorage from '../../storage/activityStorage';
import { readCookEvents, readRecipePreferences } from '../../storage/activityStorage';
import { readDinnerEntries } from '../../storage/dinnerDiaryStorage';
import * as dinnerConsumptionStorage from '../../storage/dinnerConsumptionStorage';
import { readDinnerConsumptionOutbox } from '../../storage/dinnerConsumptionStorage';
import { readPantrySnapshot, writePantrySnapshot } from '../../storage/pantryStorage';
import { GUEST_SYNC_SCOPE, readQueuedMutations } from '../../sync/syncQueue';
import { setActiveDataScope, setPersonalDataScope } from '../../sync/scopeContext';
import { waitForScopedWrites } from '../../sync/scopeWriteFence';
import { usePantryStore } from '../localPantryStore';
import {
  hydrateActivityStore,
  useActivityStore,
  waitForPendingActivityWrites,
} from '../activityStore';
import { usePersistenceStatusStore } from '../persistenceStatusStore';

describe('activity store', () => {
  beforeEach(async () => {
    setActiveDataScope(GUEST_SYNC_SCOPE);
    setPersonalDataScope(GUEST_SYNC_SCOPE);
    await waitForPendingActivityWrites();
    await deleteLocalDatabase();
    usePersistenceStatusStore.getState().reset();
    useActivityStore.setState({ hasHydrated: false, events: [], preferences: [] });
    usePantryStore.setState({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      pantryLots: [],
      stapleIds: [],
    });
  });

  it('hydrates empty activity and preferences for a guest', async () => {
    await hydrateActivityStore();

    expect(useActivityStore.getState()).toMatchObject({ hasHydrated: true, events: [], preferences: [] });
  });

  it('retries both functional hydrations after the active account changes in flight', async () => {
    const accountA = 'account:activity-a' as const;
    const accountB = 'account:activity-b' as const;
    let releaseOld: (() => void) | undefined;
    const oldRequest = new Promise<void>((resolve) => { releaseOld = resolve; });
    const eventsSpy = vi.spyOn(activityStorage, 'readCookEvents').mockImplementation(async (scope) => {
      if (scope === accountA) await oldRequest;
      return [];
    });
    const preferencesSpy = vi.spyOn(activityStorage, 'readRecipePreferences').mockImplementation(async (scope) => {
      if (scope === accountA) await oldRequest;
      return [];
    });

    setActiveDataScope(accountA);
    const firstHydration = hydrateActivityStore();
    await vi.waitFor(() => expect(eventsSpy).toHaveBeenCalledWith(accountA));
    setActiveDataScope(accountB);
    const secondHydration = hydrateActivityStore();
    releaseOld?.();
    await Promise.all([firstHydration, secondHydration]);

    expect(eventsSpy).toHaveBeenCalledWith(accountB);
    expect(preferencesSpy).toHaveBeenCalledWith(accountB);
    expect(useActivityStore.getState().hasHydrated).toBe(true);
    eventsSpy.mockRestore();
    preferencesSpy.mockRestore();
    setActiveDataScope('guest');
  });

  it('tracks a queued cook-event persistence callback before its storage write starts', async () => {
    const scope = 'account:activity-pending' as const;
    setActiveDataScope(scope);
    const originalWrite = activityStorage.writeCookEvents;
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(activityStorage, 'writeCookEvents').mockImplementation(async (...args) => {
      await paused;
      return originalWrite(...args);
    });
    try {
      expect(useActivityStore.getState().recordCookEvent(RECIPES[0])).not.toBeNull();
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      let drained = false;
      const drain = waitForScopedWrites(scope).then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release?.();
      await drain;
      await expect(readCookEvents(scope)).resolves.toHaveLength(1);
    } finally { release?.(); await waitForPendingActivityWrites(); spy.mockRestore(); }
  });

  it('tracks a queued recipe-preference persistence callback before its storage write starts', async () => {
    const scope = 'account:preferences-pending' as const;
    setActiveDataScope(scope);
    const originalWrite = activityStorage.writeRecipePreferences;
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(activityStorage, 'writeRecipePreferences').mockImplementation(async (...args) => {
      await paused;
      return originalWrite(...args);
    });
    try {
      expect(useActivityStore.getState().setRecipePreference(RECIPES[0].id, true, 5, null)).toBe(true);
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      let drained = false;
      const drain = waitForScopedWrites(scope).then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release?.();
      await drain;
      await expect(readRecipePreferences(scope)).resolves.toHaveLength(1);
    } finally { release?.(); await waitForPendingActivityWrites(); spy.mockRestore(); }
  });

  it('confirms and retries a cook event through the shared consumption commit', async () => {
    const scope = 'guest' as const;
    const now = '2026-10-07T09:00:00.000Z';
    const recipe = RECIPES.find((item) => item.ingredients.some((ingredient) => ingredient.ingredientId === 'pasta')) ?? RECIPES[0];
    const lot = { id: 'activity-pasta-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g' as const, expiresAt: null, createdAt: now, updatedAt: now };
    const initialPantry = { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'], pantryLots: [lot] };
    const event: CookEvent = { id: 'event:shared-consumption-1', recipeId: recipe.id, recipeTitle: recipe.title, servings: 2, cookedAt: now, note: null, createdAt: now, updatedAt: now };
    const entry: DinnerEntry = {
      id: event.id, date: '2026-10-07', text: recipe.title, servings: event.servings, note: event.note,
      recipes: [{ recipeId: recipe.id, title: recipe.title, source: recipe.source === 'diary' ? 'diary' : 'catalog' }],
      authorId: null, createdAt: now, updatedAt: now,
    };
    const command: DinnerConsumptionCommand = {
      operationId: 'activity-consumption-op-1', entryId: entry.id, scope, servings: event.servings,
      ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
    };
    await writePantrySnapshot(initialPantry, scope);

    const recordCookEvent = useActivityStore.getState().recordCookEvent;
    const firstConfirmation = recordCookEvent(recipe, event.servings, null, { command, event, entry });
    const duplicateClick = recordCookEvent(recipe, event.servings, null, { command, event, entry });
    await expect(Promise.all([firstConfirmation, duplicateClick])).resolves.toEqual([event.id, event.id]);
    await closeLocalDatabase();
    useActivityStore.setState({ events: [] });
    await hydrateActivityStore();
    await expect(recordCookEvent(recipe, event.servings, null, { command, event, entry })).resolves.toBe(event.id);

    const expectedRemaining = lot.quantity - 100 * command.servings;
    await expect(readPantrySnapshot(scope)).resolves.toMatchObject({
      pantryLots: [expect.objectContaining({ id: lot.id, quantity: expectedRemaining })],
      stapleIds: initialPantry.stapleIds,
    });
    await expect(readCookEvents(scope)).resolves.toEqual([event]);
    await expect(readDinnerEntries(scope)).resolves.toEqual([entry]);
    await expect(readDinnerConsumptionOutbox(scope)).resolves.toMatchObject([
      { operationId: command.operationId, entryId: entry.id, command, cookEvent: event },
    ]);
    await expect(readQueuedMutations(scope)).resolves.toEqual([]);
    expect(useActivityStore.getState().events).toEqual([event]);
    expect(usePantryStore.getState().pantryLots).toEqual([expect.objectContaining({ id: lot.id, quantity: expectedRemaining })]);
  });

  it('does not publish a cook event or consume pantry when the atomic persistence fails', async () => {
    const now = '2026-10-07T09:00:00.000Z';
    const recipe = RECIPES[0];
    const lot = { id: 'failed-activity-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g' as const, expiresAt: null, createdAt: now, updatedAt: now };
    const initialPantry = { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'], pantryLots: [lot] };
    const event: CookEvent = { id: 'event:failed-consumption', recipeId: recipe.id, recipeTitle: recipe.title, servings: 2, cookedAt: now, note: null, createdAt: now, updatedAt: now };
    const entry: DinnerEntry = {
      id: event.id, date: '2026-10-07', text: recipe.title, servings: 2, note: null,
      recipes: [{ recipeId: recipe.id, title: recipe.title, source: recipe.source === 'diary' ? 'diary' : 'catalog' }],
      authorId: null, createdAt: now, updatedAt: now,
    };
    const command: DinnerConsumptionCommand = {
      operationId: 'failed-activity-operation', entryId: entry.id, scope: 'guest', servings: 2,
      ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
    };
    await writePantrySnapshot(initialPantry, 'guest');
    usePantryStore.setState(initialPantry);
    const failure = new Error('IndexedDB unavailable');
    const commit = vi.spyOn(dinnerConsumptionStorage, 'commitDinnerConsumption').mockRejectedValueOnce(failure);

    const result = await useActivityStore.getState().recordCookEvent(recipe, 2, null, { command, event, entry });

    expect(result).toBeNull();
    expect(useActivityStore.getState().events).toEqual([]);
    expect(usePantryStore.getState().pantryLots).toEqual([lot]);
    await expect(readCookEvents('guest')).resolves.toEqual([]);
    await expect(readDinnerEntries('guest')).resolves.toEqual([]);
    await expect(readDinnerConsumptionOutbox('guest')).resolves.toEqual([]);
    await expect(readPantrySnapshot('guest')).resolves.toMatchObject({ pantryLots: [lot] });
    commit.mockRestore();
  });

  it('records cooking without changing the pantry lots', async () => {
    const before = JSON.stringify(usePantryStore.getState());
    const id = useActivityStore.getState().recordCookEvent(RECIPES[0], 2, 'Con poco limone');

    expect(id).not.toBeNull();
    expect(useActivityStore.getState().events).toMatchObject([{
      recipeId: RECIPES[0].id,
      recipeTitle: RECIPES[0].title,
      servings: 2,
      note: 'Con poco limone',
    }]);
    expect(JSON.stringify(usePantryStore.getState())).toBe(before);
  });

  it('surfaces an activity persistence failure while keeping the local event available', async () => {
    vi.spyOn(activityStorage, 'writeCookEvents').mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    const id = useActivityStore.getState().recordCookEvent(RECIPES[0]);

    await vi.waitFor(() => expect(usePersistenceStatusStore.getState().statuses.activity.state).toBe('memory-only'));
    expect(id).not.toBeNull();
    expect(useActivityStore.getState().events).toHaveLength(1);
  });

  it('replaces a preference and removes it when no signal remains', async () => {
    expect(useActivityStore.getState().setRecipePreference(RECIPES[0].id, true, 5, 'Da rifare')).toBe(true);
    expect(useActivityStore.getState().getRecipePreference(RECIPES[0].id)).toMatchObject({ favorite: true, rating: 5, note: 'Da rifare' });

    expect(useActivityStore.getState().setRecipePreference(RECIPES[0].id, false, 4, null)).toBe(true);
    expect(useActivityStore.getState().getRecipePreference(RECIPES[0].id)).toMatchObject({ favorite: false, rating: 4, note: null });

    expect(useActivityStore.getState().setRecipePreference(RECIPES[0].id, false, null, null)).toBe(true);
    expect(useActivityStore.getState().getRecipePreference(RECIPES[0].id)).toBeUndefined();
  });

  it('rejects an invalid rating without changing preferences', () => {
    expect(useActivityStore.getState().setRecipePreference(RECIPES[0].id, false, 6, null)).toBe(false);
    expect(useActivityStore.getState().preferences).toEqual([]);
  });

  it('removes events and clears all activity explicitly', async () => {
    const first = await useActivityStore.getState().recordCookEvent(RECIPES[0]);
    await useActivityStore.getState().recordCookEvent(RECIPES[1]);
    expect(first).not.toBeNull();
    expect(useActivityStore.getState().removeCookEvent(first!)).toBe(true);
    expect(useActivityStore.getState().clearActivity()).toBe(1);
    expect(useActivityStore.getState().events).toEqual([]);
  });

  it('restores a removed cooking event with the same identity', async () => {
    const id = await useActivityStore.getState().recordCookEvent(RECIPES[0]);
    const removedEvent = useActivityStore.getState().events[0];

    useActivityStore.getState().removeCookEvent(id!);

    expect(useActivityStore.getState().restoreCookEvent(removedEvent)).toBe(true);
    expect(useActivityStore.getState().events).toContainEqual(removedEvent);
  });

  it('stores and queues cooking events and recipe preferences in the active house', async () => {
    const accountScope = 'account:user-1' as const;
    const houseScope = 'house:activity-home' as const;
    setPersonalDataScope(accountScope);
    setActiveDataScope(houseScope);
    await useActivityStore.getState().recordCookEvent(RECIPES[0]);
    useActivityStore.getState().setRecipePreference(RECIPES[0].id, true, 5, null);
    await waitForPendingActivityWrites();

    await expect(readCookEvents(houseScope)).resolves.toHaveLength(1);
    await expect(readRecipePreferences(houseScope)).resolves.toHaveLength(1);
    await expect(readCookEvents(accountScope)).resolves.toEqual([]);
    await expect(readRecipePreferences(accountScope)).resolves.toEqual([]);
    await expect(readQueuedMutations(houseScope)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'cook_event', operation: 'upsert' }),
      expect.objectContaining({ entityType: 'recipe_preference', operation: 'upsert' }),
    ]));
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
  });

  it('queues activity and preference changes with stable entity types', async () => {
    useActivityStore.getState().recordCookEvent(RECIPES[0]);
    useActivityStore.getState().setRecipePreference(RECIPES[0].id, true, 5, null);
    await waitForPendingActivityWrites();

    const mutations = await readQueuedMutations(GUEST_SYNC_SCOPE);
    expect(mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'cook_event', operation: 'upsert' }),
      expect.objectContaining({ entityType: 'recipe_preference', entityId: RECIPES[0].id, operation: 'upsert' }),
    ]));
    await expect(readMeta('deviceId')).resolves.toBeTypeOf('string');
    await expect(readCookEvents()).resolves.toHaveLength(1);
    await expect(readRecipePreferences()).resolves.toHaveLength(1);
  });
});
