import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookEvent, DietProfile, PantryLot, RecipePreference, ShoppingListItem, SyncChangeSet, SyncMutation } from '@ikuck/shared/contracts';
import { deleteLocalDatabase, readMeta } from '../storage/indexedDb';
import { readCookEvents, readRecipePreferences, writeCookEvents, writeRecipePreferences } from '../storage/activityStorage';
import { readPantrySnapshot } from '../storage/pantryStorage';
import { readShoppingList, writeShoppingList } from '../storage/shoppingListStorage';
import { readDietProfile, writeDietProfile } from '../storage/dietProfileStorage';
import {
  enqueueMutation,
  getDeviceId,
  importLocalData,
  readQueuedMutations,
  readSyncCursor,
  syncNow,
} from './syncQueue';

const session = {
  userId: 'user-1',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
  csrfToken: 'csrf-1',
};

const sampleMutation = (mutationId = 'mutation-1', clientUpdatedAt = '2026-09-12T12:00:00.000Z'): SyncMutation => ({
  mutationId,
  deviceId: 'device-1',
  entityType: 'pantry_item',
  entityId: 'pasta',
  operation: 'upsert',
  payload: { id: 'pasta', label: 'Pasta', known: true },
  clientUpdatedAt,
});

const responseFor = (body: SyncChangeSet) => new Response(JSON.stringify(body), { status: 200 });

describe('sync queue', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
  });

  it('creates a device id once without storing account secrets', async () => {
    const first = await getDeviceId();
    const second = await getDeviceId();

    expect(second).toBe(first);
    await expect(readMeta('deviceId')).resolves.toBe(first);
    expect(first).not.toContain('csrf');
  });

  it('queues mutations in timestamp order and remains idempotent by mutation id', async () => {
    await enqueueMutation(sampleMutation('mutation-2', '2026-09-12T12:02:00.000Z'));
    await enqueueMutation(sampleMutation('mutation-1', '2026-09-12T12:01:00.000Z'));
    await enqueueMutation(sampleMutation('mutation-1', '2026-09-12T12:01:00.000Z'));

    expect((await readQueuedMutations()).map(({ mutationId }) => mutationId)).toEqual([
      'mutation-1',
      'mutation-2',
    ]);
  });

  it('keeps mutations queued when the sync request fails', async () => {
    await enqueueMutation(sampleMutation());
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline'));

    await expect(syncNow({ fetch, session })).rejects.toMatchObject({ code: 'network_error' });
    await expect(readQueuedMutations()).resolves.toHaveLength(1);
  });

  it('rejects before sending when the session is not verified', async () => {
    const fetch = vi.fn();

    await expect(syncNow({
      fetch,
      session: { ...session, emailVerifiedAt: '' },
    })).rejects.toMatchObject({ code: 'email_not_verified' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('removes sent mutations, applies server changes and advances the cursor', async () => {
    await enqueueMutation(sampleMutation());
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{ ...sampleMutation(), serverSequence: 4 }],
      nextCursor: 4,
    }));

    await syncNow({ fetch, session });

    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }),
    }));
    await expect(readQueuedMutations()).resolves.toEqual([]);
    await expect(readSyncCursor()).resolves.toBe(4);
  });

  it('applies a remote pantry lot and keeps its quantity and expiry details', async () => {
    const lot: PantryLot = {
      id: 'lot-pasta',
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: 320,
      unit: 'g',
      expiresAt: '2026-09-20',
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:00:00.000Z',
    };
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{
        mutationId: 'lot-change',
        deviceId: 'device-remote',
        entityType: 'pantry_lot',
        entityId: lot.id,
        operation: 'upsert',
        payload: lot,
        clientUpdatedAt: lot.updatedAt,
        serverSequence: 5,
      }],
      nextCursor: 5,
    }));

    await syncNow({ fetch, session });

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      pantryLots: [expect.objectContaining({ id: lot.id, quantity: 320, unit: 'g', expiresAt: '2026-09-20' })],
    });
  });

  it('applies a remote shopping item without re-enqueueing it', async () => {
    const item: ShoppingListItem = {
      id: 'shopping-tomato',
      ingredientId: 'tomato',
      label: 'Pomodori',
      quantity: 4,
      unit: 'piece',
      note: null,
      purchased: false,
      sourceRecipeId: 'recipe-1',
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:00:00.000Z',
    };
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{
        mutationId: 'shopping-change',
        deviceId: 'device-remote',
        entityType: 'shopping_list_item',
        entityId: item.id,
        operation: 'upsert',
        payload: item,
        clientUpdatedAt: item.updatedAt,
        serverSequence: 6,
      }],
      nextCursor: 6,
    }));

    await syncNow({ fetch, session });

    await expect(readShoppingList()).resolves.toEqual([item]);
    await expect(readQueuedMutations()).resolves.toEqual([]);
  });

  it('includes local shopping items in the explicit account import', async () => {
    const item: ShoppingListItem = {
      id: 'shopping-import',
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: null,
      unit: null,
      note: null,
      purchased: false,
      sourceRecipeId: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:00:00.000Z',
    };
    await writeShoppingList([item]);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session);

    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({
      body: expect.stringContaining('shopping_list_item'),
    }));
    vi.unstubAllGlobals();
  });

  it('includes local activity and preferences in the explicit account import', async () => {
    const event: CookEvent = {
      id: 'event-import',
      recipeId: 'recipe-1',
      recipeTitle: 'Pasta',
      servings: 2,
      cookedAt: '2026-09-13T12:00:00.000Z',
      note: 'Con basilico',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    const preference: RecipePreference = {
      recipeId: event.recipeId,
      favorite: true,
      rating: 5,
      note: 'Da rifare',
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
    await writeCookEvents([event]);
    await writeRecipePreferences([preference]);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session);

    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({
      body: expect.stringContaining('cook_event'),
    }));
    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({
      body: expect.stringContaining('recipe_preference'),
    }));
    vi.unstubAllGlobals();
  });

  it('applies remote activity and preference changes without re-enqueueing them', async () => {
    const event: CookEvent = {
      id: 'event-remote',
      recipeId: 'recipe-1',
      recipeTitle: 'Pasta',
      servings: 2,
      cookedAt: '2026-09-13T12:00:00.000Z',
      note: 'Buona',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    const preference: RecipePreference = {
      recipeId: 'recipe-1',
      favorite: true,
      rating: 4,
      note: 'Da rifare',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    await writeCookEvents([]);
    await writeRecipePreferences([]);
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [
        { mutationId: 'event-change', deviceId: 'device-remote', entityType: 'cook_event', entityId: event.id, operation: 'upsert', payload: event, clientUpdatedAt: event.updatedAt, serverSequence: 7 },
        { mutationId: 'preference-change', deviceId: 'device-remote', entityType: 'recipe_preference', entityId: preference.recipeId, operation: 'upsert', payload: preference, clientUpdatedAt: preference.updatedAt, serverSequence: 8 },
      ],
      nextCursor: 8,
    }));

    await syncNow({ fetch, session });

    await expect(readCookEvents()).resolves.toEqual([event]);
    await expect(readRecipePreferences()).resolves.toEqual([preference]);
    await expect(readQueuedMutations()).resolves.toEqual([]);
  });

  it('applies a remote diet profile without re-enqueueing it', async () => {
    const profile: DietProfile = {
      diet: 'pescatarian',
      excludedAllergens: ['milk', 'peanuts'],
      nutrition: { maxCaloriesPerServing: 700, minProteinGramsPerServing: 25 },
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{
        mutationId: 'profile-change', deviceId: 'device-remote', entityType: 'diet_profile', entityId: 'profile',
        operation: 'upsert', payload: profile, clientUpdatedAt: profile.updatedAt, serverSequence: 9,
      }],
      nextCursor: 9,
    }));

    await syncNow({ fetch, session });

    await expect(readDietProfile()).resolves.toEqual(profile);
    await expect(readQueuedMutations()).resolves.toEqual([]);
  });

  it('includes the local diet profile in the explicit account import', async () => {
    const profile: DietProfile = {
      diet: 'vegetarian',
      excludedAllergens: ['fish'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: 20 },
      updatedAt: '2026-09-13T12:00:00.000Z',
    };
    await writeDietProfile(profile);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session);

    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({ body: expect.stringContaining('diet_profile') }));
    vi.unstubAllGlobals();
  });
});
