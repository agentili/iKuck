import { beforeEach, describe, expect, it } from 'vitest';
import { RECIPES } from '../../domain/recipes';
import { deleteLocalDatabase, readMeta } from '../../storage/indexedDb';
import { readCookEvents, readRecipePreferences } from '../../storage/activityStorage';
import { readQueuedMutations } from '../../sync/syncQueue';
import { usePantryStore } from '../localPantryStore';
import {
  hydrateActivityStore,
  useActivityStore,
  waitForPendingActivityWrites,
} from '../activityStore';

describe('activity store', () => {
  beforeEach(async () => {
    await waitForPendingActivityWrites();
    await deleteLocalDatabase();
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
    const first = useActivityStore.getState().recordCookEvent(RECIPES[0]);
    useActivityStore.getState().recordCookEvent(RECIPES[1]);
    expect(first).not.toBeNull();
    expect(useActivityStore.getState().removeCookEvent(first!)).toBe(true);
    expect(useActivityStore.getState().clearActivity()).toBe(1);
    expect(useActivityStore.getState().events).toEqual([]);
  });

  it('queues activity and preference changes with stable entity types', async () => {
    useActivityStore.getState().recordCookEvent(RECIPES[0]);
    useActivityStore.getState().setRecipePreference(RECIPES[0].id, true, 5, null);
    await waitForPendingActivityWrites();

    const mutations = await readQueuedMutations();
    expect(mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'cook_event', operation: 'upsert' }),
      expect.objectContaining({ entityType: 'recipe_preference', entityId: RECIPES[0].id, operation: 'upsert' }),
    ]));
    await expect(readMeta('deviceId')).resolves.toBeTypeOf('string');
    await expect(readCookEvents()).resolves.toHaveLength(1);
    await expect(readRecipePreferences()).resolves.toHaveLength(1);
  });
});
