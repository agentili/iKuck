import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookEvent, DietProfile, PantryLot, RecipePreference, ShoppingListItem, SyncChangeSet, SyncMutation } from '@ikuck/shared/contracts';
import {
  deleteLocalDatabase,
  deleteQueueValue,
  readMeta,
  readQueueValues,
  writeQueueValue,
  type SyncScope,
} from '../storage/indexedDb';
import { readCookEvents, readRecipePreferences, writeCookEvents, writeRecipePreferences } from '../storage/activityStorage';
import { readPantrySnapshot } from '../storage/pantryStorage';
import { readShoppingList, writeShoppingList } from '../storage/shoppingListStorage';
import { readDietProfile, writeDietProfile } from '../storage/dietProfileStorage';
import {
  enqueueMutation,
  getSyncStatus,
  getAccountSyncScope,
  getDeviceId,
  importLocalData,
  readQueuedMutations,
  readSyncCursor,
  syncNow,
  syncVerifiedSession,
  listenForReconnect,
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
const accountScope = getAccountSyncScope(session.userId);

describe('sync queue', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
  });

  it('isolates queue reads and deletes by guest and account scope', async () => {
    const writeScopedMutation = async (scope: SyncScope, mutationId: string) => {
      await writeQueueValue({
        ...sampleMutation(mutationId),
        scope,
        createdAt: '2026-09-12T12:00:00.000Z',
      });
    };

    await writeScopedMutation('guest', 'guest-mutation');
    await writeScopedMutation('account:user-a', 'user-a-mutation');
    await writeScopedMutation('account:user-b', 'user-b-mutation');

    await expect(readQueueValues<{ mutationId: string }>('guest')).resolves.toEqual([
      expect.objectContaining({ mutationId: 'guest-mutation' }),
    ]);
    await expect(readQueueValues<{ mutationId: string }>('account:user-a')).resolves.toEqual([
      expect.objectContaining({ mutationId: 'user-a-mutation' }),
    ]);

    await deleteQueueValue('user-a-mutation', 'account:user-a');

    await expect(readQueueValues<{ mutationId: string }>('account:user-a')).resolves.toEqual([]);
    await expect(readQueueValues<{ mutationId: string }>('account:user-b')).resolves.toEqual([
      expect.objectContaining({ mutationId: 'user-b-mutation' }),
    ]);
  });

  it('keeps cursors independent for two account scopes', async () => {
    const sessionA = { ...session, userId: 'user-a' };
    const sessionB = { ...session, userId: 'user-b' };
    const requestA = vi.fn().mockResolvedValue({ changes: [], nextCursor: 7 });
    const requestB = vi.fn().mockResolvedValue({ changes: [], nextCursor: 3 });

    await syncNow({ session: sessionA, request: requestA });
    await syncNow({ session: sessionB, request: requestB });

    await expect(readSyncCursor(getAccountSyncScope('user-a'))).resolves.toBe(7);
    await expect(readSyncCursor(getAccountSyncScope('user-b'))).resolves.toBe(3);
    expect(requestA).toHaveBeenCalledOnce();
    expect(requestB).toHaveBeenCalledOnce();
  });

  it('shares one in-flight request for concurrent syncs of the same account', async () => {
    let resolveRequest: ((value: SyncChangeSet) => void) | undefined;
    const request = vi.fn(() => new Promise<SyncChangeSet>((resolve) => {
      resolveRequest = resolve;
    }));

    const first = syncNow({ session, request });
    const second = syncNow({ session, request });

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    resolveRequest?.({ changes: [], nextCursor: 4 });
    await Promise.all([first, second]);
  });

  it('runs concurrent syncs for different accounts without sharing responses', async () => {
    const sessionA = { ...session, userId: 'user-a' };
    const sessionB = { ...session, userId: 'user-b' };
    const requestA = vi.fn().mockResolvedValue({
      changes: [{ ...sampleMutation('change-a'), entityId: 'tomato' as const, serverSequence: 1 }],
      nextCursor: 11,
    });
    const requestB = vi.fn().mockResolvedValue({
      changes: [{ ...sampleMutation('change-b'), entityId: 'pasta' as const, serverSequence: 2 }],
      nextCursor: 22,
    });

    await Promise.all([
      syncNow({ session: sessionA, request: requestA }),
      syncNow({ session: sessionB, request: requestB }),
    ]);

    await vi.waitFor(() => {
      expect(requestA).toHaveBeenCalledOnce();
      expect(requestB).toHaveBeenCalledOnce();
    });
    await expect(readSyncCursor(getAccountSyncScope('user-a'))).resolves.toBe(11);
    await expect(readSyncCursor(getAccountSyncScope('user-b'))).resolves.toBe(22);
  });

  it('does not apply or delete a response after the active session changes', async () => {
    await enqueueMutation(accountScope, sampleMutation('pending-mutation'));
    let isCurrent = true;
    const request = vi.fn().mockResolvedValue({
      changes: [{ ...sampleMutation('remote-change'), entityId: 'tomato' as const, serverSequence: 1 }],
      nextCursor: 5,
    });

    const operation = syncNow({
      session,
      request,
      isSessionCurrent: () => isCurrent,
    });
    isCurrent = false;

    await expect(operation).rejects.toMatchObject({ code: 'session_changed' });
    await expect(readQueuedMutations(accountScope)).resolves.toHaveLength(1);
    await expect(readSyncCursor(accountScope)).resolves.toBe(0);
    await expect(readPantrySnapshot()).resolves.toBeNull();
  });

  it('records the initial sync error instead of swallowing it', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(syncVerifiedSession(session, { request })).resolves.toBeNull();

    expect(getSyncStatus(accountScope)).toMatchObject({
      state: 'error',
      error: expect.objectContaining({ message: 'offline' }),
    });
  });

  it('syncs a verified session on reconnect and removes the listener', async () => {
    let currentSession: typeof session | null = session;
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 1 }));
    vi.stubGlobal('fetch', fetch);
    const removeListener = listenForReconnect(() => currentSession);

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    removeListener();
    currentSession = null;
    window.dispatchEvent(new Event('online'));
    expect(fetch).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('creates a device id once without storing account secrets', async () => {
    const first = await getDeviceId();
    const second = await getDeviceId();

    expect(second).toBe(first);
    await expect(readMeta('deviceId')).resolves.toBe(first);
    expect(first).not.toContain('csrf');
  });

  it('queues mutations in timestamp order and remains idempotent by mutation id', async () => {
    await enqueueMutation(accountScope, sampleMutation('mutation-2', '2026-09-12T12:02:00.000Z'));
    await enqueueMutation(accountScope, sampleMutation('mutation-1', '2026-09-12T12:01:00.000Z'));
    await enqueueMutation(accountScope, sampleMutation('mutation-1', '2026-09-12T12:01:00.000Z'));

    expect((await readQueuedMutations(accountScope)).map(({ mutationId }) => mutationId)).toEqual([
      'mutation-1',
      'mutation-2',
    ]);
  });

  it('keeps mutations queued when the sync request fails', async () => {
    await enqueueMutation(accountScope, sampleMutation());
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline'));

    await expect(syncNow({ fetch, session })).rejects.toMatchObject({ code: 'network_error' });
    await expect(readQueuedMutations(accountScope)).resolves.toHaveLength(1);
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
    await enqueueMutation(accountScope, sampleMutation());
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{ ...sampleMutation(), serverSequence: 4 }],
      nextCursor: 4,
    }));

    await syncNow({ fetch, session });

    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-1' }),
    }));
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
    await expect(readSyncCursor(accountScope)).resolves.toBe(4);
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
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
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
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
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
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
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
