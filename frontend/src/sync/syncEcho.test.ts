import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import validMutations from '@ikuck/shared/sync-fixtures/valid.json';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { readPantrySnapshot } from '../storage/pantryStorage';
import { readShoppingList } from '../storage/shoppingListStorage';
import * as shoppingStorage from '../storage/shoppingListStorage';
import { readCookEvents, readRecipePreferences } from '../storage/activityStorage';
import { readDinnerEntries, readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { readDietProfile } from '../storage/dietProfileStorage';
import { hydrateShoppingListStore, useShoppingListStore, waitForPendingShoppingListWrites } from '../store/shoppingListStore';
import { setActiveDataScope, setPersonalDataScope, type SyncScope } from './scopeContext';
import { enqueueMutation, listenForReconnect, readQueuedMutations, registerShoppingListSnapshotListener, syncNow } from './syncQueue';
import { parseSyncMutation } from './validation';

const accountScope = 'account:echo';
const session = { userId: 'echo', emailVerifiedAt: '2026-10-07T09:00:00.000Z', csrfToken: 'fixture' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const echo = (mutations: SyncMutation[], scope: SyncScope, start = 0): SyncChange[] => mutations.map((mutation, index) => ({
  ...mutation, syncScope: scope as SyncChange['syncScope'], serverSequence: start + index + 1,
}));

beforeEach(async () => {
  await deleteLocalDatabase();
  window.localStorage.clear();
  setActiveDataScope('guest');
  setPersonalDataScope('guest');
  setActiveDataScope(accountScope);
  setPersonalDataScope(accountScope);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('preserves the new note through an old echo and a subsequent purchased toggle', async () => {
  await hydrateShoppingListStore();
  const first = deferred();
  const second = deferred();
  const batches: SyncMutation[][] = [];
  let sequence = 0;
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(options?.body as string) as { mutations: SyncMutation[] };
    batches.push(body.mutations);
    if (batches.length === 1) await first.promise;
    if (batches.length === 2) await second.promise;
    const changes = echo(body.mutations, accountScope, sequence);
    sequence += changes.length;
    return new Response(JSON.stringify({ changes, nextCursor: sequence }));
  });
  vi.stubGlobal('fetch', fetch);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const stop = listenForReconnect(() => session);
  try {
    const id = useShoppingListStore.getState().addItem({ ingredientId: 'pasta', label: 'Pasta', quantity: null,
      unit: null, note: null, purchased: false, sourceRecipeId: null })!;
    await waitForPendingShoppingListWrites();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    useShoppingListStore.getState().updateItem(id, { note: 'Keep this new note' });
    await waitForPendingShoppingListWrites();
    first.resolve();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // Unlike the diagnostic probe, require the corrected intermediate state as well.
    expect(useShoppingListStore.getState().items[0]?.note).toBe('Keep this new note');
    useShoppingListStore.getState().togglePurchased(id);
    await waitForPendingShoppingListWrites();
    second.resolve();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () => expect(await readQueuedMutations(accountScope)).toEqual([]));
    expect(batches[2][0].payload).toMatchObject({ note: 'Keep this new note', purchased: true });
    expect(useShoppingListStore.getState().items[0]).toMatchObject({ note: 'Keep this new note', purchased: true });
    expect((await readShoppingList())[0]).toMatchObject({ note: 'Keep this new note', purchased: true });
  } finally { first.resolve(); second.resolve(); stop(); }
});

it('rechecks edits queued during asynchronous snapshot persistence before publishing', async () => {
  const original = parseSyncMutation(validMutations.find((mutation) => mutation.entityType === 'shopping_list_item'))!;
  await enqueueMutation(accountScope, original);
  const entered = deferred();
  const release = deferred();
  const realWrite = shoppingStorage.writeShoppingList;
  vi.spyOn(shoppingStorage, 'writeShoppingList').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return realWrite(...args);
  });
  const published = vi.fn();
  const unregister = registerShoppingListSnapshotListener(published);
  let sequence = 0;
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const { mutations } = JSON.parse(options?.body as string) as { mutations: SyncMutation[] };
    const changes = echo(mutations, accountScope, sequence);
    sequence += changes.length;
    return new Response(JSON.stringify({ changes, nextCursor: sequence }));
  });
  const running = syncNow({ session, fetch });
  try {
    await entered.promise;
    await enqueueMutation(accountScope, { ...original, mutationId: 'during-apply',
      payload: { ...original.payload as object, note: 'Durante persistenza' }, clientUpdatedAt: '2026-10-07T12:00:00.000Z' });
    release.resolve();
    await running;
    expect(published).toHaveBeenCalled();
    for (const [items] of published.mock.calls) expect(items[0]).toMatchObject({ note: 'Durante persistenza' });
    expect((await readShoppingList())[0]).toMatchObject({ note: 'Durante persistenza' });
  } finally { release.resolve(); await running; unregister(); }
});

it('preserves accepted but not yet downloaded edits across pages without masking a later remote update', async () => {
  const original = parseSyncMutation(validMutations.find((mutation) => mutation.entityType === 'shopping_list_item'))!;
  const local = { ...original, mutationId: 'local-new', payload: { ...original.payload as object, note: 'Locale' } };
  await enqueueMutation(accountScope, local);
  const published = vi.fn();
  const unregister = registerShoppingListSnapshotListener(published);
  let page = 0;
  try {
    await syncNow({ session, fetch: async () => {
      page += 1;
      return new Response(JSON.stringify(page === 1
        ? { changes: echo([original], accountScope), nextCursor: 1, hasMore: true }
        : { changes: echo([local, { ...original, mutationId: 'remote-newer', deviceId: 'other' }], accountScope, 1),
          nextCursor: 3, hasMore: false }));
    } });
    expect(published.mock.calls[0][0][0]).toMatchObject({ note: 'Locale' });
    expect(published.mock.calls[1][0][0]).toMatchObject({ note: null });
    expect((await readShoppingList())[0]).toMatchObject({ note: null });
    expect(await readQueuedMutations(accountScope)).toEqual([]);
  } finally { unregister(); }
});

it('does not replay an older accepted edit after a newer edit of that entity has been reconciled', async () => {
  const original = parseSyncMutation(validMutations.find((mutation) => mutation.entityType === 'shopping_list_item'))!;
  const latest = { ...original, mutationId: 'latest-local', clientUpdatedAt: '2026-10-07T12:00:00.000Z',
    payload: { ...original.payload as object, note: 'Ultima nota' } };
  await enqueueMutation(accountScope, original);
  await enqueueMutation(accountScope, latest);
  const published = vi.fn();
  const unregister = registerShoppingListSnapshotListener(published);
  let page = 0;
  try {
    await syncNow({ session, fetch: async () => {
      page += 1;
      return new Response(JSON.stringify(page === 1
        ? { changes: echo([latest], accountScope), nextCursor: 1, hasMore: true }
        : { changes: echo([{ ...original, mutationId: 'remote-final', deviceId: 'other' }], accountScope, 1),
          nextCursor: 2, hasMore: false }));
    } });
    expect(published.mock.calls[0][0][0]).toMatchObject({ note: 'Ultima nota' });
    expect((await readShoppingList())[0]).toMatchObject({ note: null });
    expect(await readQueuedMutations(accountScope)).toEqual([]);
  } finally { unregister(); }
});

for (const interruption of ['network-failure', 'page-limit'] as const) {
  it(`keeps accepted edits durable when download ends with ${interruption}, then reconciles on retry`, async () => {
    const original = parseSyncMutation(validMutations.find((mutation) => mutation.entityType === 'shopping_list_item'))!;
    const local = { ...original, mutationId: 'awaiting-echo', payload: { ...original.payload as object, note: 'Locale' } };
    await enqueueMutation(accountScope, local);
    let page = 0;
    const running = syncNow({ session, fetch: async (_url, options) => {
      page += 1;
      const { mutations } = JSON.parse(options?.body as string) as { mutations: SyncMutation[] };
      expect(mutations).toHaveLength(page === 1 ? 1 : 0);
      if (page === 2 && interruption === 'network-failure') throw new Error('Offline');
      return new Response(JSON.stringify({ changes: page === 1 ? echo([original], accountScope) : [],
        nextCursor: page, hasMore: true }));
    } });
    if (interruption === 'network-failure') await expect(running).rejects.toThrow('Network request failed');
    else expect(await running).toMatchObject({ uploaded: 1, pending: 1, complete: false });
    expect((await readShoppingList())[0]).toMatchObject({ note: 'Locale' });
    expect(await readQueuedMutations(accountScope)).toHaveLength(1);
    await syncNow({ session, fetch: async () => new Response(JSON.stringify({
      changes: echo([local, { ...original, mutationId: 'remote-authoritative', deviceId: 'other' }], accountScope, page),
      nextCursor: page + 2, hasMore: false,
    })) });
    expect((await readShoppingList())[0]).toMatchObject({ note: null });
    expect(await readQueuedMutations(accountScope)).toEqual([]);
  });
}

it('does not let an account overlay shadow the same entity id in the active House', async () => {
  const houseScope = 'house:echo';
  setActiveDataScope(houseScope);
  const original = parseSyncMutation(validMutations.find((mutation) => mutation.entityType === 'shopping_list_item'))!;
  const entered = deferred();
  const release = deferred();
  let page = 0;
  const running = syncNow({ session, fetch: async (_url, options) => {
    page += 1;
    if (page === 1) {
      entered.resolve();
      await release.promise;
      return new Response(JSON.stringify({ changes: echo([original], houseScope), nextCursor: 1 }));
    }
    const { mutations } = JSON.parse(options?.body as string) as { mutations: SyncMutation[] };
    return new Response(JSON.stringify({ changes: echo(mutations, accountScope, 1), nextCursor: 2 }));
  } });
  await entered.promise;
  await enqueueMutation(accountScope, { ...original, mutationId: 'account-local',
    payload: { ...original.payload as object, note: 'Solo account' } });
  release.resolve();
  await running;
  expect((await readShoppingList(accountScope))[0]).toMatchObject({ note: 'Solo account' });
  expect((await readShoppingList(houseScope))[0]).toMatchObject({ note: null });
});

const readers = {
  pantry_item: async (scope: SyncScope) => (await readPantrySnapshot(scope))?.pantryItems[0],
  pantry_lot: async (scope: SyncScope) => (await readPantrySnapshot(scope))?.pantryLots?.[0],
  staple_preference: async (scope: SyncScope) => (await readPantrySnapshot(scope))?.stapleIds.includes('salt') ? { enabled: true } : undefined,
  shopping_list_item: async (scope: SyncScope) => (await readShoppingList(scope))[0],
  cook_event: async (scope: SyncScope) => (await readCookEvents(scope))[0],
  recipe_preference: async (scope: SyncScope) => (await readRecipePreferences(scope))[0],
  diet_profile: readDietProfile,
  dinner_entry: async (scope: SyncScope) => (await readDinnerEntries(scope))[0],
  saved_recipe: async (scope: SyncScope) => (await readSavedRecipes(scope))[0],
};
const updates: Record<keyof typeof readers, Record<string, unknown>> = {
  pantry_item: { label: 'Pomodoro' }, pantry_lot: { quantity: 250 }, staple_preference: { enabled: false },
  shopping_list_item: { note: 'Nota nuova' }, cook_event: { note: 'Nota nuova' }, recipe_preference: { rating: 3 },
  diet_profile: { diet: 'vegan' }, dinner_entry: { note: 'Nota nuova' }, saved_recipe: { title: 'Titolo nuovo' },
};

for (const scope of [accountScope, 'house:echo'] as const) {
  describe(`pending overlays in ${scope}`, () => {
    for (const entityType of Object.keys(readers) as (keyof typeof readers)[]) {
      for (const operation of ['upsert', 'delete'] as const) {
        it(`${entityType}: preserves pending ${operation}, then accepts authoritative remote changes after acknowledgement`, async () => {
          setActiveDataScope(scope);
          const original = parseSyncMutation(validMutations.find((mutation) => mutation.entityType === entityType))!;
          await enqueueMutation(scope, original);
          const first = deferred();
          const second = deferred();
          const requested = deferred();
          const requestedSecond = deferred();
          let calls = 0;
          const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
            const { mutations } = JSON.parse(options?.body as string) as { mutations: SyncMutation[] };
            calls += 1;
            if (calls === 1) { requested.resolve(); await first.promise; }
            if (calls === 2) { requestedSecond.resolve(); await second.promise; }
            const remote = calls === 1 && entityType === 'pantry_item' && operation === 'upsert'
              ? mutations.map((mutation) => ({ ...mutation, operation: 'delete' as const, payload: null }))
              : mutations;
            return new Response(JSON.stringify({ changes: echo(remote, scope, calls - 1), nextCursor: calls }));
          });
          const running = syncNow({ session, fetch });
          await requested.promise;
          const pending = { ...original, mutationId: `${original.mutationId}-new`, operation,
            payload: operation === 'delete' ? null : { ...original.payload as object, ...updates[entityType] },
            clientUpdatedAt: '2026-10-07T12:00:00.000Z' };
          await enqueueMutation(scope, pending);
          first.resolve();
          await requestedSecond.promise;
          try {
            const actual = await readers[entityType](scope);
            if (entityType === 'diet_profile' && operation === 'delete') expect(actual).toMatchObject({ diet: 'omnivore' });
            else if (operation === 'delete' || entityType === 'staple_preference') expect(actual).toBeUndefined();
            else expect(actual).toMatchObject(updates[entityType]);
            if (scope.startsWith('house:') && entityType !== 'diet_profile') expect(await readers[entityType](accountScope)).toBeUndefined();
          } finally { second.resolve(); await running; }
          expect(await readQueuedMutations(scope)).toEqual([]);
          // An acknowledged local value must not mask a later write from another device.
          await syncNow({ session, fetch: async () => new Response(JSON.stringify({
            changes: echo([{ ...original, mutationId: 'other-device', deviceId: 'other' }], scope, 2), nextCursor: 3,
          })) });
          expect(await readers[entityType](scope)).toMatchObject(original.payload as object);
        });
      }
    }
  });
}
