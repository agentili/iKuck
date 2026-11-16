import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyncChange, SyncMutation } from '@ikuck/shared/contracts';
import validMutations from '@ikuck/shared/sync-fixtures/valid.json';

const scope = 'account:durability';
const session = { userId: 'durability', emailVerifiedAt: '2026-10-07T09:00:00.000Z', csrfToken: 'fixture' };
const original = validMutations.find((mutation) => mutation.entityType === 'shopping_list_item')! as SyncMutation;
const winner = (operation: 'upsert' | 'delete', sequence = 1): SyncChange => ({
  ...original, mutationId: `remote-${sequence}`, deviceId: 'other-device', syncScope: scope,
  operation, payload: operation === 'delete' ? null : { ...original.payload as object, note: 'Remoto autorevole' },
  clientUpdatedAt: '2026-10-08T12:00:00.000Z', serverSequence: sequence,
});
const fullPage = (target: SyncChange, start = 0): SyncChange[] => [target,
  ...Array.from({ length: 199 }, (_, index) => ({
    ...winner('upsert', start + index + 2), entityId: `filler-${index}`,
    payload: { ...original.payload as object, id: `filler-${index}` },
  })),
];
const response = (changes: SyncChange[], nextCursor: number) => new Response(JSON.stringify({ changes, nextCursor }));

beforeEach(async () => {
  vi.resetModules();
  const db = await import('../storage/indexedDb');
  await db.deleteLocalDatabase();
  window.localStorage.clear();
  const context = await import('./scopeContext');
  context.setActiveDataScope(scope);
  context.setPersonalDataScope(scope);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await (await import('../storage/indexedDb')).closeLocalDatabase();
});

for (const operation of ['upsert', 'delete'] as const) {
  for (const interruption of ['none', 'network', 'page-limit'] as const) {
    it(`persists a remote ${operation} without echo through ${interruption}, reload and an empty subsequent pull`, async () => {
      let queue = await import('./syncQueue');
      const storage = await import('../storage/shoppingListStorage');
      const local = { ...original, mutationId: 'losing-upload', deviceId: await queue.getDeviceId(),
        payload: { ...original.payload as object, note: 'Locale obsoleto' } };
      await storage.writeShoppingList([local.payload as never], scope);
      await queue.enqueueMutation(scope, local);
      let calls = 0;
      const running = queue.syncNow({ session, fetch: async (_url, options) => {
        const body = JSON.parse(options!.body as string);
        calls += 1;
        expect(body.mutations).toHaveLength(calls === 1 ? 1 : 0);
        expect(body.cursor).toBe((calls - 1) * 200);
        if (calls === 2 && interruption === 'network') throw new Error('Offline');
        if (calls === 2 && interruption === 'none') return response([], 200);
        // Current rows can supersede an upload; no exact echo is ever returned.
        const target = calls === 1 ? winner(operation) : {
          ...winner('upsert', (calls - 1) * 200 + 1), entityId: 'filler-extra',
          payload: { ...original.payload as object, id: 'filler-extra' },
        };
        return response(fullPage(target, (calls - 1) * 200), calls * 200);
      } });
      if (interruption === 'network') await expect(running).rejects.toThrow('Network request failed');
      else expect(await running).toMatchObject({ complete: interruption === 'none', pending: interruption === 'none' ? 0 : 1 });
      const cursor = interruption === 'page-limit' ? 20000 : 200;
      expect(await queue.readSyncCursor(scope)).toBe(cursor);
      expect(await queue.readQueuedMutations(scope)).toHaveLength(interruption === 'none' ? 0 : 1);
      if (interruption !== 'none') expect((await storage.readShoppingList(scope)).find((item) => item.id === original.entityId)?.note).toBe('Locale obsoleto');
      // Close the old connection and discard every module-level map, not IndexedDB.
      await (await import('../storage/indexedDb')).closeLocalDatabase();
      vi.resetModules();
      queue = await import('./syncQueue');
      const resumed = await queue.syncNow({ session, fetch: async (_url, options) => {
        const body = JSON.parse(options!.body as string);
        expect(body.cursor).toBe(cursor);
        expect(body.mutations).toHaveLength(interruption === 'none' ? 0 : 1);
        return response([], cursor);
      } });
      expect(resumed).toMatchObject({ complete: true, pending: 0 });
      expect(await queue.readQueuedMutations(scope)).toEqual([]);
      expect(await queue.readSyncCursor(scope)).toBe(cursor);
      await queue.syncNow({ session, fetch: async (_url, options) => {
        const body = JSON.parse(options!.body as string);
        expect(body.cursor).toBe(cursor);
        expect(body.mutations).toEqual([]);
        return response([], cursor);
      } });
      const persisted = (await (await import('../storage/shoppingListStorage')).readShoppingList(scope))
        .find((item) => item.id === original.entityId);
      if (operation === 'delete') expect(persisted).toBeUndefined();
      else expect(persisted?.note).toBe('Remoto autorevole');
      expect(await queue.readQueuedMutations(scope)).toEqual([]);
      expect(await queue.readSyncCursor(scope)).toBe(cursor);
    }, 20000);
  }
}

it('keeps a newer local edit over a deferred tombstone and only acknowledges captured mutation ids', async () => {
  const queue = await import('./syncQueue');
  const storage = await import('../storage/shoppingListStorage');
  await queue.enqueueMutation(scope, { ...original, mutationId: 'old-local' });
  const latest = { ...original, mutationId: 'new-local', clientUpdatedAt: '2026-10-09T12:00:00.000Z',
    payload: { ...original.payload as object, note: 'Modifica più recente' } };
  let calls = 0;
  const published = vi.fn();
  const unregister = queue.registerShoppingListSnapshotListener(published);
  try {
    await queue.syncNow({ session, fetch: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options!.body as string);
      if (calls === 1) return response(fullPage(winner('delete')), 200);
      if (calls === 2) {
        expect(body.mutations).toEqual([]);
        await queue.enqueueMutation(scope, latest);
        return response([], 200);
      }
      expect(body.mutations.map((mutation: SyncMutation) => mutation.mutationId)).toEqual(['new-local']);
      expect((await queue.readQueuedMutations(scope)).map((mutation) => mutation.mutationId)).toEqual(['new-local']);
      expect((await storage.readShoppingList(scope)).find((item) => item.id === original.entityId)?.note).toBe('Modifica più recente');
      return response([{ ...latest, syncScope: scope, serverSequence: 201 }], 201);
    } });
    expect((await storage.readShoppingList(scope)).find((item) => item.id === original.entityId)?.note).toBe('Modifica più recente');
    expect(await queue.readQueuedMutations(scope)).toEqual([]);
    expect(await queue.readSyncCursor(scope)).toBe(201);
    await queue.syncNow({ session, fetch: async () => response([], 201) });
    expect((await storage.readShoppingList(scope)).find((item) => item.id === original.entityId)?.note).toBe('Modifica più recente');
  } finally { unregister(); }
});

for (const operation of ['upsert', 'delete'] as const) {
  for (const boundary of ['journal', 'snapshot', 'cursor', 'ack', 'prune'] as const) {
    it(`recovers the authoritative ${operation} after a ${boundary} storage failure and reload`, async () => {
      let queue = await import('./syncQueue');
      const db = await import('../storage/indexedDb');
      const storage = await import('../storage/shoppingListStorage');
      await queue.enqueueMutation(scope, { ...original, mutationId: 'losing-upload',
        payload: { ...original.payload as object, note: 'Locale obsoleto' } });
      let journalWrites = 0;
      let cursorWrites = 0;
      const realWriteMeta = db.writeMeta;
      vi.spyOn(db, 'writeMeta').mockImplementation(async (...args) => {
        if (args[0] === `syncDeferredChanges:${scope}`) {
          journalWrites += 1;
          if (boundary === 'journal' && journalWrites === 1 || boundary === 'prune' && journalWrites === 4) {
            throw new Error(`Injected ${boundary} failure`);
          }
        }
        if (args[0] === `syncCursor:${scope}`) {
          cursorWrites += 1;
          if (boundary === 'cursor' && cursorWrites === 2) throw new Error('Injected cursor failure');
        }
        return realWriteMeta(...args);
      });
      if (boundary === 'ack') vi.spyOn(db, 'deleteQueueValue').mockRejectedValueOnce(new Error('Injected ack failure'));
      if (boundary === 'snapshot') {
        const realWrite = storage.writeShoppingList;
        let writes = 0;
        vi.spyOn(storage, 'writeShoppingList').mockImplementation(async (...args) => {
          writes += 1;
          if (writes === 2) throw new Error('Injected snapshot failure');
          return realWrite(...args);
        });
      }
      let calls = 0;
      await expect(queue.syncNow({ session, fetch: async () => {
        calls += 1;
        return calls === 1 ? response(fullPage(winner(operation)), 200) : response([], 200);
      } })).rejects.toThrow(`Injected ${boundary} failure`);
      const cursor = boundary === 'journal' ? 0 : 200;
      expect(await queue.readSyncCursor(scope)).toBe(cursor);
      expect(await queue.readQueuedMutations(scope)).toHaveLength(boundary === 'prune' ? 0 : 1);
      vi.restoreAllMocks();
      await db.closeLocalDatabase();
      vi.resetModules();
      queue = await import('./syncQueue');
      const result = await queue.syncNow({ session, fetch: async (_url, options) => {
        const body = JSON.parse(options!.body as string);
        if (body.cursor === 0) return response(fullPage(winner(operation)), 200);
        expect(body.cursor).toBe(200);
        return response([], 200);
      } });
      expect(result).toMatchObject({ complete: true, pending: 0 });
      expect(await queue.readSyncCursor(scope)).toBe(200);
      expect(await queue.readQueuedMutations(scope)).toEqual([]);
      await queue.syncNow({ session, fetch: async () => response([], 200) });
      const persisted = (await (await import('../storage/shoppingListStorage')).readShoppingList(scope))
        .find((item) => item.id === original.entityId);
      if (operation === 'delete') expect(persisted).toBeUndefined();
      else expect(persisted?.note).toBe('Remoto autorevole');
      expect(await (await import('../storage/indexedDb')).readMeta(`syncDeferredChanges:${scope}`)).toEqual([]);
      expect(await queue.readSyncCursor(scope)).toBe(200);
      expect(await queue.readQueuedMutations(scope)).toEqual([]);
    });
  }
}

for (const operation of ['upsert', 'delete'] as const) {
  it(`replaces an older deferred version with the latest remote ${operation} before reload`, async () => {
    let queue = await import('./syncQueue');
    await queue.enqueueMutation(scope, { ...original, mutationId: 'superseded-upload' });
    let calls = 0;
    await expect(queue.syncNow({ session, fetch: async () => {
      calls += 1;
      if (calls === 3) throw new Error('Offline');
      return calls === 1
        ? response(fullPage(winner(operation === 'delete' ? 'upsert' : 'delete')), 200)
        : response(fullPage(winner(operation, 201), 200), 400);
    } })).rejects.toThrow('Network request failed');
    expect(await queue.readSyncCursor(scope)).toBe(400);
    expect(await queue.readQueuedMutations(scope)).toHaveLength(1);
    await (await import('../storage/indexedDb')).closeLocalDatabase();
    vi.resetModules();
    queue = await import('./syncQueue');
    expect(await queue.syncNow({ session, fetch: async () => response([], 400) })).toMatchObject({ complete: true, pending: 0 });
    await queue.syncNow({ session, fetch: async () => response([], 400) });
    const persisted = (await (await import('../storage/shoppingListStorage')).readShoppingList(scope))
      .find((item) => item.id === original.entityId);
    if (operation === 'delete') expect(persisted).toBeUndefined();
    else expect(persisted?.note).toBe('Remoto autorevole');
    expect(await queue.readSyncCursor(scope)).toBe(400);
    expect(await queue.readQueuedMutations(scope)).toEqual([]);
  });
}

it('fences a deferred journal write when the session changes before persistence', async () => {
  const queue = await import('./syncQueue');
  const db = await import('../storage/indexedDb');
  await queue.enqueueMutation(scope, { ...original, mutationId: 'fenced-upload' });
  let current = true;
  const realWriteMeta = db.writeMeta;
  vi.spyOn(db, 'writeMeta').mockImplementation(async (...args) => {
    if (args[0] === `syncDeferredChanges:${scope}`) current = false;
    return realWriteMeta(...args);
  });
  await expect(queue.syncNow({ session, isSessionCurrent: () => current,
    fetch: async () => response(fullPage(winner('delete')), 200) })).rejects.toThrow('The active session changed');
  expect(await queue.readSyncCursor(scope)).toBe(0);
  expect(await queue.readQueuedMutations(scope)).toHaveLength(1);
  expect(await db.readMeta(`syncDeferredChanges:${scope}`)).toBeNull();
});

it('purges durable deferred changes together with their scope and cursor', async () => {
  const queue = await import('./syncQueue');
  const db = await import('../storage/indexedDb');
  await queue.enqueueMutation(scope, { ...original, mutationId: 'purged-upload' });
  let calls = 0;
  await expect(queue.syncNow({ session, fetch: async () => {
    calls += 1;
    if (calls === 2) throw new Error('Offline');
    return response(fullPage(winner('delete')), 200);
  } })).rejects.toThrow('Network request failed');
  expect(await db.readMeta(`syncDeferredChanges:${scope}`)).toEqual([winner('delete')]);
  await queue.clearDataScope(scope);
  expect(await db.readMeta(`syncDeferredChanges:${scope}`)).toBeNull();
  expect(await queue.readSyncCursor(scope)).toBe(0);
  expect(await queue.readQueuedMutations(scope)).toEqual([]);
  await queue.syncNow({ session, fetch: async () => response([], 0) });
  expect(await (await import('../storage/shoppingListStorage')).readShoppingList(scope)).toEqual([]);
});

for (const failBeforeAck of [false, true]) {
  it(`finalizes migrated account journal through house delete, departure and reload (retry=${failBeforeAck})`, async () => {
    let queue = await import('./syncQueue');
    const db = await import('../storage/indexedDb');
    const storage = await import('../storage/shoppingListStorage');
    const context = await import('./scopeContext');
    const house = 'house:durability' as const;
    const personal = validMutations.find((mutation) => mutation.entityType === 'ai_consent')! as SyncMutation;
    const personalChange = { ...personal, mutationId: 'remote-personal', deviceId: 'other-device',
      syncScope: scope, serverSequence: 2 } satisfies SyncChange;
    await storage.writeShoppingList([original.payload as never], scope);
    await queue.enqueueMutation(scope, { ...original, deviceId: await queue.getDeviceId() });
    await queue.enqueueMutation(scope, personal);
    const page = fullPage(winner('upsert'));
    page[1] = personalChange;
    let calls = 0;
    await expect(queue.syncNow({ session, fetch: async () => {
      if (++calls === 2) throw new Error('Offline');
      return response(page, 200);
    } })).rejects.toThrow('Network request failed');
    const journalKey = `syncDeferredChanges:${scope}`;
    const journal = [winner('upsert'), personalChange];
    expect(await db.readMeta(journalKey)).toEqual(journal);
    const membership = {
      house: { id: 'durability', name: 'Casa', createdAt: session.emailVerifiedAt },
      membership: { role: 'member' as const, joinedAt: session.emailVerifiedAt }, members: [],
    };
    let fail = failBeforeAck;
    let imports = 0;
    const request: import('../api/apiClient').ApiRequest = async <T>(path: string, options?: import('../api/apiClient').ApiRequestOptions) => {
      if (path === '/v1/house') return membership as T;
      expect(path).toBe('/v1/house/account-queue/import');
      imports += 1;
      expect(options?.body).toMatchObject({ mutations: [{ mutationId: original.mutationId, syncScope: scope }] });
      // A request in flight is not an acknowledgement: both journal and outbox survive.
      expect(await db.readMeta(journalKey)).toEqual(journal);
      expect(await queue.readQueuedMutations(scope)).toHaveLength(2);
      if (fail) throw new Error('Import response lost');
      return undefined as T;
    };
    if (failBeforeAck) {
      await expect(queue.initializeSessionScope(session, request)).rejects.toThrow('Import response lost');
      expect(await db.readMeta(journalKey)).toEqual(journal);
      expect(await queue.readQueuedMutations(scope)).toHaveLength(2);
      expect(await storage.readShoppingList(scope)).toHaveLength(200 - 1);
      fail = false;
    }
    await queue.initializeSessionScope(session, request);
    expect(imports).toBe(failBeforeAck ? 2 : 1);
    expect(context.getActiveDataScope()).toBe(house);
    expect(await storage.readShoppingList(scope)).toEqual([]);
    expect(await db.readMeta(journalKey)).toEqual([personalChange]);
    expect(await queue.readQueuedMutations(scope)).toEqual([expect.objectContaining({ mutationId: personal.mutationId })]);
    const migratedPage = page.map((change, index) => ({ ...change, syncScope: house, serverSequence: 201 + index,
      ...(index === 0 ? { operation: 'delete' as const, payload: null } : {}),
    })).filter((change) => change.entityType !== 'ai_consent');
    await queue.syncNow({ session, fetch: async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      return body.cursor === 0 ? response([...migratedPage, personalChange], 400) : response([], 400);
    } });
    expect((await storage.readShoppingList(house)).find((item) => item.id === original.entityId)).toBeUndefined();
    expect(await storage.readShoppingList(scope)).toEqual([]);
    await queue.initializeSessionScope(session, async <T>() => ({ house: null, membership: null, members: [] }) as T);
    await queue.syncNow({ session, fetch: async () => response([], 200) });
    await db.closeLocalDatabase();
    vi.resetModules();
    queue = await import('./syncQueue');
    await queue.syncNow({ session, fetch: async (_url, options) => {
      expect(JSON.parse(options!.body as string)).toMatchObject({ cursor: 200, mutations: [] });
      return response([], 200);
    } });
    expect(await (await import('../storage/shoppingListStorage')).readShoppingList(scope)).toEqual([]);
    expect(await (await import('../storage/shoppingListStorage')).readShoppingList(house)).toEqual([]);
    expect(await queue.readQueuedMutations(scope)).toEqual([]);
    expect(await queue.readQueuedMutations(house)).toEqual([]);
    expect(await queue.readSyncCursor(scope)).toBe(200);
    expect(await queue.readSyncCursor(house)).toBe(0);
    expect(await (await import('../storage/indexedDb')).readMeta(journalKey)).toEqual([]);
  });
}

it('retains journal identities with unacknowledged concurrent edits and finalizes them on a house sync retry', async () => {
  const queue = await import('./syncQueue');
  const db = await import('../storage/indexedDb');
  const journalKey = `syncDeferredChanges:${scope}`;
  await queue.enqueueMutation(scope, original);
  let calls = 0;
  await expect(queue.syncNow({ session, fetch: async () => {
    if (++calls === 2) throw new Error('Offline');
    return response(fullPage(winner('upsert')), 200);
  } })).rejects.toThrow('Network request failed');
  const concurrent = { ...original, mutationId: 'concurrent-unacknowledged', clientUpdatedAt: '2026-10-09T12:00:00.000Z' };
  await queue.initializeSessionScope(session, async <T>(path: string) => {
    if (path === '/v1/house') return {
      house: { id: 'durability', name: 'Casa', createdAt: session.emailVerifiedAt },
      membership: { role: 'member', joinedAt: session.emailVerifiedAt }, members: [],
    } as T;
    expect(path).toBe('/v1/house/account-queue/import');
    await queue.enqueueMutation(scope, concurrent);
    return undefined as T;
  });
  expect(await db.readMeta(journalKey)).toEqual([winner('upsert')]);
  expect(await queue.readQueuedMutations(scope)).toEqual([expect.objectContaining({ mutationId: concurrent.mutationId })]);
  await queue.syncNow({ session, request: async <T>(path: string, options?: import('../api/apiClient').ApiRequestOptions) => {
    if (path === '/v1/house/account-queue/import') {
      expect(options?.body).toMatchObject({ mutations: [{ mutationId: concurrent.mutationId }] });
      expect(await db.readMeta(journalKey)).toEqual([winner('upsert')]);
      return undefined as T;
    }
    expect(path).toBe('/v1/sync');
    // Finalize before the next pull can replay an account source that no longer exists.
    expect(await db.readMeta(journalKey)).toEqual([]);
    return { changes: [], nextCursor: 0 } as T;
  } });
  expect(await queue.readQueuedMutations(scope)).toEqual([]);
  expect(await (await import('../storage/shoppingListStorage')).readShoppingList(scope)).toEqual([]);
  expect(await queue.readSyncCursor(scope)).toBe(200);
});

for (const boundary of ['ack', 'journal'] as const) {
  it(`retries migration finalization after a local ${boundary} failure following the server acknowledgement`, async () => {
    let queue = await import('./syncQueue');
    const db = await import('../storage/indexedDb');
    const journalKey = `syncDeferredChanges:${scope}`;
    await queue.enqueueMutation(scope, original);
    let calls = 0;
    await expect(queue.syncNow({ session, fetch: async () => {
      if (++calls === 2) throw new Error('Offline');
      return response(fullPage(winner('upsert')), 200);
    } })).rejects.toThrow('Network request failed');
    const request: import('../api/apiClient').ApiRequest = async <T>(path: string) => {
      if (path === '/v1/house') return {
        house: { id: 'durability', name: 'Casa', createdAt: session.emailVerifiedAt },
        membership: { role: 'member', joinedAt: session.emailVerifiedAt }, members: [],
      } as T;
      expect(path).toBe('/v1/house/account-queue/import');
      return undefined as T;
    };
    if (boundary === 'ack') vi.spyOn(db, 'deleteQueueValue').mockRejectedValueOnce(new Error('Local ack failed'));
    else vi.spyOn(db, 'writeMeta').mockRejectedValueOnce(new Error('Local journal failed'));
    await expect(queue.initializeSessionScope(session, request)).rejects.toThrow(`Local ${boundary} failed`);
    expect(await db.readMeta(journalKey)).toEqual([winner('upsert')]);
    expect(await queue.readQueuedMutations(scope)).toHaveLength(boundary === 'ack' ? 1 : 0);
    vi.restoreAllMocks();
    await db.closeLocalDatabase();
    vi.resetModules();
    queue = await import('./syncQueue');
    await queue.initializeSessionScope(session, request);
    expect(await (await import('../storage/indexedDb')).readMeta(journalKey)).toEqual([]);
    expect(await (await import('../storage/shoppingListStorage')).readShoppingList(scope)).toEqual([]);
    await queue.initializeSessionScope(session, async <T>() => ({ house: null, membership: null, members: [] }) as T);
    await queue.syncNow({ session, fetch: async () => response([], 200) });
    expect(await queue.readQueuedMutations(scope)).toEqual([]);
    expect(await queue.readQueuedMutations('house:durability')).toEqual([]);
    expect(await queue.readSyncCursor(scope)).toBe(200);
    expect(await queue.readSyncCursor('house:durability')).toBe(0);
    expect(await (await import('../storage/shoppingListStorage')).readShoppingList(scope)).toEqual([]);
  });
}
