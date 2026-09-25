import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookEvent, DietProfile, PantryLot, RecipePreference, ShoppingListItem, SyncChangeSet, SyncMutation } from '@ikuck/shared/contracts';
import validMutations from '@ikuck/shared/sync-fixtures/valid.json';
import invalidMutations from '@ikuck/shared/sync-fixtures/invalid.json';
import type { ApiRequest } from '../api/apiClient';
import { ApiClientError } from '../api/apiClient';
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
import { readPantrySnapshot, writePantrySnapshot } from '../storage/pantryStorage';
import { readShoppingList, writeShoppingList } from '../storage/shoppingListStorage';
import { readDietProfile, writeDietProfile } from '../storage/dietProfileStorage';
import {
  enqueueMutation,
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

  it('maps shared and personal entity types to the correct active scopes', () => {
    setActiveDataScope('house:house-a');
    setPersonalDataScope('account:user-1');

    expect(getMutationScope('pantry_lot')).toBe('house:house-a');
    expect(getMutationScope('shopping_list_item')).toBe('account:user-1');
    expect(getMutationScope('cook_event')).toBe('account:user-1');
    expect(getMutationScope('generated_recipe')).toBe('account:user-1');
    expect(getMutationScope('recipe_preference')).toBe('account:user-1');
    expect(getMutationScope('diet_profile')).toBe('account:user-1');
    expect(getMutationScope('ai_consent')).toBe('account:user-1');

    setActiveDataScope('guest');
    expect(getPersonalDataScope()).toBe('guest');
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

  it('stores a separate cursor for each house while keeping the account high-water mark', async () => {
    const houseScope = 'house:cursor-house' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope(accountScope);
    const request = vi.fn().mockResolvedValue({ changes: [], nextCursor: 12 });

    await syncNow({ session, request });

    await expect(readSyncCursor(houseScope)).resolves.toBe(12);
    await expect(readSyncCursor(accountScope)).resolves.toBe(12);
    setActiveDataScope('guest');
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

  it('applies personal shopping and cooking changes to the account while pantry stays house-scoped', async () => {
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
        { ...sampleMutation('personal-shopping'), entityType: 'shopping_list_item', entityId: shoppingItem.id, payload: shoppingItem, serverSequence: 1 },
        { ...sampleMutation('personal-cook'), entityType: 'cook_event', entityId: cookEvent.id, payload: cookEvent, serverSequence: 2 },
      ],
      nextCursor: 2,
    });

    await syncNow({ session, request });

    await expect(readShoppingList(accountScope)).resolves.toEqual([shoppingItem]);
    await expect(readShoppingList(houseScope)).resolves.toEqual([]);
    await expect(readCookEvents(accountScope)).resolves.toEqual([cookEvent]);
    await expect(readCookEvents(houseScope)).resolves.toEqual([]);
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

  it('activates the house scope after loading the authenticated house and merging guest data', async () => {
    setActiveDataScope('house:stale-house');
    const request = vi.fn()
      .mockResolvedValueOnce({ house: { id: 'house-a', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' }, membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' }, members: [] })
      .mockResolvedValueOnce({ summary: { addedLots: 0, mergedLots: 0, mergedGroups: 0, importedStaples: 0 } });

    await initializeSessionScope(session, request);

    expect(request).toHaveBeenNthCalledWith(1, '/v1/house');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/house/pantry/merge', expect.objectContaining({ method: 'POST' }));
    expect(getActiveDataScope()).toBe('house:house-a');
    expect(getPersonalDataScope()).toBe('account:user-1');
  });

  it('imports pantry data into the account scope without deleting the guest data', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
      pantryLots: [],
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void input;
      void init;
      return responseFor({ changes: [], nextCursor: 0 });
    });
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session);

    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { mutations: Array<{ entityType: string; entityId: string }> };
    expect(body.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'pantry_lot', entityId: 'pasta' }),
      expect.objectContaining({ entityType: 'staple_preference', entityId: 'salt' }),
      expect.objectContaining({ entityType: 'diet_profile', entityId: 'profile' }),
    ]));
    await expect(readPantrySnapshot()).resolves.toMatchObject({
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
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void input;
      void init;
      return responseFor({ changes: [], nextCursor: 0 });
    });
    vi.stubGlobal('fetch', fetch);

    await importLocalData(session);
    await importLocalData(session);

    const mutationIds = fetch.mock.calls.map(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string) as { mutations: Array<{ mutationId: string }> };
      return body.mutations.map((mutation) => mutation.mutationId);
    });
    expect(new Set(mutationIds[0])).toEqual(new Set(mutationIds[1]));
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
