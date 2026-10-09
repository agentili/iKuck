import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookEvent, DietProfile, PantryLot, RecipePreference, ShoppingListItem, SyncChangeSet, SyncMutation } from '@ikuck/shared/contracts';
import type { DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import validMutations from '@ikuck/shared/sync-fixtures/valid.json';
import invalidMutations from '@ikuck/shared/sync-fixtures/invalid.json';
import type { ApiRequest } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';
import { useDinnerDiaryStore, waitForPendingDinnerDiaryWrites } from '../store/dinnerDiaryStore';
import { useShoppingListStore, waitForPendingShoppingListWrites } from '../store/shoppingListStore';
import { ApiClientError } from '../api/apiClient';
import * as indexedDb from '../storage/indexedDb';
import {
  deleteLocalDatabase,
  deleteQueueValue,
  readMeta,
  readQueueValues,
  writeMeta,
  writeQueueValue,
  type SyncScope,
} from '../storage/indexedDb';
import { readCookEvents, readRecipePreferences, writeCookEvents, writeRecipePreferences } from '../storage/activityStorage';
import { clearDinnerDiary, readDiaryDraftSets, readDinnerEntries, readSavedRecipes, writeDiaryDraftSets, writeDinnerEntries, writeSavedRecipes } from '../storage/dinnerDiaryStorage';
import { PANTRY_STORAGE_KEY, readPantrySnapshot, writePantrySnapshot } from '../storage/pantryStorage';
import * as pantryStorage from '../storage/pantryStorage';
import * as shoppingStorage from '../storage/shoppingListStorage';
import { readShoppingList, writeShoppingList } from '../storage/shoppingListStorage';
import { readDietProfile, writeDietProfile } from '../storage/dietProfileStorage';
import {
  enqueueMutation,
  clearDataScope,
  GUEST_SYNC_SCOPE,
  getSyncStatus,
  getAccountSyncScope,
  getDeviceId,
  getMutationScope,
  importLocalData,
  initializeSessionScope,
  mergeGuestPantryIntoHouse,
  readQueuedMutations,
  readSyncCursor,
  registerPantrySnapshotListener,
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
import { getActiveDataScope, getPersonalDataScope, setActiveDataScope, setPersonalDataScope } from './scopeContext';
import { isScopeWritable, trackScopedWrite } from './scopeWriteFence';
import { parseSyncMutation } from './validation';

const accountScope = getAccountSyncScope(session.userId);
describe('sync queue', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    window.localStorage.clear();
    setActiveDataScope('guest');
    setPersonalDataScope('guest');
  });

  it('rejects client-authored Dinner provider markers in personal AI consent sync records', () => {
    const mutation = {
      ...sampleMutation('provider-consent'),
      entityType: 'ai_consent' as const,
      entityId: 'profile',
      payload: { enabled: true, dinnerProvider: 'gemini', updatedAt: '2026-09-12T12:00:00.000Z' },
    };

    expect(parseSyncMutation(mutation)).toBeNull();
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

  it('maps every functional entity type to the active House scope while keeping AI consent personal', () => {
    setActiveDataScope('house:house-a');
    setPersonalDataScope('account:user-1');

    expect(getMutationScope('pantry_item')).toBe('house:house-a');
    expect(getMutationScope('pantry_lot')).toBe('house:house-a');
    expect(getMutationScope('staple_preference')).toBe('house:house-a');
    expect(getMutationScope('shopping_list_item')).toBe('house:house-a');
    expect(getMutationScope('cook_event')).toBe('house:house-a');
    expect(getMutationScope('generated_recipe')).toBe('house:house-a');
    expect(getMutationScope('recipe_preference')).toBe('house:house-a');
    expect(getMutationScope('diet_profile')).toBe('house:house-a');
    expect(getMutationScope('dinner_entry')).toBe('house:house-a');
    expect(getMutationScope('saved_recipe')).toBe('house:house-a');
    expect(getMutationScope('ai_consent')).toBe('account:user-1');

    setActiveDataScope('guest');
    expect(getPersonalDataScope()).toBe('guest');
  });

  it('maps diary entities to the active shared scope but supports explicit personal history', () => {
    setActiveDataScope('house:house-a');
    setPersonalDataScope(accountScope);
    expect(getMutationScope('dinner_entry')).toBe('house:house-a');
    expect(getMutationScope('saved_recipe')).toBe('house:house-a');
    expect(getMutationScope('dinner_entry', accountScope, accountScope)).toBe(accountScope);
    setActiveDataScope('guest');
    expect(getMutationScope('saved_recipe')).toBe('guest');
  });

  it('routes diary changes to isolated personal and House collections, upserts validated matching IDs, and applies tombstones', async () => {
    const houseScope = 'house:diary-isolation' as const;
    const entry: DinnerEntry = { id: 'entry-1', date: '2026-09-12', text: 'Cena', servings: 2, note: null, recipes: [], authorId: 'user-1', createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z' };
    const recipe: SavedRecipe = { id: 'recipe-1', title: 'Pasta', description: '', ingredients: [{ name: 'Pasta', amount: '200 g', ingredientId: null, optional: false, provenance: 'provided' }], steps: ['Cuocere'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [], source: 'diary', authorId: 'user-1', createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    await writeDinnerEntries([{ ...entry, id: 'personal-entry' }], accountScope);
    await writeDinnerEntries([{ ...entry, id: 'entry-delete' }, { ...entry, id: 'entry-invalid' }], houseScope);
    await writeSavedRecipes([{ ...recipe, id: 'personal-recipe' }], accountScope);
    await writeSavedRecipes([{ ...recipe, id: 'recipe-invalid' }], houseScope);
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const changes = [
      { ...sampleMutation('account-entry'), entityType: 'dinner_entry' as const, entityId: entry.id, payload: entry, syncScope: 'account:user-1' as const, serverSequence: 1 },
      { ...sampleMutation('house-entry'), entityType: 'dinner_entry' as const, entityId: 'entry-house', payload: { ...entry, id: 'entry-house' }, syncScope: houseScope, serverSequence: 2 },
      { ...sampleMutation('bad-entry'), entityType: 'dinner_entry' as const, entityId: 'entry-invalid', payload: { ...entry, id: 'wrong-id' }, syncScope: houseScope, serverSequence: 3 },
      { ...sampleMutation('account-recipe'), entityType: 'saved_recipe' as const, entityId: recipe.id, payload: recipe, syncScope: 'account:user-1' as const, serverSequence: 4 },
      { ...sampleMutation('house-recipe'), entityType: 'saved_recipe' as const, entityId: 'recipe-house', payload: { ...recipe, id: 'recipe-house' }, syncScope: houseScope, serverSequence: 5 },
      { ...sampleMutation('delete-entry'), entityType: 'dinner_entry' as const, entityId: 'entry-delete', operation: 'delete' as const, payload: null, syncScope: houseScope, serverSequence: 6 },
      { ...sampleMutation('bad-recipe'), entityType: 'saved_recipe' as const, entityId: 'recipe-invalid', payload: { ...recipe, id: 'wrong-recipe-id' }, syncScope: houseScope, serverSequence: 7 },
    ];
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes, nextCursor: 7 }));
    await syncNow({ session, fetch });
    await expect(readDinnerEntries(accountScope)).resolves.toEqual([expect.objectContaining({ id: 'personal-entry' }), entry]);
    await expect(readDinnerEntries(houseScope)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'entry-house' }),
      expect.objectContaining({ id: 'entry-invalid' }),
    ]));
    await expect(readSavedRecipes(accountScope)).resolves.toEqual([expect.objectContaining({ id: 'personal-recipe' }), recipe]);
    await expect(readSavedRecipes(houseScope)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'recipe-house' }),
      expect.objectContaining({ id: 'recipe-invalid' }),
    ]));
    await clearDinnerDiary(houseScope);
    setActiveDataScope('guest');
  });

  it('clears only the revoked diary scope while preserving the account namespace', async () => {
    const houseScope = 'house:revoked-diary' as const;
    const entry: DinnerEntry = { id: 'entry-house', date: '2026-09-12', text: 'Casa', servings: null, note: null, recipes: [], authorId: 'user-1', createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z' };
    const personalEntry = { ...entry, id: 'entry-personal', text: 'Personale' };
    const recipe: SavedRecipe = { id: 'recipe-house', title: 'Pasta', description: '', ingredients: [{ name: 'Pasta', amount: '', ingredientId: null, optional: false, provenance: 'provided' }], steps: ['Cuocere'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [], source: 'diary', authorId: 'user-1', createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    const personalRecipe = { ...recipe, id: 'recipe-personal', title: 'Riso' };
    await writeDinnerEntries([entry], houseScope);
    await writeDinnerEntries([personalEntry], accountScope);
    await writeSavedRecipes([recipe], houseScope);
    await writeSavedRecipes([personalRecipe], accountScope);

    await clearDataScope(houseScope);

    await expect(readDinnerEntries(houseScope)).resolves.toEqual([]);
    await expect(readSavedRecipes(houseScope)).resolves.toEqual([]);
    await expect(readDinnerEntries(accountScope)).resolves.toEqual([personalEntry]);
    await expect(readSavedRecipes(accountScope)).resolves.toEqual([personalRecipe]);
  });

  it('purges a revoked house diet profile while preserving account diet data', async () => {
    const staleScope = 'house:revoked-diet' as const;
    const accountProfile: DietProfile = {
      diet: 'vegan', excludedAllergens: ['milk'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      updatedAt: '2026-09-12T12:00:00.000Z',
    };
    const sharedProfile: DietProfile = { ...accountProfile, diet: 'vegetarian', excludedAllergens: ['fish'] };
    await writeDietProfile(accountProfile, accountScope);
    await writeDietProfile(sharedProfile, staleScope);

    await clearDataScope(staleScope);

    await expect(readDietProfile(staleScope)).resolves.toMatchObject({ diet: 'omnivore', excludedAllergens: [] });
    await expect(readDietProfile(accountScope)).resolves.toEqual(accountProfile);
  });

  it('accepts valid contract fixtures and rejects invalid mutations before enqueue', async () => {
    for (const mutation of validMutations) {
      await expect(enqueueMutation(accountScope, mutation as SyncMutation)).resolves.toBeUndefined();
    }

    for (const mutation of invalidMutations) {
      await expect(enqueueMutation(accountScope, mutation as SyncMutation)).rejects.toMatchObject({
        code: 'INVALID_SYNC_MUTATION',
      });
    }
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

  it('keeps house and account cursors independent across joining and leaving', async () => {
    const houseScope = 'house:cursor-house' as const;
    const accountRequest = vi.fn().mockResolvedValue({ changes: [], nextCursor: 7 });
    await syncNow({ session, request: accountRequest });
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const houseRequest = vi.fn().mockResolvedValue({ changes: [], nextCursor: 12 });

    await syncNow({ session, request: houseRequest });

    await expect(readSyncCursor(houseScope)).resolves.toBe(12);
    await expect(readSyncCursor(accountScope)).resolves.toBe(7);
    setActiveDataScope(accountScope);
    const afterLeave = vi.fn().mockResolvedValue({ changes: [], nextCursor: 8 });
    await syncNow({ session, request: afterLeave });
    expect(afterLeave.mock.calls[0]?.[1]).toMatchObject({ body: expect.objectContaining({ cursor: 7, syncScope: accountScope }) });
    await expect(readSyncCursor(accountScope)).resolves.toBe(8);
  });
  it('shares one in-flight request for concurrent syncs of the same account', async () => {
    let resolveRequest: ((value: SyncChangeSet) => void) | undefined;
    const requestMock = vi.fn(async () => new Promise<SyncChangeSet>((resolve) => {
      resolveRequest = resolve;
    }));
    const request = requestMock as unknown as ApiRequest;

    const first = syncNow({ session, request });
    const second = syncNow({ session, request });

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce());
    resolveRequest?.({ changes: [], nextCursor: 4 });
    await Promise.all([first, second]);
  });

  it('does not reuse an in-flight sync after the same account changes session', async () => {
    let currentToken = session.csrfToken;
    let resolveOld: ((value: SyncChangeSet) => void) | undefined;
    const oldRequest = vi.fn(async () => new Promise<SyncChangeSet>((resolve) => { resolveOld = resolve; }));
    const oldSync = syncNow({ session, request: oldRequest as ApiRequest, isSessionCurrent: () => currentToken === session.csrfToken });
    await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledOnce());
    currentToken = 'new-session-token';
    const freshSession = { ...session, csrfToken: currentToken };
    const freshRequest = vi.fn(async () => ({ changes: [], nextCursor: 1 }));
    const freshSync = syncNow({ session: freshSession, request: freshRequest as ApiRequest, isSessionCurrent: () => currentToken === freshSession.csrfToken });
    await vi.waitFor(() => expect(freshRequest).toHaveBeenCalledOnce());
    resolveOld?.({ changes: [], nextCursor: 2 });
    await expect(oldSync).rejects.toMatchObject({ code: 'session_changed' });
    await expect(freshSync).resolves.toMatchObject({ complete: true });
    await expect(readSyncCursor(accountScope)).resolves.toBe(1);
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

  it('applies shopping, cooking, and pantry changes to their server-authoritative scopes', async () => {
    const houseScope = 'house:scope-isolation' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const shoppingItem: ShoppingListItem = {
      id: 'shopping-personal', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
    };
    const cookEvent: CookEvent = {
      id: 'cook-personal', recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 2,
      cookedAt: '2026-09-12T12:00:00.000Z', note: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
    };
    const request = vi.fn().mockResolvedValue({
      changes: [
        { ...sampleMutation('house-shopping'), entityType: 'shopping_list_item', entityId: shoppingItem.id, payload: shoppingItem, syncScope: houseScope, serverSequence: 1 },
        { ...sampleMutation('house-cook'), entityType: 'cook_event', entityId: cookEvent.id, payload: cookEvent, syncScope: houseScope, serverSequence: 2 },
      ],
      nextCursor: 2,
    });

    await syncNow({ session, request });

    await expect(readShoppingList(houseScope)).resolves.toEqual([shoppingItem]);
    await expect(readShoppingList(accountScope)).resolves.toEqual([]);
    await expect(readCookEvents(houseScope)).resolves.toEqual([cookEvent]);
    await expect(readCookEvents(accountScope)).resolves.toEqual([]);
    setActiveDataScope('guest');
  });

  it('applies the shared diet profile only to the active house namespace', async () => {
    const houseScope = 'house:shared-diet' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const profile: DietProfile = {
      diet: 'vegetarian', excludedAllergens: ['fish'],
      nutrition: { maxCaloriesPerServing: 700, minProteinGramsPerServing: 20 },
      updatedAt: '2026-09-12T12:00:00.000Z',
    };
    const request = vi.fn().mockResolvedValue({
      changes: [{ ...sampleMutation('shared-diet'), entityType: 'diet_profile', entityId: 'profile', payload: profile, syncScope: houseScope, serverSequence: 1 }],
      nextCursor: 1,
    });

    await syncNow({ session, request });

    await expect(readDietProfile(houseScope)).resolves.toEqual(profile);
    await expect(readDietProfile(accountScope)).resolves.toMatchObject({ diet: 'omnivore', excludedAllergens: [] });
    setActiveDataScope('guest');
  });

  it('rejects foreign-house changes before writing snapshots, acknowledging queues, or advancing cursors', async () => {
    const houseScope = 'house:own-home' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const shoppingItem: ShoppingListItem = {
      id: 'foreign-item', ingredientId: 'pasta', label: 'Not ours', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
    };
    await enqueueMutation(houseScope, sampleMutation('unsent-house'));
    const request = vi.fn().mockResolvedValue({
      changes: [{ ...sampleMutation('foreign-change'), entityType: 'shopping_list_item', entityId: shoppingItem.id, payload: shoppingItem, syncScope: 'house:foreign-home', serverSequence: 1 }],
      nextCursor: 1,
    });

    await expect(syncNow({ session, request })).rejects.toMatchObject({ code: 'invalid_response_scope' });
    await expect(readShoppingList(houseScope)).resolves.toEqual([]);
    await expect(readQueuedMutations(houseScope)).resolves.toHaveLength(1);
    await expect(readSyncCursor(houseScope)).resolves.toBe(0);
    setActiveDataScope('guest');
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

  it('does not apply or advance a response after the active data scope changes', async () => {
    const firstScope = 'house:inflight-a' as const;
    const secondScope = 'house:inflight-b' as const;
    setActiveDataScope(firstScope);
    let resolveRequest: ((value: SyncChangeSet) => void) | undefined;
    const request = vi.fn(async () => new Promise<SyncChangeSet>((resolve) => {
      resolveRequest = resolve;
    }));
    const operation = syncNow({ session, request: request as unknown as ApiRequest });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    setActiveDataScope(secondScope);
    resolveRequest?.({
      changes: [{ ...sampleMutation('scope-change'), entityId: 'scope-item', serverSequence: 3 }],
      nextCursor: 3,
    });

    await expect(operation).rejects.toMatchObject({ code: 'scope_changed' });
    await expect(readSyncCursor(firstScope)).resolves.toBe(0);
    await expect(readSyncCursor(secondScope)).resolves.toBe(0);
    await expect(readPantrySnapshot(secondScope)).resolves.toBeNull();
    setActiveDataScope('guest');
  });
  it('records the initial sync error instead of swallowing it', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(syncVerifiedSession(session, { request })).resolves.toBeNull();

    expect(getSyncStatus(accountScope)).toMatchObject({
      state: 'error',
      error: expect.objectContaining({ message: 'offline' }),
    });
  });

  it('blocks House access as soon as an authoritative departure starts draining writes', async () => {
    const houseScope = 'house:departure-in-flight' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    let releaseWrite: (() => void) | undefined;
    const heldWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const pending = trackScopedWrite(houseScope, () => heldWrite);
    const request = vi.fn().mockResolvedValue(null) as ApiRequest;
    try {
      const initialization = initializeSessionScope(session, request);
      await vi.waitFor(() => expect(isScopeWritable(houseScope)).toBe(false));
      // The personal scope must not activate before the departed House is purged.
      expect(getActiveDataScope()).toBe(houseScope);
      releaseWrite?.();
      await initialization;
      expect(getActiveDataScope()).toBe(accountScope);
    } finally {
      releaseWrite?.();
      await pending;
      setActiveDataScope('guest');
    }
  });

  it('retries an incomplete House purge before reactivating the same membership', async () => {
    const houseScope = 'house:failed-departure' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    await enqueueMutation(houseScope, sampleMutation('obsolete-house-write'));
    await writeMeta(`syncCursor:${houseScope}`, 7);
    const failure = new Error('IndexedDB delete failed');
    const deletion = vi.spyOn(indexedDb, 'deleteKeyValue').mockRejectedValue(failure);
    try {
      await expect(initializeSessionScope(session, vi.fn().mockResolvedValue(null))).rejects.toThrow(failure);
      expect(isScopeWritable(houseScope)).toBe(false);
      await expect(readQueuedMutations(houseScope)).resolves.toHaveLength(1);
      await expect(readSyncCursor(houseScope)).resolves.toBe(7);
    } finally {
      deletion.mockRestore();
    }
    expect(window.localStorage.getItem(`ikuck:pending-house-purge:${houseScope}`)).toBe('1');
    // A later authoritative membership must not reactivate the old queue.
    setActiveDataScope(accountScope);
    const state = {
      house: { id: 'failed-departure', name: 'Casa', createdAt: '2026-09-30T10:00:00.000Z' },
      membership: { role: 'member' as const, joinedAt: '2026-09-30T10:00:00.000Z' }, members: [],
    };
    await initializeSessionScope(session, vi.fn().mockResolvedValue(state));
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
    await expect(readSyncCursor(houseScope)).resolves.toBe(0);
    expect(getActiveDataScope()).toBe(houseScope);
  });

  it('keeps a revoked House hidden and its queue fenced when purge fails after a membership error', async () => {
    const houseScope = 'house:failed-sync-revocation' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    await enqueueMutation(houseScope, sampleMutation('unsent-revoked-write'));
    await writeMeta(`syncCursor:${houseScope}`, 9);
    const deletion = vi.spyOn(indexedDb, 'deleteKeyValue').mockRejectedValue(new Error('persistent delete failure'));
    const onMembershipLost = vi.fn();
    const request = vi.fn().mockRejectedValue(new ApiClientError(403, 'house_membership_required', 'Membership ended'));
    try {
      await expect(syncVerifiedSession(session, { request, onMembershipLost })).resolves.toBeNull();
      expect(getActiveDataScope()).toBe(houseScope);
      expect(isScopeWritable(houseScope)).toBe(false);
      expect(onMembershipLost).not.toHaveBeenCalled();
      expect(getSyncStatus(accountScope)).toMatchObject({ state: 'error', error: expect.objectContaining({ message: 'persistent delete failure' }) });
      await expect(readQueuedMutations(houseScope)).resolves.toHaveLength(1);
    } finally {
      deletion.mockRestore();
    }
    await initializeSessionScope(session, vi.fn().mockResolvedValue(null));
    expect(getActiveDataScope()).toBe(accountScope);
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
    await expect(readSyncCursor(houseScope)).resolves.toBe(0);
  });

  it('purges the stale house scope and switches to the account after membership loss during sync', async () => {
    const staleScope = 'house:removed-house' as const;
    setActiveDataScope(staleScope);
    setPersonalDataScope(accountScope);
    await writePantrySnapshot({
      pantryItems: [{ id: 'stale', label: 'Stale', known: true }],
      stapleIds: ['salt'],
      pantryLots: [],
    }, staleScope);
    await writeQueueValue({ ...sampleMutation('stale-house-mutation'), scope: staleScope });
    await writeMeta(`syncCursor:${staleScope}`, 42);
    const request = vi.fn().mockRejectedValue(new ApiClientError(403, 'house_membership_required', 'House membership is required for shared data'));
    const onMembershipLost = vi.fn();

    await expect(syncVerifiedSession(session, { request, onMembershipLost })).resolves.toBeNull();

    expect(getActiveDataScope()).toBe(accountScope);
    expect(getPersonalDataScope()).toBe(accountScope);
    expect(onMembershipLost).toHaveBeenCalledOnce();
    await expect(readPantrySnapshot(staleScope)).resolves.toBeNull();
    await expect(readQueuedMutations(staleScope)).resolves.toEqual([]);
    await expect(readSyncCursor(staleScope)).resolves.toBe(0);
  });

  it('does not purge or switch the new account after an old session gets a late membership error', async () => {
    const oldScope = 'house:old-session-home' as const;
    const newScope = 'house:new-session-home' as const;
    setActiveDataScope(oldScope);
    setPersonalDataScope(accountScope);
    await enqueueMutation(oldScope, sampleMutation('old-unsent'));
    let rejectRequest: ((error: Error) => void) | undefined;
    const request = vi.fn(() => new Promise<SyncChangeSet>((_resolve, reject) => { rejectRequest = reject; }));
    let current = true;
    const onMembershipLost = vi.fn();
    const pending = syncVerifiedSession(session, {
      request: request as unknown as ApiRequest,
      isSessionCurrent: () => current,
      onMembershipLost,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    current = false;
    setActiveDataScope(newScope);
    setPersonalDataScope('account:user-2');
    rejectRequest?.(new ApiClientError(403, 'house_membership_required', 'Old session lost access'));

    await expect(pending).resolves.toBeNull();
    expect(getActiveDataScope()).toBe(newScope);
    expect(getPersonalDataScope()).toBe('account:user-2');
    expect(onMembershipLost).not.toHaveBeenCalled();
    await expect(readQueuedMutations(oldScope)).resolves.toEqual([expect.objectContaining({ mutationId: 'old-unsent' })]);
  });

  it('does not revoke a shared scope for a late reconnect error from the previous session', async () => {
    const houseScope = 'house:reconnect-session' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    await enqueueMutation(houseScope, sampleMutation('keep-house-mutation'));
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    vi.stubGlobal('fetch', fetch);
    let currentSession = session;
    const removeListener = listenForReconnect(() => currentSession);
    try {
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      currentSession = { ...session, userId: 'user-2', csrfToken: 'csrf-2' };
      resolveRequest?.(new Response(JSON.stringify({ code: 'house_membership_required', message: 'Old account lost access' }), { status: 403 }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(readQueuedMutations(houseScope)).resolves.toHaveLength(1);
      expect(getActiveDataScope()).toBe(houseScope);
      expect(getPersonalDataScope()).toBe(accountScope);
    } finally { removeListener(); vi.unstubAllGlobals(); setActiveDataScope('guest'); }
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

  it('drains all queued mutations in bounded batches and reports the counts', async () => {
    for (let index = 0; index < 201; index += 1) {
      await enqueueMutation(accountScope, sampleMutation(`mutation-${index}`));
    }
    let nextCursor = 0;
    const request = vi.fn().mockImplementation(() => ({ changes: [], nextCursor: ++nextCursor }));

    await expect(syncNow({ session, request })).resolves.toMatchObject({
      uploaded: 201,
      downloaded: 0,
      pending: 0,
      complete: true,
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([, options]) => (
      (options?.body as { mutations: unknown[] }).mutations.length
    ))).toEqual([100, 100, 1]);
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
  });

  it('drains multiple server change pages until the cursor is complete', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      ...sampleMutation(`change-${index}`),
      entityType: 'staple_preference' as const,
      entityId: `staple-${index}`,
      payload: { enabled: true },
      serverSequence: index + 1,
    }));
    const secondPage = [{
      ...sampleMutation('change-last'),
      entityType: 'staple_preference' as const,
      entityId: 'staple-last',
      payload: { enabled: true },
      serverSequence: 201,
    }];
    const request = vi.fn()
      .mockResolvedValueOnce({ changes: firstPage, nextCursor: 200 })
      .mockResolvedValueOnce({ changes: secondPage, nextCursor: 201 });

    await expect(syncNow({ session, request })).resolves.toMatchObject({
      uploaded: 0,
      downloaded: 201,
      pending: 0,
      complete: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(readSyncCursor(accountScope)).resolves.toBe(201);
  });

  it('rejects with a typed error when a non-empty page does not advance the cursor', async () => {
    const request = vi.fn().mockResolvedValue({
      changes: [{ ...sampleMutation('change-stalled'), serverSequence: 1 }],
      nextCursor: 0,
    });

    await expect(syncNow({ session, request })).rejects.toMatchObject({ code: 'cursor_stalled' });
  });

  it('never uploads guest mutations during an account sync', async () => {
    await enqueueMutation(GUEST_SYNC_SCOPE, sampleMutation('guest-only-mutation'));
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void input;
      void init;
      return responseFor({ changes: [], nextCursor: 0 });
    });

    await syncNow({ fetch, session });

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).mutations).toEqual([]);
    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toHaveLength(1);
  });

  it('uploads and removes house-scoped pantry mutations during an account sync', async () => {
    const houseScope = 'house:house-a' as const;
    setActiveDataScope(houseScope);
    await enqueueMutation(houseScope, sampleMutation('house-mutation'));
    const request = vi.fn().mockResolvedValue({ changes: [], nextCursor: 1 });

    await syncNow({ session, request });

    expect(request).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({
      body: expect.objectContaining({ mutations: [expect.objectContaining({ mutationId: 'house-mutation' })] }),
    }));
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
    setActiveDataScope('guest');
  });

  it('uploads the guest pantry once to the house and clears local guest data only after success', async () => {
    setActiveDataScope('guest');
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
      pantryLots: [],
    });
    await enqueueMutation(GUEST_SYNC_SCOPE, sampleMutation('guest-pending'));
    const request = vi.fn().mockResolvedValue({
      summary: { addedLots: 1, mergedLots: 0, mergedGroups: 0, importedStaples: 1 },
    });

    await expect(mergeGuestPantryIntoHouse(session, 'house-a', request)).resolves.toEqual({
      addedLots: 1,
      mergedLots: 0,
      mergedGroups: 0,
      importedStaples: 1,
    });

    const body = request.mock.calls[0]?.[1]?.body as { deviceId: string; lots: unknown[]; stapleIds: string[] };
    expect(body).toMatchObject({ lots: expect.arrayContaining([expect.objectContaining({ id: 'pasta' })]), stapleIds: ['salt'] });
    await expect(readPantrySnapshot()).resolves.toBeNull();
    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toEqual([]);
  });

  it.each(['indexed-db', 'localStorage'] as const)(
    'clears an acknowledged legacy guest pantry from %s before a retry can re-import it',
    async (source) => {
      const state = {
        state: {
          pantryItems: [{ id: 'legacy-tomato', label: 'Pomodoro legacy', known: true }],
          stapleIds: ['salt'],
        },
        version: 1,
      };
      if (source === 'indexed-db') {
        await indexedDb.writeKeyValue('pantry', JSON.stringify({ ...state, revision: 42 }));
      }
      window.localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(state));

      const requestMock = vi.fn(async (path: string, options: unknown) => {
        expect(path).toBe('/v1/house/pantry/merge');
        expect(options).toMatchObject({ method: 'POST' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { summary: { addedLots: 1, mergedLots: 0, mergedGroups: 0, importedStaples: 1 } };
      });
      const request = requestMock as unknown as ApiRequest;

      await mergeGuestPantryIntoHouse(session, 'house-a', request);

      const firstBody = (requestMock.mock.calls[0]?.[1] as { body: { lots: unknown[]; stapleIds: string[] } }).body;
      expect(firstBody.lots).toHaveLength(1);
      expect(firstBody.stapleIds).toEqual(['salt']);
      await expect(indexedDb.readKeyValue('pantry')).resolves.toBeNull();
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem('iricetto-pantry-v1')).toBeNull();

      await mergeGuestPantryIntoHouse(session, 'house-a', request);

      expect(requestMock).toHaveBeenCalledTimes(2);
      expect((requestMock.mock.calls[1]?.[1] as { body: { lots: unknown[]; stapleIds: string[] } }).body)
        .toMatchObject({ lots: [], stapleIds: [] });
      await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toBeNull();
    },
  );

  it('preserves a guest pantry write that races with clearing an acknowledged legacy import', async () => {
    const raw = JSON.stringify({
      state: {
        pantryItems: [{ id: 'legacy-tomato', label: 'Pomodoro legacy', known: true }],
        stapleIds: [],
      },
      version: 1,
      revision: 42,
    });
    await indexedDb.writeKeyValue('pantry', raw);
    const actualClear = pantryStorage.clearPantrySnapshot;
    const clear = vi.spyOn(pantryStorage, 'clearPantrySnapshot').mockImplementation(async (scope, expectedSnapshot) => {
      await writePantrySnapshot({
        pantryItems: [{ id: 'concurrent-rice', label: 'Riso aggiunto dopo', known: true }],
        stapleIds: [],
        pantryLots: [],
      }, scope);
      return actualClear(scope, expectedSnapshot);
    });
    const requestMock = vi.fn(async (path: string, options: unknown) => {
      expect(path).toBe('/v1/house/pantry/merge');
      expect(options).toMatchObject({ method: 'POST' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { summary: { addedLots: 1, mergedLots: 0, mergedGroups: 0, importedStaples: 0 } };
    });

    try {
      await mergeGuestPantryIntoHouse(session, 'house-a', requestMock as unknown as ApiRequest);

      await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toMatchObject({
        pantryItems: [{ id: 'concurrent-rice' }],
      });
      await expect(indexedDb.readKeyValue<string>('pantry')).resolves.not.toBeNull();
    } finally {
      clear.mockRestore();
    }
  });

  it('preserves pantry edits made after import comparison and before clearing guest data', async () => {
    setActiveDataScope('guest');
    await writePantrySnapshot({
      pantryItems: [{ id: 'submitted-copy', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [],
    });
    const actualClear = pantryStorage.clearPantrySnapshot;
    const clear = vi.spyOn(pantryStorage, 'clearPantrySnapshot').mockImplementation(async (scope, expectedSnapshot) => {
      await writePantrySnapshot({
        pantryItems: [{ id: 'concurrent-copy', label: 'Modifica concorrente', known: true }],
        stapleIds: [],
        pantryLots: [],
      }, scope);
      return actualClear(scope, expectedSnapshot);
    });
    const request = vi.fn().mockResolvedValue({
      summary: { addedLots: 1, mergedLots: 0, mergedGroups: 0, importedStaples: 0 },
    });

    try {
      await mergeGuestPantryIntoHouse(session, 'house-a', request);
      await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toMatchObject({
        pantryItems: [{ id: 'concurrent-copy' }],
      });
    } finally {
      clear.mockRestore();
    }
  });

  it('does not treat a client-shaped merge tombstone as preserving pantry lots', async () => {
    const houseScope = 'house:forged-tombstone' as const;
    setActiveDataScope(houseScope);
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [{
        id: 'canonical-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g', expiresAt: null,
        createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:02:00.000Z',
      }],
    }, houseScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{
        ...sampleMutation('house-pantry-merge:delete:pantry_item:pasta'), entityType: 'pantry_item', entityId: 'pasta', operation: 'delete', payload: null,
        syncScope: houseScope, serverSequence: 1,
      }],
      nextCursor: 1,
    }));

    await syncNow({ session, fetch });

    await expect(readPantrySnapshot(houseScope)).resolves.toMatchObject({ pantryLots: [] });
    setActiveDataScope('guest');
  });

  it('preserves guest data created while a pantry merge request is pending', async () => {
    setActiveDataScope('guest');
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [],
    });
    await enqueueMutation(GUEST_SYNC_SCOPE, sampleMutation('guest-before-merge'));
    const request = vi.fn(async () => {
      await enqueueMutation(GUEST_SYNC_SCOPE, sampleMutation('guest-during-merge'));
      return { summary: { addedLots: 0, mergedLots: 0, mergedGroups: 0, importedStaples: 0 } };
    });

    await mergeGuestPantryIntoHouse(session, 'house-a', request as unknown as ApiRequest);

    await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.not.toBeNull();
    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toEqual([
      expect.objectContaining({ mutationId: 'guest-during-merge' }),
    ]);
  });

  it('keeps guest pantry private during House bootstrap until an explicit import', async () => {
    const guestLot: PantryLot = {
      id: 'private-guest-lot', ingredientId: 'pasta', label: 'Pasta ospite', known: true,
      quantity: 200, unit: 'g', expiresAt: null,
      createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
    };
    await writePantrySnapshot({ pantryItems: [{ id: 'pasta', label: 'Pasta ospite', known: true }], stapleIds: [], pantryLots: [guestLot] }, GUEST_SYNC_SCOPE);
    const houseState = { house: { id: 'private-house', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' }, membership: { role: 'member' as const, joinedAt: '2026-09-24T00:00:00.000Z' }, members: [] };
    const request = vi.fn().mockResolvedValue(houseState);

    await initializeSessionScope(session, request);

    expect(request).toHaveBeenCalledExactlyOnceWith('/v1/house');
    expect(getActiveDataScope()).toBe('house:private-house');
    await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toMatchObject({ pantryLots: [guestLot] });
    await expect(readPantrySnapshot('house:private-house')).resolves.toBeNull();
  });

  it('activates the personal account scope and clears stale house state after access is lost', async () => {
    const staleScope = 'house:stale-house' as const;
    setActiveDataScope(staleScope);
    await writePantrySnapshot({
      pantryItems: [{ id: 'stale', label: 'Stale', known: true }],
      stapleIds: ['salt'],
      pantryLots: [],
    }, staleScope);
    await writeQueueValue({ ...sampleMutation('stale-house-mutation'), scope: staleScope });
    await writeMeta(`syncCursor:${staleScope}`, 42);
    const request = vi.fn().mockResolvedValue(null);

    await initializeSessionScope(session, request);

    expect(getActiveDataScope()).toBe('account:user-1');
    expect(getPersonalDataScope()).toBe('account:user-1');
    await expect(readPantrySnapshot(staleScope)).resolves.toBeNull();
    await expect(readQueuedMutations(staleScope)).resolves.toEqual([]);
    await expect(readSyncCursor(staleScope)).resolves.toBe(0);
  });

  it('fences house writes and stops an in-flight sync until membership is confirmed again', async () => {
    const houseScope = 'house:uncertain-membership' as const;
    const accountSnapshot = {
      pantryItems: [{ id: 'personal-pasta', label: 'Pasta personale', known: true }],
      stapleIds: ['salt'],
      pantryLots: [],
    };
    const houseSnapshot = {
      pantryItems: [{ id: 'shared-tomato', label: 'Pomodoro condiviso', known: true }],
      stapleIds: ['olive-oil'],
      pantryLots: [],
    };
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    await writePantrySnapshot(accountSnapshot, accountScope);
    await writePantrySnapshot(houseSnapshot, houseScope);
    await enqueueMutation(houseScope, sampleMutation('house-pending-before-uncertainty'));
    await writeMeta(`syncCursor:${houseScope}`, 7);

    let resolveSync: ((response: SyncChangeSet) => void) | undefined;
    const syncRequest = vi.fn(() => new Promise<SyncChangeSet>((resolve) => { resolveSync = resolve; }));
    const synchronizing = syncNow({ session, request: syncRequest as ApiRequest });
    try {
      await vi.waitFor(() => expect(syncRequest).toHaveBeenCalledOnce());
      await expect(initializeSessionScope(
        session,
        vi.fn().mockRejectedValue(new ApiClientError(0, 'network_error', 'House lookup unavailable')) as ApiRequest,
      )).rejects.toMatchObject({ code: 'network_error' });

      expect(isScopeWritable(houseScope)).toBe(false);
      await expect(trackScopedWrite(houseScope, async () => undefined)).rejects.toMatchObject({ code: 'scope_unverified' });
      await expect(trackScopedWrite(accountScope, async () => 'personal-write')).resolves.toBe('personal-write');
      expect(getActiveDataScope()).toBe(houseScope);
      expect(window.localStorage.getItem(`ikuck:pending-house-purge:${houseScope}`)).toBeNull();
      await expect(readPantrySnapshot(accountScope)).resolves.toMatchObject({ pantryItems: [{ id: 'personal-pasta' }] });

      const syncFailure = expect(synchronizing).rejects.toMatchObject({ code: 'scope_unverified' });
      resolveSync?.({
        changes: [{
          ...sampleMutation('late-house-response'),
          entityId: 'late-house-pasta',
          payload: { id: 'late-house-pasta', label: 'Arrivato dopo', known: true },
          syncScope: houseScope,
          serverSequence: 44,
        }],
        nextCursor: 44,
      });
      await syncFailure;

      await expect(readPantrySnapshot(houseScope)).resolves.toMatchObject({ pantryItems: [{ id: 'shared-tomato' }] });
      await expect(readQueuedMutations(houseScope)).resolves.toEqual([
        expect.objectContaining({ mutationId: 'house-pending-before-uncertainty' }),
      ]);
      await expect(readSyncCursor(houseScope)).resolves.toBe(7);

      const confirmedState = {
        house: { id: 'uncertain-membership', name: 'Casa', createdAt: '2026-10-01T10:00:00.000Z' },
        membership: { role: 'member' as const, joinedAt: '2026-10-01T10:00:00.000Z' },
        members: [],
      };
      await initializeSessionScope(session, vi.fn().mockResolvedValue(confirmedState) as ApiRequest);
      expect(getActiveDataScope()).toBe(houseScope);
      expect(isScopeWritable(houseScope)).toBe(true);
      expect(window.localStorage.getItem(`ikuck:pending-house-purge:${houseScope}`)).toBeNull();
    } finally {
      resolveSync?.({ changes: [], nextCursor: 0 });
      await synchronizing.catch(() => undefined);
      setActiveDataScope('guest');
    }
  });

  it('preserves a known house and unsent offline changes when membership lookup fails', async () => {
    const houseScope = 'house:known-home' as const;
    setPersonalDataScope(accountScope);
    setActiveDataScope(houseScope);
    await writePantrySnapshot({ pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [], pantryLots: [] }, houseScope);
    await enqueueMutation(houseScope, sampleMutation('unsent-house-change'));
    await writeMeta(`syncCursor:${houseScope}`, 7);
    const request = vi.fn().mockRejectedValue(new ApiClientError(0, 'network_error', 'Offline'));

    await expect(initializeSessionScope(session, request)).rejects.toMatchObject({ code: 'network_error' });

    expect(getActiveDataScope()).toBe(houseScope);
    expect(getPersonalDataScope()).toBe(accountScope);
    await expect(readPantrySnapshot(houseScope)).resolves.toMatchObject({ pantryItems: [expect.objectContaining({ id: 'pasta' })] });
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([expect.objectContaining({ mutationId: 'unsent-house-change' })]);
    await expect(readSyncCursor(houseScope)).resolves.toBe(7);
  });

  it('keeps another member’s house cache but never exposes it to a newly signed-in account offline', async () => {
    const previousHouse = 'house:prior-user-home' as const;
    setPersonalDataScope('account:prior-user');
    setActiveDataScope(previousHouse);
    await enqueueMutation(previousHouse, sampleMutation('unsent-prior-user-change'));
    const request = vi.fn().mockRejectedValue(new ApiClientError(0, 'network_error', 'Offline'));

    await expect(initializeSessionScope(session, request)).rejects.toMatchObject({ code: 'network_error' });

    expect(getActiveDataScope()).toBe(accountScope);
    expect(getPersonalDataScope()).toBe(accountScope);
    await expect(readQueuedMutations(previousHouse)).resolves.toEqual([expect.objectContaining({ mutationId: 'unsent-prior-user-change' })]);
  });

  it('does not apply a cancelled session scope initialization after an await', async () => {
    let releaseRequest: (() => void) | undefined;
    const pendingRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
    let current = true;
    const request = vi.fn(async () => {
      await pendingRequest;
      return null;
    });
    setActiveDataScope('house:old-house');
    const initialization = initializeSessionScope(session, request as unknown as ApiRequest, () => current);
    current = false;
    setActiveDataScope('account:new-user');
    setPersonalDataScope('account:new-user');
    releaseRequest?.();

    await expect(initialization).rejects.toThrow('cancelled');
    expect(getActiveDataScope()).toBe('account:new-user');
    expect(getPersonalDataScope()).toBe('account:new-user');
  });

  it('activates the house scope after loading authenticated membership without importing guest data', async () => {
    setActiveDataScope('house:stale-house');
    const request = vi.fn().mockResolvedValue({ house: { id: 'house-a', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' }, membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' }, members: [] });

    await initializeSessionScope(session, request);

    expect(request).toHaveBeenCalledExactlyOnceWith('/v1/house');
    expect(getActiveDataScope()).toBe('house:house-a');
    expect(getPersonalDataScope()).toBe('account:user-1');
  });

  it('retains a confirmed house scope when obsolete account cache cleanup fails', async () => {
    const accountScope = getAccountSyncScope(session.userId);
    const houseScope = 'house:cache-failure' as const;
    const clear = vi.spyOn(shoppingStorage, 'clearShoppingList').mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    await expect(initializeSessionScope(session, (async () => ({
      house: { id: 'cache-failure', name: 'Casa', createdAt: '2026-09-24T10:00:00.000Z' },
      membership: { role: 'member', joinedAt: '2026-09-24T10:00:00.000Z' },
      members: [],
    })) as ApiRequest)).rejects.toThrow('IndexedDB unavailable');
    expect(getActiveDataScope()).toBe(houseScope);
    expect(getPersonalDataScope()).toBe(accountScope);
    clear.mockRestore();
  });

  it('does not resurrect account shopping snapshots from store-level writes delayed past house migration', async () => {
    const houseScope = 'house:shopping-in-flight-migration' as const;
    const originalWrite = shoppingStorage.writeShoppingList;
    let releaseWrite: (() => void) | undefined;
    let signalWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const paused = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const spy = vi.spyOn(shoppingStorage, 'writeShoppingList').mockImplementation(async (...args) => {
      if (args[1] === accountScope) { signalWrite?.(); await paused; }
      return originalWrite(...args);
    });
    setActiveDataScope(accountScope);
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
    const itemId = useShoppingListStore.getState().addItem({
      ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null,
    });
    expect(itemId).toBeTruthy();
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      await writeStarted;
      const request = vi.fn().mockResolvedValue({
        house: { id: 'shopping-in-flight-migration', name: 'Casa', createdAt: '2026-09-30T10:00:00.000Z' },
        membership: { role: 'member', joinedAt: '2026-09-30T10:00:00.000Z' }, members: [],
      }) as ApiRequest;
      fallback = setTimeout(() => releaseWrite?.(), 150);
      await initializeSessionScope(session, request);
      await waitForPendingShoppingListWrites();
      await expect(readShoppingList(accountScope)).resolves.toEqual([]);
      await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
      expect(request).toHaveBeenCalledWith('/v1/house/account-queue/import', expect.objectContaining({
        body: { mutations: [expect.objectContaining({ entityType: 'shopping_list_item', entityId: itemId, syncScope: accountScope })] },
      }));
    } finally {
      if (fallback !== undefined) clearTimeout(fallback);
      releaseWrite?.();
      await waitForPendingShoppingListWrites();
      spy.mockRestore();
      setActiveDataScope('guest');
    }
  });

  it('imports a delayed diary mutation into the house instead of leaving it in the obsolete account queue', async () => {
    const houseScope = 'house:diary-in-flight-migration' as const;
    const key = `ikuck:${accountScope}:dinner-entries`;
    const originalWrite = indexedDb.writeKeyValue;
    let releaseWrite: (() => void) | undefined;
    let signalWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const paused = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const spy = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (target, value) => {
      if (target === key) { signalWrite?.(); await paused; }
      return originalWrite(target, value);
    });
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    useAuthStore.setState({ user: { id: session.userId } as never });
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [], recipes: [], drafts: [], error: null });
    const entryId = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Cena', servings: 2, note: null });
    expect(entryId).toBeTruthy();
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      await writeStarted;
      const request = vi.fn().mockResolvedValue({
        house: { id: 'diary-in-flight-migration', name: 'Casa', createdAt: '2026-09-30T10:00:00.000Z' },
        membership: { role: 'member', joinedAt: '2026-09-30T10:00:00.000Z' }, members: [],
      }) as ApiRequest;
      fallback = setTimeout(() => releaseWrite?.(), 150);
      await initializeSessionScope(session, request);
      await waitForPendingDinnerDiaryWrites();
      await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
      await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
      expect(request).toHaveBeenCalledWith('/v1/house/account-queue/import', expect.objectContaining({
        body: { mutations: [expect.objectContaining({ entityType: 'dinner_entry', entityId: entryId, syncScope: accountScope })] },
      }));
      await expect(readDinnerEntries(accountScope)).resolves.toEqual([]);
    } finally {
      if (fallback !== undefined) clearTimeout(fallback);
      releaseWrite?.();
      await waitForPendingDinnerDiaryWrites();
      spy.mockRestore();
      useAuthStore.setState({ user: null });
      setActiveDataScope('guest');
    }
  });

  it('preserves personal local dinner drafts while clearing migrated account snapshots', async () => {
    const houseScope = 'house:keep-private-drafts' as const;
    const updatedAt = '2026-09-30T10:00:00.000Z';
    const entry: DinnerEntry = {
      id: 'account-dinner-with-draft', date: '2026-09-30', text: 'Pasta', servings: null,
      note: null, recipes: [], authorId: session.userId, createdAt: updatedAt, updatedAt,
    };
    const draftSet = {
      entryId: entry.id, entryUpdatedAt: updatedAt,
      drafts: [{
        draftId: 'draft-local-only', title: 'Pasta', description: '',
        ingredients: [{ name: 'Pasta', amount: '', ingredientId: null, optional: false, provenance: 'provided' as const }],
        steps: ['Cuoci la pasta'], servings: null, durationMinutes: null,
        diets: null, allergens: null, suggestedFields: [],
      }],
    };
    await writeDinnerEntries([entry], accountScope);
    await writeDiaryDraftSets([draftSet], accountScope);
    const request = vi.fn().mockResolvedValue({
      house: { id: 'keep-private-drafts', name: 'Casa', createdAt: updatedAt },
      membership: { role: 'member', joinedAt: updatedAt }, members: [],
    }) as ApiRequest;
    await initializeSessionScope(session, request);
    await expect(readDinnerEntries(accountScope)).resolves.toEqual([]);
    await expect(readDiaryDraftSets(accountScope)).resolves.toEqual([draftSet]);
    await expect(readDiaryDraftSets(houseScope)).resolves.toEqual([]);
  });

  it('clears migrated account functional snapshots but preserves consent queue, cursor and guest data', async () => {
    const houseScope = 'house:clean-migrated-account' as const;
    const item: ShoppingListItem = {
      id: 'account-shopping', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
    };
    const entry: DinnerEntry = { id: 'old-dinner', date: '2026-09-12', text: 'Vecchia cena', servings: null, note: null, recipes: [], authorId: session.userId, createdAt: item.createdAt, updatedAt: item.updatedAt };
    await writePantrySnapshot({ pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [], pantryLots: [] }, accountScope);
    await writeShoppingList([item], accountScope);
    await writeDinnerEntries([entry], accountScope);
    await writeDietProfile({ diet: 'vegan', excludedAllergens: ['milk'], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: item.updatedAt }, accountScope);
    await writeShoppingList([item], GUEST_SYNC_SCOPE);
    await writeMeta(`syncCursor:${accountScope}`, 7);
    await enqueueMutation(accountScope, { ...sampleMutation('personal-consent'), entityType: 'ai_consent', entityId: 'profile', payload: { enabled: true, updatedAt: item.updatedAt } });
    setActiveDataScope(accountScope);
    const state = { house: { id: 'clean-migrated-account', name: 'Casa', createdAt: item.createdAt }, membership: { role: 'member' as const, joinedAt: item.createdAt }, members: [] };
    await initializeSessionScope(session, vi.fn().mockResolvedValue(state));

    await expect(readPantrySnapshot(accountScope)).resolves.toBeNull();
    await expect(readShoppingList(accountScope)).resolves.toEqual([]);
    await expect(readDinnerEntries(accountScope)).resolves.toEqual([]);
    await expect(readDietProfile(accountScope)).resolves.toMatchObject({ diet: 'omnivore', excludedAllergens: [] });
    await expect(readShoppingList(GUEST_SYNC_SCOPE)).resolves.toEqual([item]);
    await expect(readSyncCursor(accountScope)).resolves.toBe(7);
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([expect.objectContaining({ entityType: 'ai_consent' })]);
    expect(getActiveDataScope()).toBe(houseScope);
  });

  it('retries a failed account-queue import without acknowledging mutations before server success', async () => {
    const houseScope = 'house:retry-account-queue' as const;
    setActiveDataScope(accountScope);
    const shoppingItem: ShoppingListItem = {
      id: 'retry-shopping', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
    };
    await enqueueMutation(accountScope, {
      ...sampleMutation('retry-pending-shopping'), entityType: 'shopping_list_item', entityId: shoppingItem.id, payload: shoppingItem,
    });
    const houseState = {
      house: { id: 'retry-account-queue', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
      membership: { role: 'member' as const, joinedAt: '2026-09-24T00:00:00.000Z' }, members: [],
    };
    const failure = new Error('temporary import failure');
    const requestMock = vi.fn()
      .mockResolvedValueOnce(houseState)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(houseState)
      .mockResolvedValueOnce(undefined);
    const request = requestMock as ApiRequest;

    await expect(initializeSessionScope(session, request)).rejects.toThrow(failure);
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([
      expect.objectContaining({ mutationId: 'retry-pending-shopping', entityType: 'shopping_list_item' }),
    ]);
    expect(getActiveDataScope()).toBe(houseScope);

    await expect(initializeSessionScope(session, request)).resolves.toMatchObject({ state: houseState });
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
    expect(requestMock.mock.calls.filter(([path]) => path === '/v1/house/account-queue/import')).toHaveLength(2);
  });

  it('imports unsent account mutations through the semantic House migration while keeping AI consent personal', async () => {
    const houseScope = 'house:queued-home' as const;
    setActiveDataScope(accountScope);
    const shoppingItem: ShoppingListItem = {
      id: 'shopping-pending', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
    };
    await enqueueMutation(accountScope, { ...sampleMutation('pending-shopping'), entityType: 'shopping_list_item', entityId: shoppingItem.id, payload: shoppingItem });
    await enqueueMutation(accountScope, { ...sampleMutation('pending-consent'), entityType: 'ai_consent', entityId: 'profile', payload: { enabled: true, updatedAt: '2026-09-12T12:00:00.000Z' } });
    const houseState = { house: { id: 'queued-home', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' }, membership: { role: 'member' as const, joinedAt: '2026-09-24T00:00:00.000Z' }, members: [] };
    const request = vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
      void options;
      return path === '/v1/house' ? houseState : undefined;
    });
    await initializeSessionScope(session, request as ApiRequest);
    await initializeSessionScope(session, request as ApiRequest);

    const imported = request.mock.calls.filter(([path]) => path === '/v1/house/account-queue/import');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.[1]).toMatchObject({ method: 'POST', body: { mutations: [
      expect.objectContaining({ mutationId: 'pending-shopping', entityType: 'shopping_list_item', syncScope: accountScope }),
    ] } });
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([
      expect.objectContaining({ mutationId: 'pending-consent', entityType: 'ai_consent', syncScope: accountScope }),
    ]);
  });

  it('preserves guest pantry and its queue when House bootstrap succeeds without a merge', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    await writePantrySnapshot({
      pantryItems: [{ id: 'local-pasta', label: 'Pasta locale', known: true }],
      stapleIds: [],
      pantryLots: [],
    }, GUEST_SYNC_SCOPE);
    await enqueueMutation(GUEST_SYNC_SCOPE, sampleMutation('guest-merge-pending'));
    const houseState = {
      house: { id: 'house-a', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
      membership: { role: 'member' as const, joinedAt: '2026-09-24T00:00:00.000Z' },
      members: [],
    };
    const request = vi.fn().mockResolvedValue(houseState);

    const initialization = await initializeSessionScope(session, request);

    expect(initialization).toMatchObject({ state: houseState, mergeSummary: null, guestMergeFailed: false });
    expect(request).toHaveBeenCalledExactlyOnceWith('/v1/house');
    expect(getActiveDataScope()).toBe('house:house-a');
    expect(getPersonalDataScope()).toBe(accountScope);
    await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toMatchObject({
      pantryItems: [{ id: 'local-pasta', label: 'Pasta locale', known: true }],
    });
    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toEqual([
      expect.objectContaining({ mutationId: 'guest-merge-pending' }),
    ]);
    await expect(readQueuedMutations('house:house-a')).resolves.toEqual([]);

    const houseLot: PantryLot = {
      id: 'house-lot',
      ingredientId: 'house-pasta',
      label: 'Pasta condivisa',
      known: true,
      quantity: null,
      unit: null,
      expiresAt: null,
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
    };
    const houseChange: SyncChangeSet['changes'][number] = {
      ...sampleMutation('house-pantry-lot'),
      entityType: 'pantry_lot',
      entityId: houseLot.id,
      payload: houseLot,
      syncScope: 'house:house-a',
      serverSequence: 1,
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void init;
      return responseFor({ changes: [houseChange], nextCursor: 1 });
    });

    await syncNow({ session, fetch });

    const sentBody = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      syncScope: string;
      mutations: SyncMutation[];
    };
    expect(sentBody.syncScope).toBe('house:house-a');
    expect(sentBody.mutations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationId: 'guest-merge-pending' }),
    ]));
    await expect(readPantrySnapshot('house:house-a')).resolves.toMatchObject({
      pantryItems: [{ id: 'house-pasta', label: 'Pasta condivisa', known: true }],
    });
    await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toMatchObject({
      pantryItems: [{ id: 'local-pasta', label: 'Pasta locale', known: true }],
    });
    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toEqual([
      expect.objectContaining({ mutationId: 'guest-merge-pending' }),
    ]);
  });

  it('cancels an explicit guest import when the authenticated session changes before a guest read completes', async () => {
    const houseScope = 'house:import-session-race' as const;
    const guestItem: ShoppingListItem = {
      id: 'guest-session-item', ingredientId: 'pasta', label: 'Pasta ospite', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
    };
    await writeShoppingList([guestItem], GUEST_SYNC_SCOPE);
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    let releaseRead: (() => void) | undefined;
    let signalRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const actualRead = indexedDb.readKeyValue;
    const readSpy = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key === 'shopping-list') {
        signalRead?.();
        await heldRead;
      }
      return actualRead(key);
    });
    const request = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', request);
    let currentSession = true;
    try {
      const importing = importLocalData(session, () => currentSession);
      const assertion = expect(importing).rejects.toMatchObject({ code: 'session_changed' });
      await readStarted;
      currentSession = false;
      releaseRead?.();
      await assertion;
      await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
      await expect(readShoppingList(GUEST_SYNC_SCOPE)).resolves.toEqual([guestItem]);
      expect(request).not.toHaveBeenCalled();
    } finally {
      releaseRead?.();
      readSpy.mockRestore();
      vi.unstubAllGlobals();
      setActiveDataScope('guest');
    }
  });

  it('imports guest functional records into an active house, never a stale account or existing house snapshot', async () => {
    const houseScope = 'house:import-home' as const;
    const guestItem: ShoppingListItem = {
      id: 'guest-shopping', ingredientId: 'pasta', label: 'Pasta ospite', quantity: 1, unit: 'pack', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
    };
    await writeShoppingList([guestItem], GUEST_SYNC_SCOPE);
    await writeShoppingList([{ ...guestItem, id: 'already-shared' }], houseScope);
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

    const requests = fetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as {
      syncScope: string; mutations: Array<{ syncScope: string; entityType: string; entityId: string }>;
    });
    const mutations = requests.flatMap((request) => request.mutations);
    expect(mutations).toContainEqual(expect.objectContaining({ entityType: 'shopping_list_item', entityId: guestItem.id, syncScope: houseScope }));
    expect(mutations).not.toContainEqual(expect.objectContaining({ entityId: 'already-shared' }));
    expect(mutations).not.toContainEqual(expect.objectContaining({ syncScope: accountScope }));
    expect(mutations).not.toContainEqual(expect.objectContaining({ entityType: 'diet_profile' }));
    expect(requests.every((request) => request.syncScope === houseScope)).toBe(true);
    await expect(readShoppingList(GUEST_SYNC_SCOPE)).resolves.toEqual([guestItem]);
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it('imports a guest diet profile conservatively through the House import endpoint, not sync LWW', async () => {
    const houseScope = 'house:guest-diet-import' as const;
    const profile: DietProfile = {
      diet: 'omnivore',
      excludedAllergens: [],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      updatedAt: '2026-09-13T10:00:00.000Z',
    };
    await writeDietProfile(profile, GUEST_SYNC_SCOPE);
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/house/diet-profile/import') return new Response(null, { status: 204 });
      void init;
      return responseFor({ changes: [], nextCursor: 0 });
    });
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

    const guestDietImports = fetch.mock.calls.filter(([input]) => input === '/v1/house/diet-profile/import');
    expect(guestDietImports).toHaveLength(1);
    expect(JSON.parse(guestDietImports[0]?.[1]?.body as string)).toMatchObject({
      mutation: { entityType: 'diet_profile', entityId: 'profile', operation: 'upsert', payload: profile },
    });
    const syncMutations = fetch.mock.calls.filter(([input]) => input === '/v1/sync').flatMap(([, init]) =>
      (JSON.parse((init as RequestInit).body as string) as { mutations: SyncMutation[] }).mutations);
    expect(syncMutations).not.toContainEqual(expect.objectContaining({ entityType: 'diet_profile' }));
    await expect(readDietProfile(GUEST_SYNC_SCOPE)).resolves.toEqual(profile);
    vi.unstubAllGlobals();
  });

  it('imports guest dinner entries and saved recipes into the active house', async () => {
    const houseScope = 'house:diary-import' as const;
    const entry: DinnerEntry = {
      id: 'guest-entry', date: '2026-09-12', text: 'Cena ospite', servings: 2, note: null, recipes: [],
      authorId: session.userId, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
    };
    const recipe: SavedRecipe = {
      id: 'guest-recipe', title: 'Pasta', description: '',
      ingredients: [{ name: 'Pasta', amount: '200 g', ingredientId: null, optional: false, provenance: 'provided' }],
      steps: ['Cuocere'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [],
      source: 'diary', authorId: session.userId, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    };
    await writeDinnerEntries([entry], GUEST_SYNC_SCOPE);
    await writeSavedRecipes([recipe], GUEST_SYNC_SCOPE);
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

    const mutations = fetch.mock.calls.flatMap(([, init]) =>
      (JSON.parse((init as RequestInit).body as string) as { mutations: Array<{ entityType: string; entityId: string; syncScope: string }> }).mutations);
    expect(mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'dinner_entry', entityId: entry.id, syncScope: houseScope }),
      expect.objectContaining({ entityType: 'saved_recipe', entityId: recipe.id, syncScope: houseScope }),
    ]));
    await expect(readDinnerEntries(GUEST_SYNC_SCOPE)).resolves.toEqual([entry]);
    vi.unstubAllGlobals();
  });

  it('merges guest pantry semantically rather than uploading lot upserts into an active house', async () => {
    const houseScope = 'house:pantry-import' as const;
    const guestLot: PantryLot = {
      id: 'guest-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 100, unit: 'g', expiresAt: null,
      createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
    };
    await writePantrySnapshot({ pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [], pantryLots: [guestLot] }, GUEST_SYNC_SCOPE);
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/house/pantry/merge') {
        return responseFor({ summary: { addedLots: 1, mergedLots: 0, mergedGroups: 0, importedStaples: 0 } } as never);
      }
      void init;
      return responseFor({ changes: [], nextCursor: 0 });
    });
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

    expect(fetch.mock.calls.some(([input]) => input === '/v1/house/pantry/merge')).toBe(true);
    const syncBodies = fetch.mock.calls.filter(([input]) => input === '/v1/sync').map(([, init]) =>
      JSON.parse((init as RequestInit).body as string) as { mutations: Array<{ entityType: string }> });
    expect(syncBodies.flatMap((body) => body.mutations).some((mutation) => mutation.entityType === 'pantry_lot')).toBe(false);
    await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('imports pantry data into the account scope without deleting the guest data', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
      pantryLots: [],
    }, GUEST_SYNC_SCOPE);
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void input;
      void init;
      return responseFor({ changes: [], nextCursor: 0 });
    });
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { mutations: Array<{ entityType: string; entityId: string }> };
    expect(body.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'pantry_lot', entityId: 'pasta' }),
      expect.objectContaining({ entityType: 'staple_preference', entityId: 'salt' }),
    ]));
    expect(body.mutations).not.toContainEqual(expect.objectContaining({ entityType: 'diet_profile' }));
    await expect(readPantrySnapshot(GUEST_SYNC_SCOPE)).resolves.toMatchObject({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
    });
    await expect(readQueuedMutations(GUEST_SYNC_SCOPE)).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it('uses stable mutation ids when the explicit import is retried', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [],
    }, GUEST_SYNC_SCOPE);
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void input;
      void init;
      return responseFor({ changes: [], nextCursor: 0 });
    });
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);
    await importLocalData(session, () => true);

    const mutationIds = fetch.mock.calls.map(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string) as { mutations: Array<{ mutationId: string }> };
      return body.mutations.map((mutation) => mutation.mutationId);
    });
    expect(new Set(mutationIds[0])).toEqual(new Set(mutationIds[1]));
    vi.unstubAllGlobals();
  });

  it('keeps guest import ids stable for a retry but assigns a new id to an edited revision', async () => {
    const makeItem = (quantity: number, updatedAt: string): ShoppingListItem => ({
      id: 'reimport-shopping', ingredientId: 'pasta', label: 'Pasta', quantity, unit: 'g', note: null,
      purchased: false, sourceRecipeId: null, createdAt: '2026-09-13T10:00:00.000Z', updatedAt,
    });
    const firstRevision = makeItem(1000, '2026-09-13T10:00:00.000Z');
    await writeShoppingList([firstRevision], GUEST_SYNC_SCOPE);
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn().mockImplementation(() => responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);
    await importLocalData(session, () => true);
    const revisedItem = makeItem(2000, '2026-09-13T10:01:00.000Z');
    await writeShoppingList([revisedItem], GUEST_SYNC_SCOPE);
    await importLocalData(session, () => true);

    const imports = fetch.mock.calls.flatMap(([input, init]) => input === '/v1/sync'
      ? (JSON.parse((init as RequestInit).body as string) as { mutations: SyncMutation[] }).mutations
        .filter((mutation) => mutation.entityType === 'shopping_list_item')
      : []);
    expect(imports).toHaveLength(3);
    expect(imports[0]?.mutationId).toBe(imports[1]?.mutationId);
    expect(imports[2]?.mutationId).not.toBe(imports[1]?.mutationId);
    expect(imports[2]?.payload).toMatchObject({ quantity: 2000 });
    const ledger = await readMeta<Record<string, { fingerprint: string; mutationId: string }>>(`importMutationIds:${accountScope}`);
    expect(Object.values(ledger ?? {})).toHaveLength(1);
    expect(Object.values(ledger ?? {})[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
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

  it('discards a house response when the account changes during IndexedDB snapshot hydration', async () => {
    const oldScope = 'house:stale-response' as const;
    setActiveDataScope(oldScope);
    setPersonalDataScope(accountScope);
    let resumeRead: (() => void) | undefined;
    let signalRead: (() => void) | undefined;
    const readBlocked = new Promise<void>((resolve) => { signalRead = resolve; });
    const resume = new Promise<void>((resolve) => { resumeRead = resolve; });
    const actualRead = indexedDb.readKeyValue;
    const readSpy = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key === 'ikuck:house:stale-response:pantry') {
        signalRead?.();
        await resume;
      }
      return actualRead(key);
    });
    const listener = vi.fn();
    const unsubscribe = registerPantrySnapshotListener(listener);
    const change = { ...sampleMutation('old-house-change'), syncScope: oldScope, serverSequence: 1 };
    const request = vi.fn().mockResolvedValue({ changes: [change], nextCursor: 1 });

    try {
      const synchronizing = syncNow({ session, request });
      await readBlocked;
      setActiveDataScope('account:new-person');
      setPersonalDataScope('account:new-person');
      resumeRead?.();
      await expect(synchronizing).rejects.toMatchObject({ code: 'scope_changed' });
      expect(listener).not.toHaveBeenCalled();
      await expect(readPantrySnapshot(oldScope)).resolves.toBeNull();
      await expect(readSyncCursor(oldScope)).resolves.toBe(0);
    } finally {
      resumeRead?.();
      unsubscribe();
      readSpy.mockRestore();
    }
  });

  it('does not resurrect a house sync cursor when purge overlaps its IndexedDB write', async () => {
    const houseScope = 'house:revoked-during-cursor' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const key = `syncCursor:${houseScope}`;
    let releaseWrite: (() => void) | undefined;
    let signalWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const resume = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const actualWrite = indexedDb.writeMeta;
    const actualDelete = indexedDb.deleteMeta;
    const writeSpy = vi.spyOn(indexedDb, 'writeMeta').mockImplementation(async (target, value) => {
      if (target === key) { signalWrite?.(); await resume; }
      return actualWrite(target, value);
    });
    const deleteSpy = vi.spyOn(indexedDb, 'deleteMeta').mockImplementation(async (target) => {
      await actualDelete(target);
      if (target === key) releaseWrite?.();
    });
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      const synchronizing = syncNow({ session, request: vi.fn().mockResolvedValue({ changes: [], nextCursor: 7 }) });
      const rejected = expect(synchronizing).rejects.toMatchObject({ code: 'scope_changed' });
      await writeStarted;
      setActiveDataScope(accountScope);
      const purging = clearDataScope(houseScope);
      fallback = setTimeout(() => releaseWrite?.(), 200);
      await Promise.all([rejected, purging]);
      await expect(readSyncCursor(houseScope)).resolves.toBe(0);
    } finally {
      if (fallback !== undefined) clearTimeout(fallback);
      releaseWrite?.();
      writeSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('does not resurrect a revoked house snapshot when purge races an IndexedDB sync write', async () => {
    const oldScope = 'house:revoked-during-write' as const;
    setActiveDataScope(oldScope);
    setPersonalDataScope(accountScope);
    let releaseWrite: (() => void) | undefined;
    let signalWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const resume = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const actualWrite = indexedDb.writeKeyValue;
    const writeSpy = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === 'ikuck:house:revoked-during-write:pantry') {
        signalWrite?.();
        await resume;
      }
      return actualWrite(key, value);
    });
    const listener = vi.fn();
    const unsubscribe = registerPantrySnapshotListener(listener);
    const request = vi.fn().mockResolvedValue({
      changes: [{ ...sampleMutation('revoked-change'), syncScope: oldScope, serverSequence: 1 }], nextCursor: 1,
    });

    try {
      const synchronizing = syncNow({ session, request });
      const assertion = expect(synchronizing).rejects.toMatchObject({ code: 'scope_changed' });
      await writeStarted;
      setActiveDataScope('account:next-person');
      const purging = clearDataScope(oldScope);
      releaseWrite?.();
      await Promise.all([assertion, purging]);
      expect(listener).not.toHaveBeenCalled();
      await expect(readPantrySnapshot(oldScope)).resolves.toBeNull();
      await expect(readSyncCursor(oldScope)).resolves.toBe(0);
    } finally {
      releaseWrite?.();
      unsubscribe();
      writeSpy.mockRestore();
    }
  });

  it('removes sent mutations, applies server changes and advances the cursor', async () => {
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
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

  it('applies an absorbed-lot tombstone and retains the canonical merged lot offline', async () => {
    const houseScope = 'house:tombstone-house' as const;
    setActiveDataScope(houseScope);
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [
        {
          id: 'lot-a', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 300, unit: 'g', expiresAt: '2026-10-01',
          createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z',
        },
        {
          id: 'lot-b', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 200, unit: 'g', expiresAt: '2026-10-01',
          createdAt: '2026-09-24T10:01:00.000Z', updatedAt: '2026-09-24T10:01:00.000Z',
        },
      ],
    }, houseScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [
        {
          ...sampleMutation('merged-lot'), entityType: 'pantry_lot', entityId: 'lot-a', operation: 'upsert',
          payload: {
            id: 'lot-a', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g', expiresAt: '2026-10-01',
            createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:02:00.000Z',
          }, serverSequence: 4,
        },
        { ...sampleMutation('absorbed-lot'), entityType: 'pantry_lot', entityId: 'lot-b', operation: 'delete', payload: null, serverSequence: 5 },
      ],
      nextCursor: 5,
    }));

    await syncNow({ session, fetch });

    await expect(readPantrySnapshot(houseScope)).resolves.toMatchObject({
      pantryLots: [expect.objectContaining({ id: 'lot-a', quantity: 500 })],
    });
    setActiveDataScope('guest');
  });
  it('removes pantry lots for a normal pantry-item delete', async () => {
    const houseScope = 'house:legacy-delete-house' as const;
    setActiveDataScope(houseScope);
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [{
        id: 'legacy-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 300, unit: 'g', expiresAt: null,
        createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z',
      }],
    }, houseScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{
        ...sampleMutation('legacy-item-delete'), entityType: 'pantry_item', entityId: 'pasta', operation: 'delete', payload: null, serverSequence: 1,
      }],
      nextCursor: 1,
    }));

    await syncNow({ session, fetch });

    await expect(readPantrySnapshot(houseScope)).resolves.toMatchObject({ pantryItems: [], pantryLots: [] });
    setActiveDataScope('guest');
  });

  it('preserves the canonical lot for a merge-generated pantry-item tombstone', async () => {
    const houseScope = 'house:merge-item-tombstone' as const;
    setActiveDataScope(houseScope);
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [{
        id: 'canonical-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g', expiresAt: null,
        createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:02:00.000Z',
      }],
    }, houseScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({
      changes: [{
        ...sampleMutation('house-pantry-merge:pantry_lot:canonical-lot'), entityType: 'pantry_lot', entityId: 'canonical-lot',
        operation: 'upsert', payload: {
          id: 'canonical-lot', ingredientId: 'pasta', label: 'Pasta', known: true, quantity: 500, unit: 'g', expiresAt: null,
          createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:02:00.000Z',
        }, serverSequence: 1,
      },
      {
        ...sampleMutation('house-pantry-merge:delete:pantry_item:pasta'), entityType: 'pantry_item', entityId: 'pasta', operation: 'delete', payload: null,
        deviceId: 'house-pantry-merge', syncScope: houseScope, serverSequence: 2,
      }],
      nextCursor: 2,
    }));

    await syncNow({ session, fetch });

    await expect(readPantrySnapshot(houseScope)).resolves.toMatchObject({
      pantryLots: [expect.objectContaining({ id: 'canonical-lot', quantity: 500 })],
    });
    setActiveDataScope('guest');
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
    await writeShoppingList([item], GUEST_SYNC_SCOPE);
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

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
    await writeCookEvents([event], GUEST_SYNC_SCOPE);
    await writeRecipePreferences([preference], GUEST_SYNC_SCOPE);
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

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
    await writeDietProfile(profile, GUEST_SYNC_SCOPE);
    setActiveDataScope(accountScope);
    setPersonalDataScope(accountScope);
    const fetch = vi.fn().mockResolvedValue(responseFor({ changes: [], nextCursor: 0 }));
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session, () => true);

    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({ body: expect.stringContaining('diet_profile') }));
    vi.unstubAllGlobals();
  });
});
