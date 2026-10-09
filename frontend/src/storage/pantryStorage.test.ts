import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_PANTRY_STORAGE_KEY,
  PANTRY_STORAGE_KEY,
  PANTRY_CONFLICT_BACKUP_KEY,
  migrateLegacyPantry,
  pantryStorage,
  readPantrySnapshot,
  clearPantrySnapshot,
  recoverPantrySnapshot,
  reopenPantryArchivedConflict,
  readPantryConflictBackup,
  readPantryConflictArchive,
  getPantrySnapshotConflictError,
  isPantrySnapshotConflictActive,
  writePantrySnapshot,
} from './pantryStorage';
import * as indexedDb from './indexedDb';
import { setActiveDataScope, setPersonalDataScope, scopeStorageKey } from '../sync/scopeContext';
import { isScopeUncertain, markScopeUncertain, resumeScope } from '../sync/scopeWriteFence';
import { enqueuePantryMutation, initializeSessionScope, readQueuedMutations, syncNow, waitForPendingQueueWrites } from '../sync/syncQueue';
import type { ApiRequest } from '../api/apiClient';

const persistedPantry = (id: string) => JSON.stringify({
  state: {
    pantryItems: [{ id, label: 'Pasta', known: true }],
    stapleIds: ['salt'],
  },
  version: 1,
});

interface TestLockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

const setNavigatorLocks = (locks: TestLockManager | undefined): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: locks, writable: true });
  return () => {
    if (descriptor === undefined) Reflect.deleteProperty(window.navigator, 'locks');
    else Object.defineProperty(window.navigator, 'locks', descriptor);
  };
};

const createSerializedTestLocks = (): { manager: TestLockManager; names: string[] } => {
  const tails = new Map<string, Promise<void>>();
  const names: string[] = [];
  const manager: TestLockManager = {
    request<T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>) {
      names.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, current);
      return previous.then(async () => {
        try {
          return await callback();
        } finally {
          release();
          if (tails.get(name) === current) tails.delete(name);
        }
      });
    },
  };
  return { manager, names };
};

describe('pantry storage', () => {
  beforeEach(async () => {
    await indexedDb.deleteLocalDatabase();
    window.localStorage.clear();
    setActiveDataScope('guest');
    await readPantrySnapshot();
    setNavigatorLocks(createSerializedTestLocks().manager);
  });

  it('hydrates a valid IndexedDB guest pantry when localStorage getItem is denied for pantry keys', async () => {
    const raw = persistedPantry('idb-only-storage-denied');
    await indexedDb.writeKeyValue('pantry', raw);
    const originalGetItem = Storage.prototype.getItem;
    const deniedPantryReads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key.includes('pantry')) throw new DOMException('Storage disabled', 'SecurityError');
      return originalGetItem.call(this, key);
    });

    try {
      // @ts-expect-error Vite query IDs provide an isolated hydration context.
      const reader = await import('./pantryStorage?tab=idb-only-storage-denied');
      await expect(reader.readPantrySnapshot('guest')).resolves.toMatchObject({
        pantryItems: [{ id: 'idb-only-storage-denied' }],
      });
      await expect(indexedDb.readKeyValue('pantry')).resolves.toBe(raw);
    } finally {
      deniedPantryReads.mockRestore();
    }
  });

  it('keeps an unresolved IndexedDB conflict fail-closed when localStorage getItem is denied', async () => {
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
    await indexedDb.writeKeyValue(backupKey, {
      id: 'active-idb-conflict',
      scope: 'guest',
      reason: 'concurrent-write',
      createdAt: '2026-10-09T01:00:00.000Z',
      copies: [
        {
          id: 'idb-copy-a',
          label: 'Copia A',
          revision: 10,
          snapshot: { pantryItems: [{ id: 'copy-a', label: 'Pasta', known: true }], stapleIds: [] },
        },
        {
          id: 'idb-copy-b',
          label: 'Copia B',
          revision: 11,
          snapshot: { pantryItems: [{ id: 'copy-b', label: 'Riso', known: true }], stapleIds: [] },
        },
      ],
    });
    window.localStorage.setItem(markerKey, '1');
    const originalGetItem = Storage.prototype.getItem;
    const deniedKeys: string[] = [];
    const deniedPantryReads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key.includes('pantry')) {
        deniedKeys.push(key);
        throw new DOMException('Storage disabled', 'SecurityError');
      }
      return originalGetItem.call(this, key);
    });

    try {
      // @ts-expect-error Vite query IDs provide a fresh persisted-storage module context.
      const conflictStorage = await import('./pantryStorage?tab=active-idb-conflict-storage-denied');
      await expect(conflictStorage.readPantrySnapshot('guest')).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        copies: [{ id: 'idb-copy-a' }, { id: 'idb-copy-b' }],
      });
      await expect(conflictStorage.writePantrySnapshot({
        pantryItems: [{ id: 'must-remain-unwritten', label: 'Non scrivere', known: true }],
        stapleIds: [],
      }, 'guest')).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });

      const request = vi.fn(async <T>() => ({ changes: [], nextCursor: 0 } as T)) as unknown as ApiRequest;
      await expect(syncNow({
        request,
        session: { userId: 'active-conflict-test', emailVerifiedAt: '2026-10-09T01:00:00.000Z', csrfToken: 'csrf' },
      })).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
      await expect(enqueuePantryMutation('guest', 'pantry_lot', 'queued-during-conflict', 'upsert', {
        id: 'queued-during-conflict',
        ingredientId: 'queued-during-conflict',
        label: 'Pomodoro',
        known: true,
        quantity: null,
        unit: null,
        expiresAt: null,
        createdAt: '2026-10-09T01:00:00.000Z',
        updatedAt: '2026-10-09T01:00:00.000Z',
      })).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
      await waitForPendingQueueWrites();

      expect(request).not.toHaveBeenCalled();
      await expect(readQueuedMutations('guest')).resolves.toEqual([]);
      await expect(indexedDb.readKeyValue(backupKey)).resolves.toMatchObject({ id: 'active-idb-conflict' });
      await expect(indexedDb.readKeyValue('pantry')).resolves.toBeNull();
      expect(deniedKeys).toContain(markerKey);
    } finally {
      deniedPantryReads.mockRestore();
    }
  });

  it('fails closed without replacing a local-only pantry when Web Locks are unavailable', async () => {
    const unavailable = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    const protectedRaw = persistedPantry('protected');
    window.localStorage.setItem(PANTRY_STORAGE_KEY, protectedRaw);
    // @ts-expect-error Vite query IDs provide an isolated module context for a local-only tab.
    const localOnly = await import('./pantryStorage?tab=lock-unavailable');
    await localOnly.readPantrySnapshot();
    const restoreLocks = setNavigatorLocks(undefined);

    try {
      await expect(localOnly.writePantrySnapshot({
        pantryItems: [{ id: 'uncoordinated', label: 'Non coordinato', known: true }],
        stapleIds: [],
      })).rejects.toThrow(/Web Locks/);
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(protectedRaw);
    } finally {
      restoreLocks();
      unavailable.mockRestore();
    }
  });

  it('fails closed without replacing a local-only pantry when the Web Locks request is rejected', async () => {
    const unavailable = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    const protectedRaw = persistedPantry('protected');
    window.localStorage.setItem(PANTRY_STORAGE_KEY, protectedRaw);
    // @ts-expect-error Vite query IDs provide an isolated module context for a local-only tab.
    const localOnly = await import('./pantryStorage?tab=lock-rejected');
    await localOnly.readPantrySnapshot();
    let requestCount = 0;
    const lockManager: TestLockManager = {
      async request() {
        requestCount += 1;
        throw new Error('lock backend rejected');
      },
    };
    const restoreLocks = setNavigatorLocks(lockManager);

    try {
      await expect(localOnly.writePantrySnapshot({
        pantryItems: [{ id: 'uncoordinated', label: 'Non coordinato', known: true }],
        stapleIds: [],
      })).rejects.toThrow(/Web Locks/);
      expect(requestCount).toBe(1);
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(protectedRaw);
    } finally {
      restoreLocks();
      unavailable.mockRestore();
    }
  });

  it('persists a normal local-only pantry write while holding the exclusive Web Lock', async () => {
    const unavailable = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('before'));
    // @ts-expect-error Vite query IDs provide an isolated module context for a local-only tab.
    const localOnly = await import('./pantryStorage?tab=lock-normal');
    await localOnly.readPantrySnapshot();
    const { manager, names } = createSerializedTestLocks();
    const restoreLocks = setNavigatorLocks(manager);

    try {
      await expect(localOnly.writePantrySnapshot({
        pantryItems: [{ id: 'after', label: 'Dopo', known: true }],
        stapleIds: [],
      })).resolves.toBeUndefined();
      expect(names).toEqual(['ikuck:pantry:guest']);
      await expect(localOnly.readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'after' }] });
    } finally {
      restoreLocks();
      unavailable.mockRestore();
    }
  });

  it.each([
    ['readPantrySnapshot', 'unavailable'],
    ['pantryStorage.getItem', 'unavailable'],
    ['readPantrySnapshot', 'rejected'],
    ['pantryStorage.getItem', 'rejected'],
  ] as const)(
    'hydrates an IndexedDB-only guest pantry via %s when Web Locks are %s',
    async (reader, lockFailure) => {
      const raw = persistedPantry('idb-only-guest');
      await indexedDb.writeKeyValue('pantry', raw);
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBeNull();
      const readerTab = reader === 'readPantrySnapshot'
        ? lockFailure === 'unavailable'
          // @ts-expect-error Vite query IDs provide an isolated hydration context.
          ? await import('./pantryStorage?tab=idb-only-snapshot-unavailable')
          // @ts-expect-error Vite query IDs provide an isolated hydration context.
          : await import('./pantryStorage?tab=idb-only-snapshot-rejected')
        : lockFailure === 'unavailable'
          // @ts-expect-error Vite query IDs provide an isolated hydration context.
          ? await import('./pantryStorage?tab=idb-only-adapter-unavailable')
          // @ts-expect-error Vite query IDs provide an isolated hydration context.
          : await import('./pantryStorage?tab=idb-only-adapter-rejected');
      const rejectedRequests: string[] = [];
      const locks: TestLockManager = {
        async request(name) {
          rejectedRequests.push(name);
          throw new Error('lock backend rejected');
        },
      };
      const restoreLocks = setNavigatorLocks(lockFailure === 'unavailable' ? undefined : locks);

      try {
        if (reader === 'readPantrySnapshot') {
          await expect(readerTab.readPantrySnapshot()).resolves.toMatchObject({
            pantryItems: [{ id: 'idb-only-guest' }],
          });
        } else {
          const hydrated = await readerTab.pantryStorage.getItem(PANTRY_STORAGE_KEY);
          expect(hydrated).not.toBeNull();
          expect(JSON.parse(hydrated as string)).toMatchObject({
            state: { pantryItems: [{ id: 'idb-only-guest' }] },
          });
        }
        expect(await indexedDb.readKeyValue('pantry')).toBe(raw);
        expect(rejectedRequests).toEqual([]);
      } finally {
        restoreLocks();
      }
    },
  );

  it.each(['readPantrySnapshot', 'pantryStorage.getItem'] as const)(
    'rereads a concurrent IndexedDB pantry after Web-Lock migration coordination fails via %s',
    async (reader) => {
      const writerSnapshot = {
        pantryItems: [{ id: 'appeared-during-lock-failure', label: 'Pasta', known: true }],
        stapleIds: [],
      };
      // @ts-expect-error Vite query IDs provide isolated contexts for concurrent tabs.
      const readerSnapshotTab = await import('./pantryStorage?tab=lock-failure-reread-snapshot');
      // @ts-expect-error Vite query IDs provide isolated contexts for concurrent tabs.
      const readerAdapterTab = await import('./pantryStorage?tab=lock-failure-reread-adapter');
      const writerTab = reader === 'readPantrySnapshot'
        // @ts-expect-error Vite query IDs provide isolated contexts for concurrent tabs.
        ? await import('./pantryStorage?tab=lock-failure-reread-writer-snapshot')
        // @ts-expect-error Vite query IDs provide isolated contexts for concurrent tabs.
        : await import('./pantryStorage?tab=lock-failure-reread-writer-adapter');
      let requestCount = 0;
      const locks: TestLockManager = {
        async request(_name, _options, callback) {
          requestCount += 1;
          if (requestCount === 1) {
            await writerTab.writePantrySnapshot(writerSnapshot, 'guest');
            throw new Error('migration lock failed after a concurrent commit');
          }
          return callback();
        },
      };
      const restoreLocks = setNavigatorLocks(locks);
      const originalSetItem = Storage.prototype.setItem;
      const mirrorWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
        return originalSetItem.call(this, key, value);
      });
      const readerTab = reader === 'readPantrySnapshot' ? readerSnapshotTab : readerAdapterTab;

      try {
        if (reader === 'readPantrySnapshot') {
          await expect(readerTab.readPantrySnapshot()).resolves.toMatchObject({
            pantryItems: [{ id: 'appeared-during-lock-failure' }],
          });
        } else {
          const hydrated = await readerTab.pantryStorage.getItem(PANTRY_STORAGE_KEY);
          expect(hydrated).not.toBeNull();
          expect(JSON.parse(hydrated as string)).toMatchObject({
            state: { pantryItems: [{ id: 'appeared-during-lock-failure' }] },
          });
        }
        expect(await indexedDb.readKeyValue<string>('pantry')).toContain('appeared-during-lock-failure');
        expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBeNull();
        expect(requestCount).toBe(2);
      } finally {
        mirrorWrite.mockRestore();
        restoreLocks();
      }
    },
  );

  it('preserves both independent local-only writer snapshots as a conflict under Web Locks', async () => {
    const unavailable = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('initial'));
    // @ts-expect-error Vite query IDs provide isolated module contexts for independent tabs.
    const tabAImport = import('./pantryStorage?tab=local-only-writer-a');
    // @ts-expect-error Vite query IDs provide isolated module contexts for independent tabs.
    const tabBImport = import('./pantryStorage?tab=local-only-writer-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]) as [
      typeof import('./pantryStorage'),
      typeof import('./pantryStorage'),
    ];
    await Promise.all([tabA.readPantrySnapshot(), tabB.readPantrySnapshot()]);
    const { manager } = createSerializedTestLocks();
    const restoreLocks = setNavigatorLocks(manager);

    try {
      const results = await Promise.allSettled([
        tabA.writePantrySnapshot({ pantryItems: [{ id: 'tab-a', label: 'Scheda A', known: true }], stapleIds: [] }),
        tabB.writePantrySnapshot({ pantryItems: [{ id: 'tab-b', label: 'Scheda B', known: true }], stapleIds: [] }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const backup = await tabA.readPantryConflictBackup('guest');
      const savedIds = backup?.copies.flatMap((copy) => copy.snapshot.pantryItems.map((item) => item.id));
      expect(savedIds).toEqual(expect.arrayContaining(['tab-a', 'tab-b']));
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toMatch(/tab-a|tab-b/);
    } finally {
      restoreLocks();
      unavailable.mockRestore();
    }
  });

  it('keeps localStorage-only active conflict copies visible and recoverable after IndexedDB returns', async () => {
    const localOnly = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    let localOnlyActive = true;
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('initial'));
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabAImport = import('./pantryStorage?tab=local-conflict-transition-a');
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabBImport = import('./pantryStorage?tab=local-conflict-transition-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]) as [
      typeof import('./pantryStorage'),
      typeof import('./pantryStorage'),
    ];
    await Promise.all([tabA.readPantrySnapshot(), tabB.readPantrySnapshot()]);
    const restoreLocks = setNavigatorLocks(createSerializedTestLocks().manager);
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;

    try {
      const results = await Promise.allSettled([
        tabA.writePantrySnapshot({ pantryItems: [{ id: 'tab-a', label: 'Scheda A', known: true }], stapleIds: [] }),
        tabB.writePantrySnapshot({ pantryItems: [{ id: 'tab-b', label: 'Scheda B', known: true }], stapleIds: [] }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const localBackupRaw = window.localStorage.getItem(backupKey);
      expect(localBackupRaw).not.toBeNull();
      const localBackup = JSON.parse(localBackupRaw ?? '{}') as {
        id: string;
        copies?: Array<{ id: string; snapshot: { pantryItems: Array<{ id: string }> } }>;
      };
      expect(localBackup.copies?.map((copy) => copy.snapshot.pantryItems[0]?.id)).toEqual(
        expect.arrayContaining(['tab-a', 'tab-b']),
      );
      expect(window.localStorage.getItem(markerKey)).toBe('1');
      expect(await indexedDb.readKeyValue(backupKey)).toBeNull();

      localOnly.mockRestore();
      localOnlyActive = false;
      // @ts-expect-error Vite query IDs provide a fresh module context after reload.
      const reloaded = await import('./pantryStorage?tab=local-conflict-transition-after-idb') as typeof import('./pantryStorage');
      const failedMigrationWrite = vi.spyOn(indexedDb, 'updateKeyValue').mockImplementation(async () => {
        throw new Error('simulated conflict backup migration failure');
      });
      let failedMigration: { status: 'fulfilled' } | { status: 'rejected'; error: unknown };
      try {
        failedMigration = await reloaded.recoverPantrySnapshot('guest', 'concurrent-write').then(
          () => ({ status: 'fulfilled' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
      } finally {
        failedMigrationWrite.mockRestore();
      }
      expect(failedMigration).toMatchObject({
        status: 'rejected',
        error: { message: 'simulated conflict backup migration failure' },
      });
      expect(window.localStorage.getItem(backupKey)).toBe(localBackupRaw);
      expect(window.localStorage.getItem(markerKey)).toBe('1');
      expect(await indexedDb.readKeyValue(backupKey)).toBeNull();

      const visible = await reloaded.readPantryConflictBackup('guest');
      const expectedSelectedId = localBackup.copies?.find((copy) => copy.id === 'concurrent-write')
        ?.snapshot.pantryItems[0]?.id;
      const recovery = await reloaded.recoverPantrySnapshot('guest', 'concurrent-write').then(
        (snapshot) => ({ status: 'fulfilled' as const, snapshot }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      const archived = await indexedDb.readKeyValue<{ entries: Array<{
        selectedCopyId: string;
        copies: Array<{ id: string; snapshot: { pantryItems: Array<{ id: string }> } }>;
      }> }>(scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'));
      const canonical = await indexedDb.readKeyValue<string>('pantry');
      const backupAfter = await indexedDb.readKeyValue<{
        id: string;
        copies: Array<{ id: string }>;
        resolvedAt?: string;
        selectedCopyId?: string;
      }>(backupKey);

      expect({
        visibleCopies: visible?.copies.map((copy) => copy.id),
        recoveryStatus: recovery.status,
        recoveredId: recovery.status === 'fulfilled' ? recovery.snapshot.pantryItems[0]?.id : null,
        archived: archived?.entries[0],
        canonicalId: canonical === null ? null : (JSON.parse(canonical) as { state?: { pantryItems?: Array<{ id: string }> } })
          .state?.pantryItems?.[0]?.id,
        backupAfter: backupAfter === null ? null : {
          id: backupAfter.id,
          copyIds: backupAfter.copies.map((copy) => copy.id),
          selectedCopyId: backupAfter.selectedCopyId,
          resolved: typeof backupAfter.resolvedAt === 'string',
        },
        localBackupAfter: window.localStorage.getItem(backupKey),
        marker: window.localStorage.getItem(markerKey),
      }).toMatchObject({
        visibleCopies: ['local-storage', 'concurrent-write'],
        recoveryStatus: 'fulfilled',
        recoveredId: expectedSelectedId,
        archived: {
          selectedCopyId: 'concurrent-write',
          copies: expect.arrayContaining([
            expect.objectContaining({ id: 'local-storage', snapshot: expect.objectContaining({ pantryItems: [{ id: 'tab-a', label: 'Scheda A', known: true }] }) }),
            expect.objectContaining({ id: 'concurrent-write', snapshot: expect.objectContaining({ pantryItems: [{ id: 'tab-b', label: 'Scheda B', known: true }] }) }),
          ]),
        },
        canonicalId: expectedSelectedId,
        backupAfter: {
          id: localBackup.id,
          copyIds: ['local-storage', 'concurrent-write'],
          selectedCopyId: 'concurrent-write',
          resolved: true,
        },
        localBackupAfter: null,
        marker: null,
      });
      expect(await indexedDb.readKeyValue(backupKey)).not.toBeNull();

      const lateLocalBackup = {
        id: 'late-local-conflict',
        scope: 'guest',
        reason: 'concurrent-write',
        createdAt: '2026-10-09T00:00:00.000Z',
        copies: [{
          id: 'late-local-copy',
          label: 'Copia localStorage successiva',
          revision: null,
          snapshot: { pantryItems: [{ id: 'late-local-copy', label: 'Copia locale', known: true }], stapleIds: [] },
        }],
      };
      window.localStorage.setItem(backupKey, JSON.stringify(lateLocalBackup));
      window.localStorage.setItem(markerKey, '1');
      const mergedVisible = await reloaded.readPantryConflictBackup('guest');
      const mergedRecovery = await reloaded.recoverPantrySnapshot('guest', 'late-local-copy');
      const archiveAfterMerge = await indexedDb.readKeyValue<{ entries: Array<{
        selectedCopyId: string;
        copies: Array<{ id: string; snapshot: { pantryItems: Array<{ id: string }> } }>;
      }> }>(scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'));
      const finalCanonical = await indexedDb.readKeyValue<string>('pantry');

      expect(mergedVisible?.id).toBe(lateLocalBackup.id);
      expect(mergedVisible?.copies.map((copy) => copy.id)).toEqual(['late-local-copy']);
      expect(mergedRecovery.pantryItems).toMatchObject([{ id: 'late-local-copy' }]);
      expect(archiveAfterMerge?.entries).toHaveLength(2);
      expect(archiveAfterMerge?.entries[0]).toEqual(archived?.entries[0]);
      expect(archiveAfterMerge?.entries[1]).toMatchObject({
        id: lateLocalBackup.id,
        selectedCopyId: 'late-local-copy',
      });
      expect(archiveAfterMerge?.entries[1]?.copies.map((copy) => copy.id)).toEqual(['late-local-copy']);
      expect(JSON.parse(finalCanonical ?? '{}')).toMatchObject({ state: { pantryItems: [{ id: 'late-local-copy' }] } });
      expect(window.localStorage.getItem(markerKey)).toBeNull();
    } finally {
      if (localOnlyActive) localOnly.mockRestore();
      restoreLocks();
    }
  });

  it.each([
    { markerLabel: 'without a marker', markerValue: null },
    { markerLabel: 'with an active marker', markerValue: '1' },
  ])('keeps a newer local-only pantry conflict recoverable beside resolved IndexedDB history $markerLabel', async ({ markerValue }) => {
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
    const previousBackup = {
      id: 'previously-resolved-conflict',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      copies: [
        {
          id: 'historical-selected',
          label: 'Copia recuperata precedente',
          revision: 10,
          snapshot: { pantryItems: [{ id: 'historical-selected', label: 'Pasta', known: true }], stapleIds: [] },
        },
        {
          id: 'historical-alternative',
          label: 'Alternativa precedente',
          revision: 11,
          snapshot: { pantryItems: [{ id: 'historical-alternative', label: 'Riso', known: true }], stapleIds: [] },
        },
      ],
    };
    await indexedDb.writeKeyValue(backupKey, previousBackup);
    // @ts-expect-error Vite query IDs provide an isolated module context for the prior recovery.
    const previousRecovery = await import('./pantryStorage?tab=resolved-idb-conflict-history');
    await expect(previousRecovery.recoverPantrySnapshot('guest', 'historical-selected')).resolves.toMatchObject({
      pantryItems: [{ id: 'historical-selected' }],
    });
    const resolvedHistory = await indexedDb.readKeyValue<{ id: string; resolvedAt?: string }>(backupKey);
    const historyBefore = await indexedDb.readKeyValue<{ entries: Array<{ id: string; selectedCopyId: string }> }>(archiveKey);
    expect(resolvedHistory).toMatchObject({ id: previousBackup.id, resolvedAt: expect.any(String) });
    expect(historyBefore?.entries).toMatchObject([{ id: previousBackup.id, selectedCopyId: 'historical-selected' }]);
    expect(window.localStorage.getItem(markerKey)).toBeNull();

    const localBackup = {
      id: 'new-local-only-conflict',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T02:00:00.000Z',
      copies: [
        {
          id: 'local-active-choice',
          label: 'Copia locale attiva',
          revision: 12,
          snapshot: { pantryItems: [{ id: 'local-active-choice', label: 'Fagioli', known: true }], stapleIds: ['salt'] },
        },
        {
          id: 'local-active-alternative',
          label: 'Alternativa locale',
          revision: 13,
          snapshot: { pantryItems: [{ id: 'local-active-alternative', label: 'Orzo', known: true }], stapleIds: [] },
        },
      ],
    };
    window.localStorage.setItem(backupKey, JSON.stringify(localBackup));
    if (markerValue !== null) window.localStorage.setItem(markerKey, markerValue);
    expect(window.localStorage.getItem(markerKey)).toBe(markerValue);
    // @ts-expect-error Vite query IDs provide an isolated module context after reload.
    const reloaded = await import('./pantryStorage?tab=local-conflict-after-resolved-idb');

    const visible = await reloaded.readPantryConflictBackup('guest');
    expect(visible).toMatchObject({
      id: localBackup.id,
      copies: [{ id: 'local-active-choice' }, { id: 'local-active-alternative' }],
    });
    expect(visible?.resolvedAt).toBeUndefined();
    expect(window.localStorage.getItem(markerKey)).toBe(markerValue);
    await expect(reloaded.getPantrySnapshotConflictError('guest')).resolves.toMatchObject({
      code: 'pantry_snapshot_conflict',
      copies: [{ id: 'local-active-choice' }, { id: 'local-active-alternative' }],
    });
    expect(reloaded.isPantrySnapshotConflictActive('guest')).toBe(true);
    await expect(reloaded.readPantrySnapshot('guest')).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
    await expect(reloaded.pantryStorage.getItem(PANTRY_STORAGE_KEY)).rejects.toMatchObject({
      code: 'pantry_snapshot_conflict',
    });
    await expect(reloaded.writePantrySnapshot({
      pantryItems: [{ id: 'blocked-write', label: 'Scrittura bloccata', known: true }],
      stapleIds: [],
    }, 'guest')).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });

    await expect(reloaded.recoverPantrySnapshot('guest', 'local-active-choice')).resolves.toMatchObject({
      pantryItems: [{ id: 'local-active-choice' }],
      stapleIds: ['salt'],
    });
    const recoveredBackup = await indexedDb.readKeyValue<{
      id: string;
      resolvedAt?: string;
      selectedCopyId?: string;
      copies: Array<{ id: string }>;
    }>(backupKey);
    const historyAfter = await indexedDb.readKeyValue<{ entries: Array<{
      id: string;
      selectedCopyId: string;
      copies: Array<{ id: string }>;
      resolvedAt?: string;
    }> }>(archiveKey);
    expect(recoveredBackup).toMatchObject({
      id: localBackup.id,
      resolvedAt: expect.any(String),
      selectedCopyId: 'local-active-choice',
      copies: [{ id: 'local-active-choice' }, { id: 'local-active-alternative' }],
    });
    expect(historyAfter?.entries).toHaveLength(2);
    expect(historyAfter?.entries.find((entry) => entry.id === previousBackup.id)).toEqual(
      historyBefore?.entries.find((entry) => entry.id === previousBackup.id),
    );
    expect(historyAfter?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: previousBackup.id, selectedCopyId: 'historical-selected' }),
      expect.objectContaining({ id: localBackup.id, selectedCopyId: 'local-active-choice' }),
    ]));
    expect(window.localStorage.getItem(markerKey)).toBeNull();
  });

  it('does not reopen resolved IndexedDB history without a marker or active local backup', async () => {
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
    await indexedDb.writeKeyValue(backupKey, {
      id: 'resolved-only-history',
      scope: 'guest',
      reason: 'concurrent-write',
      createdAt: '2026-10-08T10:00:00.000Z',
      resolvedAt: '2026-10-08T11:00:00.000Z',
      selectedCopyId: 'resolved-copy',
      copies: [{
        id: 'resolved-copy',
        label: 'Copia recuperata',
        revision: 10,
        snapshot: { pantryItems: [{ id: 'resolved-copy', label: 'Pasta', known: true }], stapleIds: [] },
      }],
    });
    expect(window.localStorage.getItem(backupKey)).toBeNull();
    expect(window.localStorage.getItem(markerKey)).toBeNull();
    // @ts-expect-error Vite query IDs provide an isolated module context after reload.
    const reloaded = await import('./pantryStorage?tab=resolved-only-history-without-marker');

    await expect(reloaded.readPantryConflictBackup('guest')).resolves.toBeNull();
    await expect(reloaded.getPantrySnapshotConflictError('guest')).resolves.toBeNull();
    expect(reloaded.isPantrySnapshotConflictActive('guest')).toBe(false);
  });

  it('does not reactivate resolved history in the same tab when marker reads are denied during recovery', async () => {
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
    const activeBackup = {
      id: 'same-tab-recovery-marker-denied',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T01:00:00.000Z',
      copies: [
        {
          id: 'same-tab-winner',
          label: 'Copia recuperata',
          revision: 10,
          snapshot: { pantryItems: [{ id: 'same-tab-winner', label: 'Pasta', known: true }], stapleIds: ['salt'] },
        },
        {
          id: 'same-tab-alternative',
          label: 'Alternativa precedente',
          revision: 11,
          snapshot: { pantryItems: [{ id: 'same-tab-alternative', label: 'Riso', known: true }], stapleIds: [] },
        },
      ],
    };
    await indexedDb.writeKeyValue(backupKey, activeBackup);
    window.localStorage.setItem(markerKey, '1');
    await expect(readPantrySnapshot('guest')).rejects.toMatchObject({
      code: 'pantry_snapshot_conflict',
      copies: [{ id: 'same-tab-winner' }, { id: 'same-tab-alternative' }],
    });

    const originalGetItem = Storage.prototype.getItem;
    const deniedMarkerReads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === markerKey) throw new DOMException('Marker read denied', 'SecurityError');
      return originalGetItem.call(this, key);
    });

    try {
      await expect(recoverPantrySnapshot('guest', 'same-tab-winner')).resolves.toMatchObject({
        pantryItems: [{ id: 'same-tab-winner' }],
        stapleIds: ['salt'],
      });
      await expect(indexedDb.readKeyValue(backupKey)).resolves.toMatchObject({
        id: activeBackup.id,
        resolvedAt: expect.any(String),
        selectedCopyId: 'same-tab-winner',
      });
      await expect(readPantryConflictBackup('guest')).resolves.toBeNull();
      await expect(getPantrySnapshotConflictError('guest')).resolves.toBeNull();
      expect(isPantrySnapshotConflictActive('guest')).toBe(false);
      await expect(readPantrySnapshot('guest')).resolves.toMatchObject({
        pantryItems: [{ id: 'same-tab-winner' }],
        stapleIds: ['salt'],
      });
      await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.toContain('same-tab-winner');
    } finally {
      deniedMarkerReads.mockRestore();
    }
  });

  it('keeps resolved IndexedDB history closed when the localStorage conflict marker cannot be read', async () => {
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
    const resolvedBackup = {
      id: 'resolved-history-marker-denied',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T01:00:00.000Z',
      copies: [
        {
          id: 'resolved-history-winner',
          label: 'Copia recuperata',
          revision: 10,
          snapshot: { pantryItems: [{ id: 'resolved-history-winner', label: 'Pasta', known: true }], stapleIds: ['salt'] },
        },
        {
          id: 'resolved-history-alternative',
          label: 'Alternativa precedente',
          revision: 11,
          snapshot: { pantryItems: [{ id: 'resolved-history-alternative', label: 'Riso', known: true }], stapleIds: [] },
        },
      ],
    };
    await indexedDb.writeKeyValue(backupKey, resolvedBackup);
    await expect(recoverPantrySnapshot('guest', 'resolved-history-winner')).resolves.toMatchObject({
      pantryItems: [{ id: 'resolved-history-winner' }],
    });
    expect(await indexedDb.readKeyValue(backupKey)).toMatchObject({
      id: resolvedBackup.id,
      resolvedAt: expect.any(String),
    });
    expect(window.localStorage.getItem(markerKey)).toBeNull();

    const originalGetItem = Storage.prototype.getItem;
    const deniedPantryReads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key.includes('pantry')) throw new DOMException('Storage disabled', 'SecurityError');
      return originalGetItem.call(this, key);
    });

    try {
      // @ts-expect-error Vite query IDs provide an isolated storage context after reload.
      const reloaded = await import('./pantryStorage?tab=resolved-history-marker-read-denied');
      await expect(reloaded.readPantryConflictBackup('guest')).resolves.toBeNull();
      await expect(reloaded.getPantrySnapshotConflictError('guest')).resolves.toBeNull();
      expect(reloaded.isPantrySnapshotConflictActive('guest')).toBe(false);
      await expect(reloaded.readPantrySnapshot('guest')).resolves.toMatchObject({
        pantryItems: [{ id: 'resolved-history-winner' }],
        stapleIds: ['salt'],
      });
      await expect(reloaded.pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.toContain('resolved-history-winner');
    } finally {
      deniedPantryReads.mockRestore();
    }
  });

  it('keeps a distinct active local backup conflicted when its marker cannot be read', async () => {
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
    await indexedDb.writeKeyValue(backupKey, {
      id: 'resolved-idb-history-for-local-backup',
      scope: 'guest',
      reason: 'concurrent-write',
      createdAt: '2026-10-09T01:00:00.000Z',
      copies: [
        {
          id: 'resolved-idb-choice',
          label: 'Copia IDB',
          revision: 10,
          snapshot: { pantryItems: [{ id: 'resolved-idb-choice', label: 'Pasta', known: true }], stapleIds: [] },
        },
        {
          id: 'resolved-idb-alternative',
          label: 'Alternativa IDB',
          revision: 11,
          snapshot: { pantryItems: [{ id: 'resolved-idb-alternative', label: 'Riso', known: true }], stapleIds: [] },
        },
      ],
    });
    await expect(recoverPantrySnapshot('guest', 'resolved-idb-choice')).resolves.toMatchObject({
      pantryItems: [{ id: 'resolved-idb-choice' }],
    });
    const localBackup = {
      id: 'distinct-active-local-backup',
      scope: 'guest',
      reason: 'concurrent-write',
      createdAt: '2026-10-09T02:00:00.000Z',
      copies: [
        {
          id: 'local-conflict-a',
          label: 'Copia locale A',
          revision: 12,
          snapshot: { pantryItems: [{ id: 'local-conflict-a', label: 'Fagioli', known: true }], stapleIds: [] },
        },
        {
          id: 'local-conflict-b',
          label: 'Copia locale B',
          revision: 13,
          snapshot: { pantryItems: [{ id: 'local-conflict-b', label: 'Orzo', known: true }], stapleIds: [] },
        },
      ],
    };
    window.localStorage.setItem(backupKey, JSON.stringify(localBackup));
    expect(window.localStorage.getItem(markerKey)).toBeNull();

    const originalGetItem = Storage.prototype.getItem;
    const deniedMarkerRead = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === markerKey) throw new DOMException('Storage disabled', 'SecurityError');
      return originalGetItem.call(this, key);
    });

    try {
      // @ts-expect-error Vite query IDs provide a fresh persisted-storage module context.
      const reloaded = await import('./pantryStorage?tab=active-local-backup-marker-read-denied');
      await expect(reloaded.readPantryConflictBackup('guest')).resolves.toMatchObject({
        id: localBackup.id,
        copies: [{ id: 'local-conflict-a' }, { id: 'local-conflict-b' }],
      });
      await expect(reloaded.getPantrySnapshotConflictError('guest')).resolves.toMatchObject({
        code: 'pantry_snapshot_conflict',
        copies: [{ id: 'local-conflict-a' }, { id: 'local-conflict-b' }],
      });
      await expect(reloaded.readPantrySnapshot('guest')).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
    } finally {
      deniedMarkerRead.mockRestore();
    }
  });

  it.each([
    { source: 'indexeddb', marker: 'present' },
    { source: 'indexeddb', marker: 'absent' },
    { source: 'localStorage', marker: 'present' },
    { source: 'localStorage', marker: 'absent' },
  ] as const)(
    'treats an empty persisted $source conflict backup as corruption with marker $marker',
    async ({ source, marker }) => {
      const scope = 'guest';
      const otherScope = 'account:empty-backup-isolation';
      const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
      const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
      const backup = {
        id: `empty-${source}-${marker}`,
        scope,
        reason: 'concurrent-write',
        createdAt: '2026-10-09T01:00:00.000Z',
        copies: [],
      };
      const rawBackup = JSON.stringify(backup);
      if (source === 'indexeddb') await indexedDb.writeKeyValue(backupKey, backup);
      else window.localStorage.setItem(backupKey, rawBackup);
      if (marker === 'present') window.localStorage.setItem(markerKey, '1');
      else window.localStorage.removeItem(markerKey);
      await indexedDb.writeKeyValue(scopeStorageKey(otherScope, 'pantry'), persistedPantry('other-scope-before'));

      const reloadPantryStorage = async () => {
        switch (`${source}-${marker}`) {
          case 'indexeddb-present':
            // @ts-expect-error Vite query IDs create a fresh module context like a page reload.
            return import('./pantryStorage?tab=empty-backup-indexeddb-present') as typeof import('./pantryStorage');
          case 'indexeddb-absent':
            // @ts-expect-error Vite query IDs create a fresh module context like a page reload.
            return import('./pantryStorage?tab=empty-backup-indexeddb-absent') as typeof import('./pantryStorage');
          case 'localStorage-present':
            // @ts-expect-error Vite query IDs create a fresh module context like a page reload.
            return import('./pantryStorage?tab=empty-backup-localstorage-present') as typeof import('./pantryStorage');
          case 'localStorage-absent':
            // @ts-expect-error Vite query IDs create a fresh module context like a page reload.
            return import('./pantryStorage?tab=empty-backup-localstorage-absent') as typeof import('./pantryStorage');
          default:
            throw new Error('Unsupported empty-backup fixture');
        }
      };
      const conflictBoundary = await reloadPantryStorage();
      const expectCorruption = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        corruptedBackup: true,
        copies: [],
      });

      await expectCorruption(conflictBoundary.readPantryConflictBackup(scope));
      await expect(conflictBoundary.getPantrySnapshotConflictError(scope)).resolves.toMatchObject({
        code: 'pantry_snapshot_conflict',
        corruptedBackup: true,
        copies: [],
      });
      expect(conflictBoundary.isPantrySnapshotConflictActive(scope)).toBe(true);
      await expectCorruption(conflictBoundary.readPantrySnapshot(scope));
      await expectCorruption(Promise.resolve(conflictBoundary.pantryStorage.getItem(PANTRY_STORAGE_KEY)));
      await expectCorruption(conflictBoundary.writePantrySnapshot({
        pantryItems: [{ id: 'must-not-overwrite-empty-backup', label: 'Non sovrascrivere', known: true }],
        stapleIds: [],
      }, scope));
      await expectCorruption(conflictBoundary.recoverPantrySnapshot(scope, 'unavailable-copy'));

      const request = vi.fn(async <T>() => ({ changes: [], nextCursor: 0 } as T)) as unknown as ApiRequest;
      await expectCorruption(syncNow({
        request,
        session: { userId: 'empty-backup-test', emailVerifiedAt: '2026-10-09T01:00:00.000Z', csrfToken: 'csrf' },
        isSessionCurrent: () => true,
      }));
      await expect(enqueuePantryMutation(scope, 'pantry_lot', 'blocked-empty-backup', 'upsert', {
        id: 'blocked-empty-backup',
        ingredientId: 'blocked-empty-backup',
        label: 'Pomodoro',
        known: true,
        quantity: null,
        unit: null,
        expiresAt: null,
        createdAt: '2026-10-09T01:00:00.000Z',
        updatedAt: '2026-10-09T01:00:00.000Z',
      })).rejects.toMatchObject({ code: 'pantry_snapshot_conflict', corruptedBackup: true });
      await waitForPendingQueueWrites();

      expect(request).not.toHaveBeenCalled();
      await expect(readQueuedMutations(scope)).resolves.toEqual([]);
      if (source === 'indexeddb') {
        await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(backup);
        expect(window.localStorage.getItem(backupKey)).toBeNull();
      } else {
        expect(window.localStorage.getItem(backupKey)).toBe(rawBackup);
        await expect(indexedDb.readKeyValue(backupKey)).resolves.toBeNull();
      }
      if (marker === 'present') expect(window.localStorage.getItem(markerKey)).toBe('1');
      else expect(window.localStorage.getItem(markerKey)).toBeNull();

      await expect(conflictBoundary.readPantrySnapshot(otherScope)).resolves.toMatchObject({
        pantryItems: [{ id: 'other-scope-before' }],
      });
      await expect(conflictBoundary.writePantrySnapshot({
        pantryItems: [{ id: 'other-scope-after', label: 'Ambito indipendente', known: true }],
        stapleIds: [],
      }, otherScope)).resolves.toBeUndefined();
      await expect(conflictBoundary.readPantrySnapshot(otherScope)).resolves.toMatchObject({
        pantryItems: [{ id: 'other-scope-after' }],
      });
    },
  );

  it.each(['guest', 'account:collision-test', 'house:collision-test'] as const)(
    'keeps active-copy IDs unique through union and recovery in %s scope',
    async (scope) => {
      const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
      const markerKey = `${scopeStorageKey(scope, PANTRY_STORAGE_KEY)}-conflict`;
      const localBackupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
      const indexedBackup = {
        id: 'same-conflict',
        scope,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-09T08:00:00.000Z',
        copies: [
          {
            id: 'local-storage-3',
            label: 'Prima',
            revision: 10,
            snapshot: { pantryItems: [{ id: 'first', label: 'Prima', known: true }], stapleIds: [] },
          },
          {
            id: 'local-storage',
            label: 'Seconda',
            revision: 11,
            snapshot: { pantryItems: [{ id: 'second', label: 'Seconda', known: true }], stapleIds: [] },
          },
        ],
      };
      const localBackup = {
        ...indexedBackup,
        copies: [{
          id: 'local-storage',
          label: 'Terza',
          revision: 12,
          snapshot: { pantryItems: [{ id: 'desired-third', label: 'Terza', known: true }], stapleIds: [] },
        }],
      };
      await indexedDb.writeKeyValue(backupKey, indexedBackup);
      const indexedRawBefore = await indexedDb.readKeyValue(backupKey);
      const localRawBefore = JSON.stringify(localBackup);
      window.localStorage.setItem(localBackupKey, localRawBefore);
      window.localStorage.setItem(markerKey, '1');

      const visible = await readPantryConflictBackup(scope);
      expect(visible?.copies.map((copy) => copy.id)).toEqual([
        'local-storage-3', 'local-storage', 'local-storage-4',
      ]);
      expect(new Set(visible?.copies.map((copy) => copy.id)).size).toBe(3);
      await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(indexedRawBefore);
      expect(window.localStorage.getItem(localBackupKey)).toBe(localRawBefore);

      await expect(recoverPantrySnapshot(scope, visible!.copies[2]!.id)).resolves.toMatchObject({
        pantryItems: [{ id: 'desired-third' }],
      });
      const archive = await readPantryConflictArchive(scope);
      expect(archive).toHaveLength(1);
      expect(archive[0]?.copies.map((copy) => copy.id)).toEqual([
        'local-storage-3', 'local-storage', 'local-storage-4',
      ]);
      expect(archive[0]?.selectedCopyId).toBe('local-storage-4');
      expect(archive[0]?.copies.find((copy) => copy.id === archive[0]?.selectedCopyId)
        ?.snapshot.pantryItems[0]?.id).toBe('desired-third');
    },
  );

  it.each(['guest', 'account:duplicate-test', 'house:duplicate-test'] as const)(
    'recovers a persisted backup with duplicate IDs without changing its raw snapshots in %s scope',
    async (scope) => {
      const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
      const markerKey = `${scopeStorageKey(scope, PANTRY_STORAGE_KEY)}-conflict`;
      const backup = {
        id: `duplicate-${scope}`,
        scope,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-09T08:10:00.000Z',
        copies: [
          {
            id: 'copy',
            label: 'Prima',
            revision: 10,
            snapshot: { pantryItems: [{ id: 'first-copy', label: 'Prima', known: true }], stapleIds: [] },
          },
          {
            id: 'copy',
            label: 'Seconda',
            revision: 11,
            snapshot: { pantryItems: [{ id: 'selected-copy', label: 'Seconda', known: true }], stapleIds: [] },
          },
          {
            id: 'copy-2',
            label: 'Terza',
            revision: 12,
            snapshot: { pantryItems: [{ id: 'third-copy', label: 'Terza', known: true }], stapleIds: [] },
          },
        ],
      };
      await indexedDb.writeKeyValue(backupKey, backup);
      const rawBefore = await indexedDb.readKeyValue(backupKey);
      window.localStorage.setItem(markerKey, '1');

      const visible = await readPantryConflictBackup(scope);
      expect(visible?.copies.map((copy) => copy.id)).toEqual(['copy', 'copy-3', 'copy-2']);
      await expect(getPantrySnapshotConflictError(scope)).resolves.toMatchObject({
        copies: [{ id: 'copy' }, { id: 'copy-3' }, { id: 'copy-2' }],
      });
      await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(rawBefore);

      await expect(recoverPantrySnapshot(scope, 'copy-3')).resolves.toMatchObject({
        pantryItems: [{ id: 'selected-copy' }],
      });
      const archive = await readPantryConflictArchive(scope);
      expect(archive[0]?.copies.map((copy) => copy.id)).toEqual(['copy', 'copy-3', 'copy-2']);
      expect(archive[0]?.selectedCopyId).toBe('copy-3');
      expect(archive[0]?.copies.find((copy) => copy.id === 'copy-3')?.snapshot.pantryItems[0]?.id)
        .toBe('selected-copy');
      // @ts-expect-error Vite query IDs provide an isolated module context for a reload-like read.
      const reloaded = await import('./pantryStorage?tab=duplicate-id-recovery-archive-reload') as typeof import('./pantryStorage');
      await expect(reloaded.readPantryConflictArchive(scope)).resolves.toMatchObject([
        expect.objectContaining({
          selectedCopyId: 'copy-3',
          copies: expect.arrayContaining([expect.objectContaining({
            id: 'copy-3', snapshot: expect.objectContaining({ pantryItems: [expect.objectContaining({ id: 'selected-copy' })] }),
          })]),
        }),
      ]);
    },
  );

  it('repairs duplicate localStorage copy IDs before recovery while preserving the raw backup until selection', async () => {
    const scope = 'guest';
    const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
    const backup = {
      id: 'local-duplicate-backup',
      scope,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T08:15:00.000Z',
      copies: [
        {
          id: 'local-copy',
          label: 'Prima',
          revision: 20,
          snapshot: { pantryItems: [{ id: 'local-first', label: 'Prima', known: true }], stapleIds: [] },
        },
        {
          id: 'local-copy',
          label: 'Seconda',
          revision: 21,
          snapshot: { pantryItems: [{ id: 'local-selected', label: 'Seconda', known: true }], stapleIds: [] },
        },
        {
          id: 'local-copy-2',
          label: 'Terza',
          revision: 22,
          snapshot: { pantryItems: [{ id: 'local-third', label: 'Terza', known: true }], stapleIds: [] },
        },
      ],
    };
    const rawBefore = JSON.stringify(backup);
    window.localStorage.setItem(backupKey, rawBefore);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');

    const visible = await readPantryConflictBackup(scope);
    expect(visible?.copies.map((copy) => copy.id)).toEqual(['local-copy', 'local-copy-3', 'local-copy-2']);
    expect(window.localStorage.getItem(backupKey)).toBe(rawBefore);

    await expect(recoverPantrySnapshot(scope, 'local-copy-3')).resolves.toMatchObject({
      pantryItems: [{ id: 'local-selected' }],
    });
    const archive = await readPantryConflictArchive(scope);
    expect(archive[0]?.selectedCopyId).toBe('local-copy-3');
    expect(archive[0]?.copies.map((copy) => copy.id)).toEqual(['local-copy', 'local-copy-3', 'local-copy-2']);
    // @ts-expect-error Vite query IDs provide an isolated module context for a reload-like read.
    const reloaded = await import('./pantryStorage?tab=local-duplicate-recovery-archive-reload') as typeof import('./pantryStorage');
    await expect(reloaded.readPantryConflictArchive('guest')).resolves.toMatchObject([
      expect.objectContaining({
        selectedCopyId: 'local-copy-3',
        copies: expect.arrayContaining([expect.objectContaining({
          id: 'local-copy-3', snapshot: expect.objectContaining({ pantryItems: [expect.objectContaining({ id: 'local-selected' })] }),
        })]),
      }),
    ]);
  });

  it.each(['indexed-db', 'local-storage'] as const)(
    'fails closed when legacy recoveryPendingCopyId ambiguously names distinct snapshots from %s after reload',
    async (source) => {
      const scope = 'guest';
      const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
      const archiveKey = scopeStorageKey(scope, 'ikuck-pantry-conflict-archive-v1');
      const backup = {
        id: `pending-ambiguous-${source}`,
        scope,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-09T08:16:00.000Z',
        recoveryPendingCopyId: 'ambiguous-pending-copy',
        copies: [
          {
            id: 'ambiguous-pending-copy',
            label: 'Prima',
            revision: 30,
            snapshot: { pantryItems: [{ id: 'pending-first', label: 'Prima', known: true }], stapleIds: [] },
          },
          {
            id: 'ambiguous-pending-copy',
            label: 'Seconda',
            revision: 31,
            snapshot: { pantryItems: [{ id: 'pending-second', label: 'Seconda', known: true }], stapleIds: [] },
          },
        ],
      };
      const rawBefore = JSON.stringify(backup);
      const canonicalBefore = persistedPantry('canonical-before-ambiguous-recovery');
      const localOnly = source === 'local-storage'
        ? vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false)
        : null;
      try {
        if (source === 'indexed-db') {
          await indexedDb.writeKeyValue(backupKey, backup);
          await indexedDb.writeKeyValue('pantry', canonicalBefore);
          await indexedDb.writeKeyValue(archiveKey, { entries: [] });
        } else {
          window.localStorage.setItem(backupKey, rawBefore);
          window.localStorage.setItem(PANTRY_STORAGE_KEY, canonicalBefore);
          window.localStorage.setItem(archiveKey, JSON.stringify({ entries: [] }));
        }
        window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');

        await expect(readPantryConflictBackup(scope)).rejects.toMatchObject({
          code: 'pantry_snapshot_conflict',
          corruptedBackup: true,
        });
        await expect(readPantrySnapshot(scope)).rejects.toMatchObject({ corruptedBackup: true });
        await expect(writePantrySnapshot({
          pantryItems: [{ id: 'must-not-overwrite', label: 'Non sovrascrivere', known: true }],
          stapleIds: [],
        }, scope)).rejects.toMatchObject({ corruptedBackup: true });
        await expect(recoverPantrySnapshot(scope, 'ambiguous-pending-copy')).rejects.toMatchObject({
          code: 'pantry_snapshot_conflict',
          corruptedBackup: true,
        });
        let reloaded: typeof import('./pantryStorage');
        if (source === 'indexed-db') {
          // @ts-expect-error Vite query IDs provide a fresh persisted-storage context after reload.
          reloaded = await import('./pantryStorage?tab=ambiguous-pending-indexed-db-reload');
        } else {
          // @ts-expect-error Vite query IDs provide a fresh persisted-storage context after reload.
          reloaded = await import('./pantryStorage?tab=ambiguous-pending-local-storage-reload');
        }
        await expect(reloaded.readPantryConflictBackup(scope)).rejects.toMatchObject({ corruptedBackup: true });

        if (source === 'indexed-db') {
          await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(backup);
          await expect(indexedDb.readKeyValue('pantry')).resolves.toBe(canonicalBefore);
          await expect(indexedDb.readKeyValue(archiveKey)).resolves.toEqual({ entries: [] });
        } else {
          expect(window.localStorage.getItem(backupKey)).toBe(rawBefore);
          expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(canonicalBefore);
          expect(window.localStorage.getItem(archiveKey)).toBe(JSON.stringify({ entries: [] }));
        }
      } finally {
        localOnly?.mockRestore();
      }
    },
  );

  it('resumes a uniquely identified pending recovery after reload and archives the chosen copy', async () => {
    const scope = 'guest';
    const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
    const backup = {
      id: 'pending-unique-backup',
      scope,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T08:16:00.000Z',
      recoveryPendingCopyId: 'pending-copy-b',
      copies: [
        { id: 'pending-copy-a', label: 'Prima', revision: 30, snapshot: { pantryItems: [{ id: 'pending-a', label: 'Prima', known: true }], stapleIds: [] } },
        { id: 'pending-copy-b', label: 'Seconda', revision: 31, snapshot: { pantryItems: [{ id: 'pending-b', label: 'Seconda', known: true }], stapleIds: [] } },
        { id: 'pending-copy-c', label: 'Terza', revision: 32, snapshot: { pantryItems: [{ id: 'pending-c', label: 'Terza', known: true }], stapleIds: [] } },
      ],
    };
    await indexedDb.writeKeyValue(backupKey, backup);
    await indexedDb.writeKeyValue('pantry', persistedPantry('canonical-before-pending-recovery'));
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');
    // @ts-expect-error Vite query IDs provide a fresh persisted-storage context after reload.
    const reloaded = await import('./pantryStorage?tab=pending-unique-recovery-reload') as typeof import('./pantryStorage');

    await expect(reloaded.readPantryConflictBackup(scope)).resolves.toMatchObject({
      recoveryPendingCopyId: 'pending-copy-b',
      copies: [{ id: 'pending-copy-a' }, { id: 'pending-copy-b' }, { id: 'pending-copy-c' }],
    });
    await expect(reloaded.recoverPantrySnapshot(scope, 'pending-copy-b')).resolves.toMatchObject({
      pantryItems: [{ id: 'pending-b' }],
    });
    await expect(reloaded.readPantryConflictArchive(scope)).resolves.toMatchObject([
      expect.objectContaining({
        selectedCopyId: 'pending-copy-b',
        copies: expect.arrayContaining([expect.objectContaining({
          id: 'pending-copy-b', snapshot: expect.objectContaining({ pantryItems: [expect.objectContaining({ id: 'pending-b' })] }),
        })]),
      }),
    ]);
  });

  it.each(['active', 'resolved'] as const)(
    'fails closed when legacy %s selectedCopyId ambiguously names distinct snapshots in both storage sources',
    async (state) => {
      const scope = 'guest';
      const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
      const baseBackup = {
        id: `selected-ambiguous-${state}`,
        scope,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-09T08:16:00.000Z',
        selectedCopyId: 'ambiguous-selected-copy',
        copies: [
          {
            id: 'ambiguous-selected-copy',
            label: 'Prima',
            revision: 40,
            snapshot: { pantryItems: [{ id: 'selected-first', label: 'Prima', known: true }], stapleIds: [] },
          },
          {
            id: 'ambiguous-selected-copy',
            label: 'Seconda',
            revision: 41,
            snapshot: { pantryItems: [{ id: 'selected-second', label: 'Seconda', known: true }], stapleIds: [] },
          },
        ],
      };
      const backup = state === 'resolved'
        ? { ...baseBackup, resolvedAt: '2026-10-09T08:17:00.000Z' }
        : baseBackup;
      const rawBefore = JSON.stringify(backup);
      for (const source of ['indexed-db', 'local-storage'] as const) {
        await indexedDb.deleteLocalDatabase();
        window.localStorage.clear();
        const localOnly = source === 'local-storage'
          ? vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false)
          : null;
        try {
          if (source === 'indexed-db') await indexedDb.writeKeyValue(backupKey, backup);
          else window.localStorage.setItem(backupKey, rawBefore);
          window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');

          await expect(readPantryConflictBackup(scope)).rejects.toMatchObject({ corruptedBackup: true });
          await expect(recoverPantrySnapshot(scope, 'ambiguous-selected-copy')).rejects.toMatchObject({ corruptedBackup: true });
          if (source === 'indexed-db') await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(backup);
          else expect(window.localStorage.getItem(backupKey)).toBe(rawBefore);
        } finally {
          localOnly?.mockRestore();
        }
      }
    },
  );

  it.each(['indexed-db', 'local-storage'] as const)(
    'does not expose or restore an archived selection that ambiguously names distinct snapshots from %s',
    async (source) => {
      const scope = 'guest';
      const archiveKey = scopeStorageKey(scope, 'ikuck-pantry-conflict-archive-v1');
      const ambiguousEntry = {
        id: `ambiguous-archive-${source}`,
        scope,
        reason: 'concurrent-write',
        createdAt: '2026-10-09T08:16:00.000Z',
        resolvedAt: '2026-10-09T08:17:00.000Z',
        selectedCopyId: 'ambiguous-archive-copy',
        copies: [
          {
            id: 'ambiguous-archive-copy',
            label: 'Prima',
            revision: 50,
            snapshot: { pantryItems: [{ id: 'archive-first', label: 'Prima', known: true }], stapleIds: [] },
          },
          {
            id: 'ambiguous-archive-copy',
            label: 'Seconda',
            revision: 51,
            snapshot: { pantryItems: [{ id: 'archive-second', label: 'Seconda', known: true }], stapleIds: [] },
          },
        ],
      };
      const safeEntry = {
        id: 'unambiguous-archive',
        scope,
        reason: 'concurrent-write',
        createdAt: '2026-10-09T08:18:00.000Z',
        resolvedAt: '2026-10-09T08:19:00.000Z',
        selectedCopyId: 'safe-archive-copy',
        copies: [{
          id: 'safe-archive-copy',
          label: 'Copia sicura',
          revision: 52,
          snapshot: { pantryItems: [{ id: 'archive-safe', label: 'Sicura', known: true }], stapleIds: [] },
        }],
      };
      const rawArchive = { entries: [ambiguousEntry, safeEntry] };
      const rawBefore = JSON.stringify(rawArchive);
      const localOnly = source === 'local-storage'
        ? vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false)
        : null;
      try {
        if (source === 'indexed-db') await indexedDb.writeKeyValue(archiveKey, rawArchive);
        else window.localStorage.setItem(archiveKey, rawBefore);

        await expect(readPantryConflictArchive(scope)).resolves.toMatchObject([
          expect.objectContaining({ id: 'unambiguous-archive', selectedCopyId: 'safe-archive-copy' }),
        ]);
        await expect(reopenPantryArchivedConflict(scope, ambiguousEntry.id)).rejects.toThrow('unavailable');

        let reloaded: typeof import('./pantryStorage');
        if (source === 'indexed-db') {
          // @ts-expect-error Vite query IDs provide a fresh persisted-storage context after reload.
          reloaded = await import('./pantryStorage?tab=ambiguous-archive-indexed-db-reload');
        } else {
          // @ts-expect-error Vite query IDs provide a fresh persisted-storage context after reload.
          reloaded = await import('./pantryStorage?tab=ambiguous-archive-local-storage-reload');
        }
        await expect(reloaded.readPantryConflictArchive(scope)).resolves.toMatchObject([
          expect.objectContaining({ id: 'unambiguous-archive' }),
        ]);
        if (source === 'indexed-db') await expect(indexedDb.readKeyValue(archiveKey)).resolves.toEqual(rawArchive);
        else expect(window.localStorage.getItem(archiveKey)).toBe(rawBefore);
      } finally {
        localOnly?.mockRestore();
      }
    },
  );

  it('reopens resolved duplicate-ID history as distinct recoverable copies without rewriting its source', async () => {
    const scope = 'guest';
    const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
    const backup = {
      id: 'resolved-duplicate-backup',
      scope,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T08:17:00.000Z',
      resolvedAt: '2026-10-09T08:18:00.000Z',
      selectedCopyId: 'resolved-copy-2',
      copies: [
        {
          id: 'resolved-copy',
          label: 'Prima',
          revision: 40,
          snapshot: { pantryItems: [{ id: 'resolved-first', label: 'Prima', known: true }], stapleIds: [] },
        },
        {
          id: 'resolved-copy',
          label: 'Seconda',
          revision: 41,
          snapshot: { pantryItems: [{ id: 'resolved-second', label: 'Seconda', known: true }], stapleIds: [] },
        },
        {
          id: 'resolved-copy-2',
          label: 'Terza',
          revision: 42,
          snapshot: { pantryItems: [{ id: 'resolved-third', label: 'Terza', known: true }], stapleIds: [] },
        },
      ],
    };
    await indexedDb.writeKeyValue(backupKey, backup);
    const rawBefore = await indexedDb.readKeyValue(backupKey);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');

    const visible = await readPantryConflictBackup(scope);
    expect(visible?.resolvedAt).toBeUndefined();
    expect(visible?.copies.map((copy) => copy.id)).toEqual(['resolved-copy', 'resolved-copy-3', 'resolved-copy-2']);
    expect(visible?.selectedCopyId).toBeUndefined();
    await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(rawBefore);
    await expect(recoverPantrySnapshot(scope, 'resolved-copy-2')).resolves.toMatchObject({
      pantryItems: [{ id: 'resolved-third' }],
    });
  });

  it.each(['guest', 'account:archive-test', 'house:archive-test'] as const)(
    'keeps persisted archive IDs unique and selection faithful in %s scope',
    async (scope) => {
      const archiveKey = scopeStorageKey(scope, 'ikuck-pantry-conflict-archive-v1');
      const archive = {
        entries: [{
          id: `archive-${scope}`,
          scope,
          reason: 'concurrent-write',
          createdAt: '2026-10-09T08:20:00.000Z',
          resolvedAt: '2026-10-09T08:21:00.000Z',
          selectedCopyId: 'archive-copy-duplicate-2',
          copies: [
            {
              id: 'archive-copy',
              label: 'Prima',
              revision: 10,
              snapshot: { pantryItems: [{ id: 'archive-first', label: 'Prima', known: true }], stapleIds: [] },
            },
            {
              id: 'archive-copy',
              label: 'Seconda',
              revision: 11,
              snapshot: { pantryItems: [{ id: 'archive-second', label: 'Seconda', known: true }], stapleIds: [] },
            },
            {
              id: 'archive-copy-duplicate-2',
              label: 'Terza',
              revision: 12,
              snapshot: { pantryItems: [{ id: 'archive-selected', label: 'Terza', known: true }], stapleIds: [] },
            },
          ],
        }],
      };
      await indexedDb.writeKeyValue(archiveKey, archive);
      const rawBefore = await indexedDb.readKeyValue(archiveKey);

      const visible = await readPantryConflictArchive(scope);
      expect(visible[0]?.copies.map((copy) => copy.id)).toEqual([
        'archive-copy', 'archive-copy-duplicate-3', 'archive-copy-duplicate-2',
      ]);
      expect(new Set(visible[0]?.copies.map((copy) => copy.id)).size).toBe(3);
      expect(visible[0]?.selectedCopyId).toBe('archive-copy-duplicate-2');
      expect(visible[0]?.copies.find((copy) => copy.id === visible[0]?.selectedCopyId)
        ?.snapshot.pantryItems[0]?.id).toBe('archive-selected');
      await expect(indexedDb.readKeyValue(archiveKey)).resolves.toEqual(rawBefore);

      const reopened = await reopenPantryArchivedConflict(scope, visible[0]!.id);
      expect(reopened.copies.map((copy) => copy.id)).toEqual([
        'archive-copy', 'archive-copy-duplicate-3', 'archive-copy-duplicate-2', `current-${visible[0]!.id}`,
      ]);
      await expect(recoverPantrySnapshot(scope, 'archive-copy-duplicate-2')).resolves.toMatchObject({
        pantryItems: [{ id: 'archive-selected' }],
      });
    },
  );

  it.each([1, 2, 3, 4])('keeps a conflict recoverable and archivable with %s unique copies', async (copyCount) => {
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
    const copies = Array.from({ length: copyCount }, (_, index) => ({
      id: `cardinality-copy-${index + 1}`,
      label: `Copia ${index + 1}`,
      revision: 10 + index,
      snapshot: {
        pantryItems: [{ id: `cardinality-item-${index + 1}`, label: `Ingrediente ${index + 1}`, known: true }],
        stapleIds: [],
      },
    }));
    const backup = {
      id: `cardinality-${copyCount}`,
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T01:00:00.000Z',
      copies,
    };
    await indexedDb.writeKeyValue(backupKey, backup);
    window.localStorage.setItem(markerKey, '1');

    const visible = await readPantryConflictBackup('guest');
    expect(visible?.copies.map((copy) => copy.id)).toEqual(copies.map((copy) => copy.id));
    await expect(recoverPantrySnapshot('guest', copies[copyCount - 1]!.id)).resolves.toMatchObject({
      pantryItems: [{ id: `cardinality-item-${copyCount}` }],
    });
    const archive = await readPantryConflictArchive('guest');
    expect(archive).toHaveLength(1);
    expect(archive[0]?.copies.map((copy) => copy.id)).toEqual(copies.map((copy) => copy.id));
    expect(archive[0]?.selectedCopyId).toBe(copies[copyCount - 1]!.id);
  });

  it('rejects an empty IndexedDB backup without depending on localStorage getItem', async () => {
    const scope = 'guest';
    const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
    const backup = {
      id: 'empty-backup-with-denied-local-storage',
      scope,
      reason: 'concurrent-write',
      createdAt: '2026-10-09T01:00:00.000Z',
      copies: [],
    };
    await indexedDb.writeKeyValue(backupKey, backup);
    const originalGetItem = Storage.prototype.getItem;
    const deniedReads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key.includes('pantry')) throw new DOMException('Storage disabled', 'SecurityError');
      return originalGetItem.call(this, key);
    });

    try {
      // @ts-expect-error Vite query IDs create a fresh module context like a page reload.
      const reloaded = await import('./pantryStorage?tab=empty-backup-local-storage-denied');
      await expect(reloaded.readPantryConflictBackup(scope)).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        corruptedBackup: true,
        copies: [],
      });
      await expect(reloaded.readPantrySnapshot(scope)).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        corruptedBackup: true,
      });
      await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(backup);
      expect(deniedReads).not.toHaveBeenCalled();
    } finally {
      deniedReads.mockRestore();
    }
  });

  it.each([
    { source: 'indexeddb', defect: 'missing-pantry-items', marker: 'present' },
    { source: 'indexeddb', defect: 'missing-staple-ids', marker: 'present' },
    { source: 'indexeddb', defect: 'invalid-pantry-lot', marker: 'present' },
    { source: 'indexeddb', defect: 'missing-pantry-items', marker: 'absent' },
    { source: 'indexeddb', defect: 'missing-staple-ids', marker: 'absent' },
    { source: 'indexeddb', defect: 'invalid-pantry-lot', marker: 'absent' },
    { source: 'localStorage', defect: 'missing-pantry-items', marker: 'present' },
    { source: 'localStorage', defect: 'missing-staple-ids', marker: 'present' },
    { source: 'localStorage', defect: 'invalid-pantry-lot', marker: 'present' },
    { source: 'localStorage', defect: 'missing-pantry-items', marker: 'absent' },
    { source: 'localStorage', defect: 'missing-staple-ids', marker: 'absent' },
    { source: 'localStorage', defect: 'invalid-pantry-lot', marker: 'absent' },
  ] as const)(
    'fails closed for persisted malformed $source conflict copies with $defect and marker $marker',
    async ({ source, defect, marker }) => {
      const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
      const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
      const snapshot: Record<string, unknown> = {
        pantryItems: [],
        stapleIds: [],
      };
      if (defect === 'invalid-pantry-lot') {
        snapshot.pantryLots = [{
          id: 'damaged-lot',
          ingredientId: 'damaged-lot',
          label: 'Quantità da preservare',
          known: true,
          quantity: 0,
          unit: 'kg',
          expiresAt: null,
          createdAt: '2026-10-09T01:00:00.000Z',
          updatedAt: '2026-10-09T01:00:00.000Z',
        }];
      } else if (defect === 'missing-pantry-items') {
        delete snapshot.pantryItems;
      } else {
        delete snapshot.stapleIds;
      }
      const backup = {
        id: `malformed-${source}-${defect}`,
        scope: 'guest',
        reason: 'concurrent-write',
        createdAt: '2026-10-09T01:00:00.000Z',
        copies: [{
          id: 'malformed-copy',
          label: 'Copia danneggiata',
          revision: 10,
          snapshot,
        }],
      };
      const rawBackup = JSON.stringify(backup);
      if (source === 'indexeddb') await indexedDb.writeKeyValue(backupKey, backup);
      else window.localStorage.setItem(backupKey, rawBackup);
      const setMarkerState = (): void => {
        if (marker === 'present') window.localStorage.setItem(markerKey, '1');
        else window.localStorage.removeItem(markerKey);
      };
      setMarkerState();

      const expectCorruptionStatus = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        corruptedBackup: true,
        copies: [],
      });
      const expectBackupPreserved = async (): Promise<void> => {
        if (source === 'indexeddb') {
          await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(backup);
          expect(window.localStorage.getItem(backupKey)).toBeNull();
        } else {
          expect(window.localStorage.getItem(backupKey)).toBe(rawBackup);
          await expect(indexedDb.readKeyValue(backupKey)).resolves.toBeNull();
        }
        if (marker === 'present') expect(window.localStorage.getItem(markerKey)).toBe('1');
      };
      const reloadPantryStorage = async () => {
        switch (`${source}-${defect}-${marker}`) {
          case 'indexeddb-missing-pantry-items-present':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-idb-missing-items-present');
          case 'indexeddb-missing-staple-ids-present':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-idb-missing-staples-present');
          case 'indexeddb-invalid-pantry-lot-present':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-idb-lot-present');
          case 'indexeddb-missing-pantry-items-absent':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-idb-missing-items-absent');
          case 'indexeddb-missing-staple-ids-absent':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-idb-missing-staples-absent');
          case 'indexeddb-invalid-pantry-lot-absent':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-idb-lot-absent');
          case 'localStorage-missing-pantry-items-present':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-local-missing-items-present');
          case 'localStorage-missing-staple-ids-present':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-local-missing-staples-present');
          case 'localStorage-invalid-pantry-lot-present':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-local-lot-present');
          case 'localStorage-missing-pantry-items-absent':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-local-missing-items-absent');
          case 'localStorage-missing-staple-ids-absent':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-local-missing-staples-absent');
          case 'localStorage-invalid-pantry-lot-absent':
            // @ts-expect-error Vite query IDs create a fresh persisted-storage module after reload.
            return import('./pantryStorage?tab=malformed-local-lot-absent');
        }
      };

      const conflictBoundary = await reloadPantryStorage();
      await expectCorruptionStatus(conflictBoundary.readPantryConflictBackup('guest'));
      await expect(conflictBoundary.getPantrySnapshotConflictError('guest')).resolves.toMatchObject({
        code: 'pantry_snapshot_conflict',
        corruptedBackup: true,
        copies: [],
      });
      await expectBackupPreserved();

      await expectCorruptionStatus(conflictBoundary.readPantrySnapshot('guest'));
      await expectCorruptionStatus(conflictBoundary.pantryStorage.getItem(PANTRY_STORAGE_KEY));
      await expectBackupPreserved();

      await expectCorruptionStatus(conflictBoundary.writePantrySnapshot({
        pantryItems: [{ id: 'must-not-replace-backup', label: 'Non sovrascrivere', known: true }],
        stapleIds: [],
      }, 'guest'));
      await expectBackupPreserved();

      await expectCorruptionStatus(conflictBoundary.recoverPantrySnapshot('guest', 'malformed-copy'));
      await expectBackupPreserved();
      await expect(conflictBoundary.readPantryConflictArchive('guest')).resolves.toEqual([]);

      setMarkerState();
      const request = vi.fn(async <T>() => ({ changes: [], nextCursor: 0 } as T)) as unknown as ApiRequest;
      await expectCorruptionStatus(syncNow({
        request,
        session: { userId: 'malformed-backup-test', emailVerifiedAt: '2026-10-09T01:00:00.000Z', csrfToken: 'csrf' },
        isSessionCurrent: () => true,
      }));
      expect(request).not.toHaveBeenCalled();
      await expectBackupPreserved();
    },
  );

  it('processes a concurrent valid pantry when invalid-record cleanup loses its compare-and-delete race', async () => {
    const scope = 'account:invalid-cleanup-race';
    const databaseKey = scopeStorageKey(scope, 'pantry');
    await indexedDb.writeKeyValue(databaseKey, '{"invalid":true}');
    setActiveDataScope(scope);
    // @ts-expect-error Vite query IDs provide isolated contexts for concurrent tabs.
    const readerTab = await import('./pantryStorage?tab=invalid-cleanup-reader');
    // @ts-expect-error Vite query IDs provide isolated contexts for concurrent tabs.
    const writerTab = await import('./pantryStorage?tab=invalid-cleanup-writer');
    let releaseInvalidRead!: () => void;
    let signalInvalidRead!: () => void;
    const invalidReadStarted = new Promise<void>((resolve) => { signalInvalidRead = resolve; });
    const invalidReadGate = new Promise<void>((resolve) => { releaseInvalidRead = resolve; });
    const actualRead = indexedDb.readKeyValue;
    let pausedInvalidRead = false;
    const read = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      const value = await actualRead(key);
      if (key === databaseKey && !pausedInvalidRead) {
        pausedInvalidRead = true;
        signalInvalidRead();
        await invalidReadGate;
      }
      return value;
    });

    try {
      const hydration = readerTab.pantryStorage.getItem(PANTRY_STORAGE_KEY);
      await invalidReadStarted;
      const concurrentWrite = writerTab.writePantrySnapshot({
        pantryItems: [{ id: 'concurrent-valid', label: 'Modifica concorrente', known: true }],
        stapleIds: [],
      }, scope);
      await vi.waitFor(async () => {
        expect(await actualRead<string>(databaseKey)).toContain('concurrent-valid');
      });
      releaseInvalidRead();
      await concurrentWrite;

      await expect(hydration).resolves.not.toBeNull();
      expect(await hydration).toContain('concurrent-valid');
      await expect(actualRead<string>(databaseKey)).resolves.toContain('concurrent-valid');
    } finally {
      releaseInvalidRead();
      read.mockRestore();
      setActiveDataScope('guest');
    }
  });

  it('reads updated IndexedDB after stale mirror update and removal both fail, including through the adapter', async () => {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('old-tomato'));
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
      return originalSetItem.call(this, key, value);
    });
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
      if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
      return originalRemoveItem.call(this, key);
    });

    try {
      await writePantrySnapshot({ pantryItems: [{ id: 'tomato', label: 'Pomodoro', known: true }, { id: 'pasta', label: 'Pasta', known: true }], stapleIds: [] });
      await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'tomato' }, { id: 'pasta' }] });
      await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.toContain('pasta');
      await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.not.toContain('old-tomato');
    } finally {
      setItem.mockRestore();
      removeItem.mockRestore();
    }
  });

  it('prefers a successful IndexedDB write when an older pending marker survives mirror failures', async () => {
    const actualWrite = indexedDb.writeKeyValue;
    let failFirstPantryWrite = true;
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === 'pantry' && failFirstPantryWrite) {
        failFirstPantryWrite = false;
        throw new Error('IndexedDB temporarily unavailable');
      }
      return actualWrite(key, value);
    });

    try {
      await expect(writePantrySnapshot({
        pantryItems: [{ id: 'mirror-only', label: 'Mirror only', known: true }],
        stapleIds: [],
      })).rejects.toThrow('IndexedDB temporarily unavailable');
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBe('1');

      const originalSetItem = Storage.prototype.setItem;
      const originalRemoveItem = Storage.prototype.removeItem;
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
        return originalSetItem.call(this, key, value);
      });
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
        if (key === PANTRY_STORAGE_KEY || key === `${PANTRY_STORAGE_KEY}-idb-pending`) {
          throw new DOMException('Storage disabled', 'SecurityError');
        }
        return originalRemoveItem.call(this, key);
      });

      try {
        await writePantrySnapshot({
          pantryItems: [{ id: 'idb-current', label: 'IndexedDB current', known: true }],
          stapleIds: [],
        });
        expect(JSON.parse(await indexedDb.readKeyValue<string>('pantry') ?? '{}')).toMatchObject({
          mirrorObsolete: true,
          state: { pantryItems: [{ id: 'idb-current' }] },
        });
        expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBe('1');

        await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'idb-current' }] });
        await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.toContain('idb-current');
        await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.not.toContain('mirror-only');
      } finally {
        setItem.mockRestore();
        removeItem.mockRestore();
      }
    } finally {
      write.mockRestore();
    }
  });

  it.each(['embedded freshness flag', 'legacy freshness sidecar'] as const)(
    'uses the newer local mirror after its IndexedDB write fails despite an older %s',
    async (freshnessMarker) => {
      window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('mirror-before-a'));
      const originalSetItem = Storage.prototype.setItem;
      const failedMirrorWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
        return originalSetItem.call(this, key, value);
      });

      try {
        await writePantrySnapshot({
          pantryItems: [{ id: 'idb-a', label: 'IndexedDB A', known: true }],
          stapleIds: [],
        });
      } finally {
        failedMirrorWrite.mockRestore();
      }

      if (freshnessMarker === 'legacy freshness sidecar') {
        await indexedDb.writeKeyValue('pantry', persistedPantry('idb-a'));
      }

      const actualWrite = indexedDb.writeKeyValue;
      const failedNewerWrite = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
        if (key === 'pantry') throw new Error('IndexedDB failed for newer B');
        return actualWrite(key, value);
      });

      try {
        await expect(writePantrySnapshot({
          pantryItems: [{ id: 'mirror-b', label: 'Mirror B', known: true }],
          stapleIds: [],
        })).rejects.toThrow('IndexedDB failed for newer B');
        expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBe('1');

        await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'mirror-b' }] });
        const adapterSnapshot = await pantryStorage.getItem(PANTRY_STORAGE_KEY);
        expect(adapterSnapshot).toContain('mirror-b');
        expect(adapterSnapshot).not.toContain('idb-a');
      } finally {
        failedNewerWrite.mockRestore();
      }
    },
  );

  it('orders a new mirror write after persisted data when the browser clock moved backwards', async () => {
    const oldSnapshot = JSON.parse(persistedPantry('idb-a')) as Record<string, unknown>;
    await indexedDb.writeKeyValue('pantry', JSON.stringify({
      ...oldSnapshot,
      revision: 8_000_000_000_000_000,
      mirrorObsolete: true,
    }));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const actualWrite = indexedDb.writeKeyValue;
    const failedWrite = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === 'pantry') throw new Error('IndexedDB unavailable for B');
      return actualWrite(key, value);
    });

    try {
      await expect(writePantrySnapshot({
        pantryItems: [{ id: 'mirror-b', label: 'Mirror B', known: true }],
        stapleIds: [],
      })).rejects.toThrow('IndexedDB unavailable for B');
      await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'mirror-b' }] });
      const adapterSnapshot = await pantryStorage.getItem(PANTRY_STORAGE_KEY);
      expect(adapterSnapshot).toContain('mirror-b');
      expect(adapterSnapshot).not.toContain('idb-a');
    } finally {
      failedWrite.mockRestore();
      clock.mockRestore();
    }
  });

  it('does not reject a pantry storage write that committed before the House fence was raised', async () => {
    const scope = 'house:pantry-write-finishing' as const;
    setActiveDataScope(scope);
    const actualWrite = indexedDb.writeKeyValue;
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      const result = await actualWrite(key, value);
      if (key !== 'pantry-mirror-obsolete') markScopeUncertain(scope);
      return result;
    });

    try {
      await expect(pantryStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('committed-before-fence'))).resolves.toBeUndefined();
      await expect(readPantrySnapshot(scope)).resolves.toMatchObject({
        pantryItems: [{ id: 'committed-before-fence' }],
      });
    } finally {
      resumeScope(scope);
      write.mockRestore();
      setActiveDataScope('guest');
    }
  });

  it.each(['writePantrySnapshot', 'pantryStorage.setItem'] as const)(
    'fences two queued House %s writes after membership verification fails',
    async (writePath) => {
      const houseId = `pantry-fence-${writePath === 'writePantrySnapshot' ? 'direct' : 'adapter'}`;
      const scope = `house:${houseId}` as const;
      const personalScope = 'account:pantry-fence-user' as const;
      resumeScope(scope);
      setActiveDataScope(scope);
      setPersonalDataScope(personalScope);
      const existing = { pantryItems: [{ id: 'existing-house-item', label: 'Existing', known: true }], stapleIds: ['salt'] };
      await writePantrySnapshot(existing, scope);
      await indexedDb.writeQueueValue({ mutationId: 'preserved-house-mutation', scope });
      await indexedDb.writeMeta(`syncCursor:${scope}`, 23);

      const databaseKey = scopeStorageKey(scope, 'pantry');
      const storageKey = scopeStorageKey(scope, PANTRY_STORAGE_KEY);
      const pendingKey = `${storageKey}-idb-pending`;
      const freshnessKey = `${databaseKey}-mirror-obsolete`;
      const purgeKey = `ikuck:pending-house-purge:${scope}`;
      const initialDatabase = await indexedDb.readKeyValue<string>(databaseKey);
      const initialMirror = window.localStorage.getItem(storageKey);
      const initialFreshness = await indexedDb.readKeyValue<boolean>(freshnessKey);
      const initialPending = window.localStorage.getItem(pendingKey);
      const initialQueue = await indexedDb.readQueueValues<{ mutationId: string; scope: typeof scope }>(scope);
      const initialCursor = await indexedDb.readMeta<number>(`syncCursor:${scope}`);

      let releaseRead!: () => void;
      let signalRead!: () => void;
      let revisionReadCount = 0;
      const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
      const firstReadStarted = new Promise<void>((resolve) => { signalRead = resolve; });
      const actualRead = indexedDb.readKeyValue;
      const heldRead = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
        if (key === databaseKey) {
          revisionReadCount += 1;
          if (revisionReadCount === 1) {
            signalRead();
            await readGate;
          }
        }
        return actualRead(key);
      });
      const writtenDatabaseKeys: string[] = [];
      const actualWrite = indexedDb.writeKeyValue;
      const databaseWrites = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
        if (key === databaseKey || key === freshnessKey) writtenDatabaseKeys.push(key);
        return actualWrite(key, value);
      });
      const deletedDatabaseKeys: string[] = [];
      const actualDelete = indexedDb.deleteKeyValue;
      const databaseDeletes = vi.spyOn(indexedDb, 'deleteKeyValue').mockImplementation(async (key) => {
        if (key === databaseKey || key === freshnessKey) deletedDatabaseKeys.push(key);
        return actualDelete(key);
      });
      const pantryLocalKeys = new Set([storageKey, pendingKey, purgeKey]);
      const pantryLocalWrites: string[] = [];
      const originalSetItem = Storage.prototype.setItem;
      const localSet = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (pantryLocalKeys.has(key)) pantryLocalWrites.push(`set:${key}`);
        return originalSetItem.call(this, key, value);
      });
      const originalRemoveItem = Storage.prototype.removeItem;
      const localRemove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
        if (pantryLocalKeys.has(key)) pantryLocalWrites.push(`remove:${key}`);
        return originalRemoveItem.call(this, key);
      });
      const requestMock = vi.fn()
        .mockRejectedValueOnce(new Error('/v1/house membership verification failed'))
        .mockResolvedValueOnce({
          house: { id: houseId, name: 'Casa', createdAt: '2026-10-08T10:00:00.000Z' },
          membership: { role: 'member', joinedAt: '2026-10-08T10:00:00.000Z' },
          members: [],
        });
      const request = requestMock as unknown as ApiRequest;
      let firstWrite: Promise<void> | undefined;
      let secondWrite: Promise<void> | undefined;

      const submitWrite = async (id: string): Promise<void> => {
        if (writePath === 'writePantrySnapshot') {
          await writePantrySnapshot({ pantryItems: [{ id, label: id, known: true }], stapleIds: [] }, scope);
          return;
        }
        await pantryStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry(id));
      };
      const localStorageSnapshot = (): Record<string, string | null> => Object.fromEntries(
        Object.keys(window.localStorage).sort().map((key) => [key, window.localStorage.getItem(key)]),
      );

      try {
        firstWrite = submitWrite('first-queued-write');
        await firstReadStarted;
        secondWrite = submitWrite('second-queued-write');
        await Promise.resolve();
        expect(revisionReadCount).toBe(1);

        await expect(initializeSessionScope({
          userId: 'pantry-fence-user',
          emailVerifiedAt: '2026-10-08T10:00:00.000Z',
          csrfToken: 'csrf-pantries',
        }, request)).rejects.toThrow('/v1/house membership verification failed');
        expect(isScopeUncertain(scope)).toBe(true);
        expect(window.localStorage.getItem(purgeKey)).toBeNull();
        const localStorageBeforeRelease = localStorageSnapshot();

        releaseRead();
        const settledWrites = await Promise.allSettled([firstWrite, secondWrite]);
        expect(settledWrites).toEqual([
          expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'scope_unverified' }) }),
          expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'scope_unverified' }) }),
        ]);
        expect(writtenDatabaseKeys).toEqual([]);
        expect(deletedDatabaseKeys).toEqual([]);
        expect(pantryLocalWrites).toEqual([]);
        expect(localStorageSnapshot()).toEqual(localStorageBeforeRelease);
        await expect(indexedDb.readKeyValue(databaseKey)).resolves.toBe(initialDatabase);
        await expect(indexedDb.readKeyValue(freshnessKey)).resolves.toBe(initialFreshness);
        expect(window.localStorage.getItem(storageKey)).toBe(initialMirror);
        expect(window.localStorage.getItem(pendingKey)).toBe(initialPending);
        expect(window.localStorage.getItem(purgeKey)).toBeNull();
        await expect(indexedDb.readQueueValues<{ mutationId: string; scope: typeof scope }>(scope)).resolves.toEqual(initialQueue);
        await expect(indexedDb.readMeta<number>(`syncCursor:${scope}`)).resolves.toBe(initialCursor);
        expect(requestMock.mock.calls.map(([path]) => path)).toEqual(['/v1/house']);

        await writePantrySnapshot({ pantryItems: [{ id: 'personal-write', label: 'Personal', known: true }], stapleIds: [] }, personalScope);
        setActiveDataScope(personalScope);
        await pantryStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('personal-adapter-write'));
        await expect(readPantrySnapshot(personalScope)).resolves.toMatchObject({
          pantryItems: [{ id: 'personal-adapter-write' }],
        });
        setActiveDataScope(scope);

        await expect(initializeSessionScope({
          userId: 'pantry-fence-user',
          emailVerifiedAt: '2026-10-08T10:00:00.000Z',
          csrfToken: 'csrf-pantries',
        }, request)).resolves.toMatchObject({ state: { house: { id: houseId } } });
        expect(isScopeUncertain(scope)).toBe(false);

        await submitWrite('write-after-confirmation');
        await expect(readPantrySnapshot(scope)).resolves.toMatchObject({
          pantryItems: [{ id: 'write-after-confirmation' }],
        });
        expect(requestMock.mock.calls.map(([path]) => path)).toEqual(['/v1/house', '/v1/house']);
      } finally {
        releaseRead();
        if (firstWrite !== undefined && secondWrite !== undefined) await Promise.allSettled([firstWrite, secondWrite]);
        localRemove.mockRestore();
        localSet.mockRestore();
        databaseDeletes.mockRestore();
        databaseWrites.mockRestore();
        heldRead.mockRestore();
        resumeScope(scope);
        setActiveDataScope('guest');
        setPersonalDataScope('guest');
      }
    },
  );

  it('does not let a stale mirror override IndexedDB when its freshness marker write fails', async () => {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('old-tomato'));
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
      return originalSetItem.call(this, key, value);
    });
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
      if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
      return originalRemoveItem.call(this, key);
    });
    const originalWriteKeyValue = indexedDb.writeKeyValue;
    const markerWrite = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation((key, value) => {
      if (key === 'pantry-mirror-obsolete') return Promise.reject(new Error('freshness marker unavailable'));
      return originalWriteKeyValue(key, value);
    });

    try {
      await writePantrySnapshot({
        pantryItems: [{ id: 'tomato', label: 'Pomodoro', known: true }, { id: 'pasta', label: 'Pasta', known: true }],
        stapleIds: [],
      });
      expect(markerWrite).toHaveBeenCalledWith('pantry-mirror-obsolete', true, expect.any(Function));
      await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'tomato' }, { id: 'pasta' }] });
      await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.toContain('pasta');
      await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.not.toContain('old-tomato');
    } finally {
      markerWrite.mockRestore();
      setItem.mockRestore();
      removeItem.mockRestore();
    }
  });

  it('preserves an unrevisioned mirror against obsolete revisioned IndexedDB without guessing', async () => {
    const indexedDbRaw = JSON.stringify({
      ...JSON.parse(persistedPantry('indexed-a')) as Record<string, unknown>,
      revision: 12,
      mirrorObsolete: true,
    });
    const localRaw = persistedPantry('legacy-b');
    await indexedDb.writeKeyValue('pantry', indexedDbRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, localRaw);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-idb-pending`, '1');

    await expect(readPantrySnapshot()).rejects.toMatchObject({
      code: 'pantry_snapshot_conflict',
      reason: 'unrevisioned-local-write',
      indexedDbSnapshot: { pantryItems: [{ id: 'indexed-a' }] },
      localSnapshot: { pantryItems: [{ id: 'legacy-b' }] },
    });
    await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).rejects.toMatchObject({
      code: 'pantry_snapshot_conflict',
      reason: 'unrevisioned-local-write',
      indexedDbSnapshot: { pantryItems: [{ id: 'indexed-a' }] },
      localSnapshot: { pantryItems: [{ id: 'legacy-b' }] },
    });

    const replacement = persistedPantry('replacement');
    await expect(writePantrySnapshot({ pantryItems: [{ id: 'replacement', label: 'Replacement', known: true }], stapleIds: [] }))
      .rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
    await expect(pantryStorage.setItem(PANTRY_STORAGE_KEY, replacement))
      .rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
    expect(await indexedDb.readKeyValue<string>('pantry')).toBe(indexedDbRaw);
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(localRaw);
    expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBe('1');
  });

  it('preserves divergent equal-revision snapshots from independent tab writers', async () => {
    // @ts-expect-error Vite query IDs provide isolated module state for independent writer tabs.
    const tabAImport = import('./pantryStorage?tab=writer-a');
    // @ts-expect-error Vite query IDs provide isolated module state for independent writer tabs.
    const tabBImport = import('./pantryStorage?tab=writer-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(20_000);
    let releaseWriterBRead!: () => void;
    let signalFirstRead!: () => void;
    let signalWriterBRead!: () => void;
    let releaseWriterB!: () => void;
    let signalWriterB!: () => void;
    let revisionReads = 0;
    const writerBReadGate = new Promise<void>((resolve) => { releaseWriterBRead = resolve; });
    const firstReadStarted = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const writerBReadStarted = new Promise<void>((resolve) => { signalWriterBRead = resolve; });
    const writerBGate = new Promise<void>((resolve) => { releaseWriterB = resolve; });
    const writerBAttempted = new Promise<void>((resolve) => { signalWriterB = resolve; });
    const actualRead = indexedDb.readKeyValue;
    const read = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key !== 'pantry') return actualRead(key);
      revisionReads += 1;
      if (revisionReads === 1) {
        signalFirstRead();
        return actualRead(key);
      }
      if (revisionReads === 2) {
        signalWriterBRead();
        await writerBReadGate;
        return null;
      }
      return actualRead(key);
    });
    const actualWrite = indexedDb.writeKeyValue;
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === 'pantry' && typeof value === 'string' && value.includes('tab-b')) {
        signalWriterB();
        await writerBGate;
        throw new Error('writer B IndexedDB commit failed');
      }
      return actualWrite(key, value);
    });
    const originalSetItem = Storage.prototype.setItem;
    const mirrorWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === PANTRY_STORAGE_KEY && value.includes('tab-a')) {
        throw new DOMException('Writer A mirror unavailable', 'SecurityError');
      }
      return originalSetItem.call(this, key, value);
    });

    try {
      const writerA = tabA.writePantrySnapshot({
        pantryItems: [{ id: 'tab-a', label: 'Tab A', known: true }],
        stapleIds: [],
      });
      await firstReadStarted;
      const writerB = tabB.writePantrySnapshot({
        pantryItems: [{ id: 'tab-b', label: 'Tab B', known: true }],
        stapleIds: [],
      });
      await writerBReadStarted;
      await writerA;
      releaseWriterBRead();
      await writerBAttempted;
      releaseWriterB();
      await expect(writerB).rejects.toThrow('writer B IndexedDB commit failed');

      const indexedDbRaw = await indexedDb.readKeyValue<string>('pantry');
      const localRaw = window.localStorage.getItem(PANTRY_STORAGE_KEY);
      expect(JSON.parse(indexedDbRaw ?? '{}')).toMatchObject({
        revision: 20_001,
        mirrorObsolete: true,
        state: { pantryItems: [{ id: 'tab-a' }] },
      });
      expect(JSON.parse(localRaw ?? '{}')).toMatchObject({
        revision: 20_001,
        state: { pantryItems: [{ id: 'tab-b' }] },
      });
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBe('1');

      await expect(tabA.readPantrySnapshot()).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        reason: 'equal-revision',
      });
      await expect(tabA.pantryStorage.getItem(PANTRY_STORAGE_KEY)).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        reason: 'equal-revision',
      });
      await expect(tabB.readPantrySnapshot()).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        reason: 'equal-revision',
      });
      await expect(tabB.pantryStorage.getItem(PANTRY_STORAGE_KEY)).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        reason: 'equal-revision',
      });
    } finally {
      releaseWriterBRead();
      releaseWriterB();
      mirrorWrite.mockRestore();
      write.mockRestore();
      read.mockRestore();
      clock.mockRestore();
    }
  });

  it('serializes an IndexedDB-error mirror fallback with an independent local-only writer', async () => {
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabAImport = import('./pantryStorage?tab=idb-error-writer-a');
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabBImport = import('./pantryStorage?tab=idb-error-writer-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]) as [
      typeof import('./pantryStorage'),
      typeof import('./pantryStorage'),
    ];
    const initialRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'initial', label: 'Initial', known: true }], stapleIds: [] },
      version: 1,
      revision: 19_999,
      mirrorObsolete: false,
    });
    await indexedDb.writeKeyValue('pantry', initialRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, initialRaw);
    await Promise.all([tabA.readPantrySnapshot(), tabB.readPantrySnapshot()]);

    let indexedDbAvailable = true;
    const availability = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockImplementation(() => indexedDbAvailable);
    let releaseIdbFailure!: () => void;
    let signalIdbWrite!: () => void;
    const idbFailureGate = new Promise<void>((resolve) => { releaseIdbFailure = resolve; });
    const idbWriteStarted = new Promise<void>((resolve) => { signalIdbWrite = resolve; });
    const actualWrite = indexedDb.writeKeyValue;
    const failTabAWrite = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
      if (key === 'pantry' && typeof value === 'string' && value.includes('tab-a')) {
        indexedDbAvailable = false;
        signalIdbWrite();
        await idbFailureGate;
        throw new Error('tab A IndexedDB write failed');
      }
      return actualWrite(key, value);
    });

    const serialLocks = createSerializedTestLocks();
    const requests: string[] = [];
    let signalFallbackLock!: () => void;
    const fallbackLockRequested = new Promise<void>((resolve) => { signalFallbackLock = resolve; });
    const lockManager: TestLockManager = {
      request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>) {
        requests.push(name);
        if (requests.length === 3) signalFallbackLock();
        return serialLocks.manager.request(name, options, callback);
      },
    };
    const restoreLocks = setNavigatorLocks(lockManager);
    let releaseHeldLock!: () => void;
    let signalHeldLock!: () => void;
    const heldLockGate = new Promise<void>((resolve) => { releaseHeldLock = resolve; });
    const heldLockEntered = new Promise<void>((resolve) => { signalHeldLock = resolve; });
    const heldLock = lockManager.request('ikuck:pantry:guest', { mode: 'exclusive' }, async () => {
      signalHeldLock();
      await heldLockGate;
    });
    let writerA: Promise<'fulfilled' | 'rejected'> = Promise.resolve('rejected');
    let writerB: Promise<'fulfilled' | 'rejected'> = Promise.resolve('rejected');

    try {
      await heldLockEntered;
      writerA = tabA.writePantrySnapshot({
        pantryItems: [{ id: 'tab-a', label: 'Tab A', known: true }],
        stapleIds: [],
      }).then(() => 'fulfilled' as const, () => 'rejected' as const);
      await idbWriteStarted;
      writerB = tabB.writePantrySnapshot({
        pantryItems: [{ id: 'tab-b', label: 'Tab B', known: true }],
        stapleIds: [],
      }).then(() => 'fulfilled' as const, () => 'rejected' as const);
      await vi.waitFor(() => expect(requests).toHaveLength(2));

      releaseIdbFailure();
      const firstProgress = await Promise.race([
        fallbackLockRequested.then(() => 'fallback-requested' as const),
        writerA.then(() => 'writer-settled' as const),
      ]);
      expect(firstProgress).toBe('fallback-requested');
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(initialRaw);

      releaseHeldLock();
      await heldLock;
      const [tabAResult, tabBResult] = await Promise.all([writerA, writerB]);
      expect(tabBResult).toBe('fulfilled');
      expect(tabAResult).toBe('rejected');
      const active = await tabA.readPantryConflictBackup('guest');
      expect(active?.copies.flatMap((copy) => copy.snapshot.pantryItems.map((item) => item.id))).toEqual(
        expect.arrayContaining(['tab-a', 'tab-b']),
      );
      expect(JSON.parse(window.localStorage.getItem(PANTRY_STORAGE_KEY) ?? '{}')).toMatchObject({
        state: { pantryItems: [{ id: 'tab-b' }] },
      });
    } finally {
      releaseIdbFailure();
      releaseHeldLock();
      await heldLock;
      await Promise.all([writerA, writerB]);
      restoreLocks();
      failTabAWrite.mockRestore();
      availability.mockRestore();
    }
  });

  it.each(['unavailable', 'rejected'] as const)(
    'fails closed on an IndexedDB-error mirror fallback when Web Locks are %s', async (lockState) => {
      const tab = (lockState === 'unavailable'
        // @ts-expect-error Vite query IDs provide isolated module state.
        ? await import('./pantryStorage?tab=idb-error-lock-unavailable')
        // @ts-expect-error Vite query IDs provide isolated module state.
        : await import('./pantryStorage?tab=idb-error-lock-rejected')) as typeof import('./pantryStorage');
      const initialRaw = JSON.stringify({
        state: { pantryItems: [{ id: 'protected', label: 'Protected', known: true }], stapleIds: [] },
        version: 1,
        revision: 41,
        mirrorObsolete: false,
      });
      await indexedDb.writeKeyValue('pantry', initialRaw);
      window.localStorage.setItem(PANTRY_STORAGE_KEY, initialRaw);
      await tab.readPantrySnapshot();

      let indexedDbAvailable = true;
      const availability = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockImplementation(() => indexedDbAvailable);
      const actualWrite = indexedDb.writeKeyValue;
      const failedWrite = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value) => {
        if (key === 'pantry' && typeof value === 'string' && value.includes('unprotected')) {
          indexedDbAvailable = false;
          throw new Error('IndexedDB write failed');
        }
        return actualWrite(key, value);
      });
      const lockManager: TestLockManager | undefined = lockState === 'unavailable' ? undefined : {
        async request() {
          throw new Error('lock backend rejected');
        },
      };
      const restoreLocks = setNavigatorLocks(lockManager);

      try {
        await expect(tab.writePantrySnapshot({
          pantryItems: [{ id: 'unprotected', label: 'Unprotected', known: true }],
          stapleIds: [],
        })).rejects.toThrow(/Web Locks/);
        expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(initialRaw);
        expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBeNull();
        await expect(indexedDb.readKeyValue('pantry')).resolves.toBe(initialRaw);
      } finally {
        restoreLocks();
        failedWrite.mockRestore();
        availability.mockRestore();
      }
    },
  );

  it('keeps both successful concurrent tab writes in a durable conflict instead of losing the first edit', async () => {
    // @ts-expect-error Vite query IDs provide isolated module state for independent writer tabs.
    const tabAImport = import('./pantryStorage?tab=successful-writer-a');
    // @ts-expect-error Vite query IDs provide isolated module state for independent writer tabs.
    const tabBImport = import('./pantryStorage?tab=successful-writer-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]);
    const initialRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'initial', label: 'Initial', known: true }], stapleIds: [] },
      version: 1,
      revision: 19_999,
      mirrorObsolete: false,
    });
    await indexedDb.writeKeyValue('pantry', initialRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, initialRaw);
    await Promise.all([tabA.readPantrySnapshot(), tabB.readPantrySnapshot()]);

    const clock = vi.spyOn(Date, 'now').mockReturnValue(20_000);
    let releaseA!: () => void;
    let releaseB!: () => void;
    let signalAWrite!: () => void;
    let signalBRead!: () => void;
    let signalBWrite!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const aWriteStarted = new Promise<void>((resolve) => { signalAWrite = resolve; });
    const bReadStarted = new Promise<void>((resolve) => { signalBRead = resolve; });
    const bWriteStarted = new Promise<void>((resolve) => { signalBWrite = resolve; });
    let revisionReads = 0;
    const actualRead = indexedDb.readKeyValue;
    const read = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key !== 'pantry') return actualRead(key);
      revisionReads += 1;
      if (revisionReads === 2) signalBRead();
      return actualRead(key);
    });
    const actualWrite = indexedDb.writeKeyValue;
    const commits: Array<{ writer: 'a' | 'b'; result: unknown }> = [];
    const write = vi.spyOn(indexedDb, 'writeKeyValue').mockImplementation(async (key, value, assertWritable, compare) => {
      if (key === 'pantry' && typeof value === 'string' && value.includes('tab-a')) {
        signalAWrite();
        await gateA;
      }
      if (key === 'pantry' && typeof value === 'string' && value.includes('tab-b')) {
        signalBWrite();
        await gateB;
      }
      const result = await actualWrite(key, value, assertWritable, compare);
      if (key === 'pantry' && typeof value === 'string') {
        commits.push({ writer: value.includes('tab-a') ? 'a' : 'b', result });
      }
      return result;
    });

    try {
      const writerA = tabA.writePantrySnapshot({
        pantryItems: [{ id: 'tab-a', label: 'Tab A', known: true }],
        stapleIds: [],
      });
      await aWriteStarted;
      const writerB = tabB.writePantrySnapshot({
        pantryItems: [{ id: 'tab-b', label: 'Tab B', known: true }],
        stapleIds: [],
      });
      await bReadStarted;
      await bWriteStarted;
      releaseA();
      await writerA;
      releaseB();
      await expect(writerB).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });

      expect(commits).toHaveLength(3);
      expect(commits.map((commit) => commit.writer)).toEqual(['a', 'a', 'b']);
      expect(commits.map((commit) => commit.result)).toEqual([true, true, false]);
      const backup = await indexedDb.readKeyValue<{ copies?: Array<{ snapshot: { pantryItems: Array<{ id: string }> } }> }>(
        'ikuck:guest:ikuck-pantry-conflict-backup-v1',
      );
      expect(backup?.copies?.flatMap((copy) => copy.snapshot.pantryItems.map((item) => item.id))).toEqual(
        expect.arrayContaining(['tab-a', 'tab-b']),
      );
      await expect(tabA.readPantrySnapshot()).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        indexedDbSnapshot: { pantryItems: [{ id: 'tab-a' }] },
        localSnapshot: { pantryItems: [{ id: 'tab-b' }] },
      });
    } finally {
      releaseA();
      releaseB();
      write.mockRestore();
      read.mockRestore();
      clock.mockRestore();
    }
  });

  it('rejects writes without replacing either divergent equal-revision copy', async () => {
    const indexedDbRaw = JSON.stringify({
      ...JSON.parse(persistedPantry('equal-indexed')) as Record<string, unknown>,
      revision: 23,
      mirrorObsolete: true,
    });
    const localRaw = JSON.stringify({
      ...JSON.parse(persistedPantry('equal-local')) as Record<string, unknown>,
      revision: 23,
    });
    await indexedDb.writeKeyValue('pantry', indexedDbRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, localRaw);

    await expect(writePantrySnapshot({
      pantryItems: [{ id: 'replacement', label: 'Replacement', known: true }],
      stapleIds: [],
    })).rejects.toMatchObject({ code: 'pantry_snapshot_conflict', reason: 'equal-revision' });
    await expect(pantryStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('replacement')))
      .rejects.toMatchObject({ code: 'pantry_snapshot_conflict', reason: 'equal-revision' });

    await expect(indexedDb.readKeyValue<string>('pantry')).resolves.toBe(indexedDbRaw);
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(localRaw);
  });

  it('restores the explicitly selected copy, archives both full snapshots, and remains correct in a fresh tab context', async () => {
    const indexedDbRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'indexed-a', label: 'Pasta', known: true }], stapleIds: ['salt'] },
      version: 1,
      revision: 42,
      mirrorObsolete: true,
    });
    const localRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'local-b', label: 'Riso', known: true }], stapleIds: [] },
      version: 1,
    });
    await indexedDb.writeKeyValue('pantry', indexedDbRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, localRaw);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-idb-pending`, '1');
    await expect(readPantrySnapshot()).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });

    const beforeRecovery = await indexedDb.readKeyValue<{
      copies: Array<{ id: string; snapshot: { pantryItems: Array<{ id: string }> } }>;
    }>('ikuck:guest:ikuck-pantry-conflict-backup-v1');
    expect(beforeRecovery?.copies.map((copy) => copy.snapshot.pantryItems[0]?.id)).toEqual(['indexed-a', 'local-b']);

    await expect(recoverPantrySnapshot('guest', 'local-storage')).resolves.toMatchObject({
      pantryItems: [{ id: 'local-b' }],
      stapleIds: [],
    });

    const indexedAfterRecovery = await indexedDb.readKeyValue<string>('pantry');
    const mirrorAfterRecovery = window.localStorage.getItem(PANTRY_STORAGE_KEY);
    expect(JSON.parse(indexedAfterRecovery ?? '{}')).toMatchObject({
      mirrorObsolete: false,
      state: { pantryItems: [{ id: 'local-b' }], stapleIds: [] },
    });
    expect(JSON.parse(mirrorAfterRecovery ?? '{}')).toMatchObject({
      state: { pantryItems: [{ id: 'local-b' }], stapleIds: [] },
    });
    const archived = await indexedDb.readKeyValue<{ entries: Array<{
      selectedCopyId: string;
      copies: Array<{ snapshot: { pantryItems: Array<{ id: string }> } }>;
    }> }>('ikuck:guest:ikuck-pantry-conflict-archive-v1');
    expect(archived?.entries[0]).toMatchObject({
      selectedCopyId: 'local-storage',
      copies: [
        { snapshot: { pantryItems: [{ id: 'indexed-a' }] } },
        { snapshot: { pantryItems: [{ id: 'local-b' }] } },
      ],
    });
    expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBeNull();
    expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBeNull();

    // @ts-expect-error Vite query IDs provide an isolated module context for a reload-like read.
    const reloaded = await import('./pantryStorage?tab=post-recovery-reload');
    await expect(reloaded.readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'local-b' }] });
  });

  it('keeps both copies blocked and backed up when recovery cannot write the selected mirror', async () => {
    const indexedDbRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'indexed-a', label: 'Pasta', known: true }], stapleIds: [] },
      version: 1,
      revision: 42,
      mirrorObsolete: true,
    });
    const localRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'local-b', label: 'Riso', known: true }], stapleIds: [] },
      version: 1,
    });
    await indexedDb.writeKeyValue('pantry', indexedDbRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, localRaw);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-idb-pending`, '1');
    await expect(readPantrySnapshot()).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });

    const originalSetItem = Storage.prototype.setItem;
    const blockedMirrorWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === PANTRY_STORAGE_KEY && value.includes('indexed-a')) {
        throw new DOMException('Storage disabled', 'SecurityError');
      }
      return originalSetItem.call(this, key, value);
    });

    try {
      await expect(recoverPantrySnapshot('guest', 'indexed-db')).rejects.toThrow('browser mirror');
    } finally {
      blockedMirrorWrite.mockRestore();
    }

    const backup = await indexedDb.readKeyValue<{
      resolvedAt?: string;
      copies: Array<{ snapshot: { pantryItems: Array<{ id: string }> } }>;
    }>('ikuck:guest:ikuck-pantry-conflict-backup-v1');
    expect(backup?.resolvedAt).toBeUndefined();
    expect(backup?.copies.flatMap((copy) => copy.snapshot.pantryItems.map((item) => item.id))).toEqual(
      expect.arrayContaining(['indexed-a', 'local-b']),
    );
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(localRaw);
    await expect(readPantrySnapshot()).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
  });

  it.each(['indexed-db', 'local-storage'] as const)(
    'keeps recovery retryable after marker cleanup fails in %s mode and the tab reloads',
    async (mode) => {
      const backup = {
        id: `crash-${mode}`,
        scope: 'guest' as const,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-08T10:00:00.000Z',
        copies: [
          {
            id: 'indexed-db',
            label: 'Copia IndexedDB',
            revision: 42,
            snapshot: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: ['salt'] },
          },
          {
            id: 'local-storage',
            label: 'Copia localStorage',
            revision: null,
            snapshot: { pantryItems: [{ id: 'rice', label: 'Riso', known: true }], stapleIds: [] },
          },
        ],
      };
      const currentRaw = JSON.stringify({
        state: backup.copies[0].snapshot,
        version: 1,
        revision: 42,
        mirrorObsolete: true,
      });
      const markerKey = `${PANTRY_STORAGE_KEY}-conflict`;
      const pendingKey = `${PANTRY_STORAGE_KEY}-idb-pending`;
      const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
      const unavailable = mode === 'local-storage'
        ? vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false)
        : null;
      const restoreLocks = mode === 'local-storage'
        ? setNavigatorLocks(createSerializedTestLocks().manager)
        : () => undefined;

      if (mode === 'indexed-db') {
        await indexedDb.writeKeyValue('pantry', currentRaw);
        await indexedDb.writeKeyValue(backupKey, backup);
      } else {
        window.localStorage.setItem(backupKey, JSON.stringify(backup));
      }
      window.localStorage.setItem(PANTRY_STORAGE_KEY, currentRaw);
      window.localStorage.setItem(markerKey, '1');
      window.localStorage.setItem(pendingKey, '1');

      const originalRemoveItem = Storage.prototype.removeItem;
      const blockedMarkerRemoval = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
        if (key === markerKey) throw new DOMException('Marker cleanup interrupted', 'SecurityError');
        return originalRemoveItem.call(this, key);
      });

      try {
        await expect(recoverPantrySnapshot('guest', 'local-storage')).rejects.toThrow('markers could not be cleared');
      } finally {
        blockedMarkerRemoval.mockRestore();
      }

      try {
        let reloaded: typeof import('./pantryStorage');
        if (mode === 'indexed-db') {
          // @ts-expect-error Vite query IDs provide an isolated module context for a reload-like read.
          reloaded = await import('./pantryStorage?tab=recovery-crash-indexed-db');
        } else {
          // @ts-expect-error Vite query IDs provide an isolated module context for a reload-like read.
          reloaded = await import('./pantryStorage?tab=recovery-crash-local-storage');
        }
        const recoverable = await reloaded.readPantryConflictBackup('guest');
        expect(recoverable?.copies.map((copy) => copy.id)).toEqual(['indexed-db', 'local-storage']);
        await expect(reloaded.recoverPantrySnapshot('guest', 'indexed-db')).resolves.toMatchObject({
          pantryItems: [{ id: 'pasta' }],
          stapleIds: ['salt'],
        });
        expect(window.localStorage.getItem(markerKey)).toBeNull();
        expect(window.localStorage.getItem(pendingKey)).toBeNull();
        const archiveEntries = mode === 'indexed-db'
          ? (await indexedDb.readKeyValue<{ entries: Array<{ copies: unknown[] }> }>(
            scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'),
          ))?.entries
          : JSON.parse(window.localStorage.getItem(scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1')) ?? '[]') as Array<{
            copies: unknown[];
          }>;
        expect(archiveEntries?.some((entry) => Array.isArray(entry.copies) && entry.copies.length === 2)).toBe(true);
      } finally {
        restoreLocks();
        unavailable?.mockRestore();
      }
    },
  );

  it('preserves an entries-format local archive during local-only recovery', async () => {
    const localOnly = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    const restoreLocks = setNavigatorLocks(createSerializedTestLocks().manager);
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const previousEntry = {
      id: 'prior-local-archive',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T09:00:00.000Z',
      resolvedAt: '2026-10-08T09:30:00.000Z',
      selectedCopyId: 'prior-copy',
      copies: [{
        id: 'prior-copy',
        label: 'Copia precedente',
        revision: 8,
        snapshot: { pantryItems: [{ id: 'prior-item', label: 'Pasta', known: true }], stapleIds: [] },
      }],
    };
    const backup = {
      id: 'pending-local-recovery',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      copies: [
        { id: 'copy-a', label: 'Copia A', revision: 10, snapshot: { pantryItems: [{ id: 'copy-a', label: 'Riso', known: true }], stapleIds: [] } },
        { id: 'copy-b', label: 'Copia B', revision: 11, snapshot: { pantryItems: [{ id: 'copy-b', label: 'Fagioli', known: true }], stapleIds: ['salt'] } },
      ],
    };
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('current-canonical'));
    window.localStorage.setItem(backupKey, JSON.stringify(backup));
    window.localStorage.setItem(archiveKey, JSON.stringify({ entries: [previousEntry] }));
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');

    try {
      await expect(recoverPantrySnapshot('guest', 'copy-b')).resolves.toMatchObject({
        pantryItems: [{ id: 'copy-b' }],
        stapleIds: ['salt'],
      });
      const archived = JSON.parse(window.localStorage.getItem(archiveKey) ?? 'null') as {
        entries?: Array<{ id: string; selectedCopyId: string; copies: unknown[] }>;
      };
      expect(archived.entries?.map((entry) => entry.id)).toEqual(['prior-local-archive', 'pending-local-recovery']);
      expect(archived.entries?.[1]).toMatchObject({ selectedCopyId: 'copy-b', copies: [{ id: 'copy-a' }, { id: 'copy-b' }] });
      await expect(readPantryConflictArchive('guest')).resolves.toMatchObject([
        expect.objectContaining({ id: 'prior-local-archive' }),
        expect.objectContaining({ id: 'pending-local-recovery', selectedCopyId: 'copy-b' }),
      ]);
      expect(JSON.parse(window.localStorage.getItem(PANTRY_STORAGE_KEY) ?? '{}')).toMatchObject({
        state: { pantryItems: [{ id: 'copy-b' }], stapleIds: ['salt'] },
      });
    } finally {
      restoreLocks();
      localOnly.mockRestore();
    }
  });

  it('does not archive or resolve local-only recovery before the canonical pantry is durable', async () => {
    const localOnly = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    const restoreLocks = setNavigatorLocks(createSerializedTestLocks().manager);
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const canonicalRaw = persistedPantry('current-canonical');
    const backup = {
      id: 'canonical-write-fails',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      copies: [
        { id: 'current-copy', label: 'Copia attuale', revision: 10, snapshot: { pantryItems: [{ id: 'current-copy', label: 'Pasta', known: true }], stapleIds: [] } },
        { id: 'selected-copy', label: 'Copia selezionata', revision: 11, snapshot: { pantryItems: [{ id: 'selected-copy', label: 'Riso', known: true }], stapleIds: ['salt'] } },
      ],
    };
    window.localStorage.setItem(PANTRY_STORAGE_KEY, canonicalRaw);
    window.localStorage.setItem(backupKey, JSON.stringify(backup));
    window.localStorage.setItem(archiveKey, JSON.stringify({ entries: [] }));
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');
    const originalSetItem = Storage.prototype.setItem;
    const blockedCanonicalWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === PANTRY_STORAGE_KEY && value.includes('selected-copy')) {
        throw new DOMException('Canonical pantry write failed', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });

    try {
      await expect(recoverPantrySnapshot('guest', 'selected-copy')).rejects.toThrow('Canonical pantry write failed');
      expect(JSON.parse(window.localStorage.getItem(archiveKey) ?? 'null')).toEqual({ entries: [] });
      await expect(readPantryConflictArchive('guest')).resolves.toEqual([]);
      const activeBackup = await readPantryConflictBackup('guest');
      expect(activeBackup).toMatchObject({
        id: 'canonical-write-fails',
        copies: [{ id: 'current-copy' }, { id: 'selected-copy' }],
      });
      expect(activeBackup?.resolvedAt).toBeUndefined();
      expect(activeBackup?.selectedCopyId).toBeUndefined();
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(canonicalRaw);
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBe('1');
    } finally {
      blockedCanonicalWrite.mockRestore();
      restoreLocks();
      localOnly.mockRestore();
    }
  });

  it('keeps post-canonical local recovery retryable without duplicating archived copies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:00:00.000Z'));
    const localOnly = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    const restoreLocks = setNavigatorLocks(createSerializedTestLocks().manager);
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const backup = {
      id: 'retry-local-recovery',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-09T09:00:00.000Z',
      copies: [
        { id: 'original-a', label: 'Copia A', revision: 10, snapshot: { pantryItems: [{ id: 'original-a', label: 'Pasta', known: true }], stapleIds: [] } },
        { id: 'original-b', label: 'Copia B', revision: 11, snapshot: { pantryItems: [{ id: 'original-b', label: 'Riso', known: true }], stapleIds: ['salt'] } },
      ],
    };
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('current-canonical'));
    window.localStorage.setItem(backupKey, JSON.stringify(backup));
    window.localStorage.setItem(archiveKey, JSON.stringify({ entries: [] }));
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');
    let failBackupResolution = true;
    const originalSetItem = Storage.prototype.setItem;
    const blockedBackupResolution = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === backupKey && failBackupResolution && value.includes('"resolvedAt"')) {
        failBackupResolution = false;
        throw new DOMException('Backup resolution failed', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });

    try {
      await expect(recoverPantrySnapshot('guest', 'original-b')).rejects.toThrow('Backup resolution failed');
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBe('1');
      expect((await readPantryConflictBackup('guest'))?.resolvedAt).toBeUndefined();
      expect(JSON.parse(window.localStorage.getItem(archiveKey) ?? 'null')).toMatchObject({
        entries: [expect.objectContaining({ id: 'retry-local-recovery', selectedCopyId: 'original-b' })],
      });

      vi.setSystemTime(new Date('2026-10-09T10:00:01.000Z'));
      await expect(recoverPantrySnapshot('guest', 'original-b')).resolves.toMatchObject({
        pantryItems: [{ id: 'original-b' }],
      });
      const archive = JSON.parse(window.localStorage.getItem(archiveKey) ?? 'null') as {
        entries: Array<{ id: string; selectedCopyId: string; copies: Array<{ id: string }> }>;
      };
      expect(archive.entries).toHaveLength(1);
      expect(archive.entries[0]).toMatchObject({
        id: 'retry-local-recovery',
        selectedCopyId: 'original-b',
      });
      expect(archive.entries[0]?.copies.map((copy) => copy.id)).toEqual(['original-a', 'original-b']);
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBeNull();
    } finally {
      blockedBackupResolution.mockRestore();
      restoreLocks();
      localOnly.mockRestore();
      vi.useRealTimers();
    }
  });

  it('serializes local-only recovery across independent tabs before changing the archive or canonical copy', async () => {
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabAImport = import('./pantryStorage?tab=local-recovery-a');
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabBImport = import('./pantryStorage?tab=local-recovery-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]) as [
      typeof import('./pantryStorage'),
      typeof import('./pantryStorage'),
    ];
    const localOnly = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const conflictBackup = {
      id: 'local-recovery-race',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      copies: [
        { id: 'copy-a', label: 'Copia A', revision: 10, snapshot: { pantryItems: [{ id: 'copy-a', label: 'Copia A', known: true }], stapleIds: [] } },
        { id: 'copy-b', label: 'Copia B', revision: 11, snapshot: { pantryItems: [{ id: 'copy-b', label: 'Copia B', known: true }], stapleIds: [] } },
      ],
    };
    const protectedRaw = persistedPantry('protected-current');
    const backupRaw = JSON.stringify(conflictBackup);
    const archiveRaw = '[]';
    window.localStorage.setItem(PANTRY_STORAGE_KEY, protectedRaw);
    window.localStorage.setItem(backupKey, backupRaw);
    window.localStorage.setItem(archiveKey, archiveRaw);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');

    const { manager, names } = createSerializedTestLocks();
    const restoreLocks = setNavigatorLocks(manager);
    try {
      const results = await Promise.allSettled([
        tabA.recoverPantrySnapshot('guest', 'copy-a'),
        tabB.recoverPantrySnapshot('guest', 'copy-b'),
      ]);
      expect(names).toEqual(['ikuck:pantry:guest', 'ikuck:pantry:guest']);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const archive = JSON.parse(window.localStorage.getItem(archiveKey) ?? '[]') as Array<{
        selectedCopyId: string;
        copies: Array<{ id: string }>;
      }>;
      expect(archive).toHaveLength(1);
      expect(archive[0]?.copies.map((copy) => copy.id)).toEqual(['copy-a', 'copy-b']);
      const canonical = JSON.parse(window.localStorage.getItem(PANTRY_STORAGE_KEY) ?? '{}') as {
        state?: { pantryItems?: Array<{ id: string }> };
      };
      expect(canonical.state?.pantryItems?.[0]?.id).toBe(archive[0]?.selectedCopyId);
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBeNull();
    } finally {
      restoreLocks();
      localOnly.mockRestore();
    }
  });

  it('serializes reopening the same local-only archive across independent tabs', async () => {
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabAImport = import('./pantryStorage?tab=local-archive-reopen-a');
    // @ts-expect-error Vite query IDs provide isolated module state for independent tabs.
    const tabBImport = import('./pantryStorage?tab=local-archive-reopen-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]) as [
      typeof import('./pantryStorage'),
      typeof import('./pantryStorage'),
    ];
    const localOnly = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const archiveEntry = {
      id: 'reopen-race',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      resolvedAt: '2026-10-08T11:00:00.000Z',
      selectedCopyId: 'archived-copy',
      copies: [
        { id: 'archived-copy', label: 'Copia archiviata', revision: 10, snapshot: { pantryItems: [{ id: 'archived-copy', label: 'Archiviata', known: true }], stapleIds: [] } },
        { id: 'other-copy', label: 'Altra copia', revision: null, snapshot: { pantryItems: [{ id: 'other-copy', label: 'Altra', known: true }], stapleIds: [] } },
      ],
    };
    const archiveRaw = JSON.stringify([archiveEntry]);
    const canonicalRaw = persistedPantry('current-copy');
    window.localStorage.setItem(archiveKey, archiveRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, canonicalRaw);

    const { manager, names } = createSerializedTestLocks();
    const restoreLocks = setNavigatorLocks(manager);
    try {
      const results = await Promise.allSettled([
        tabA.reopenPantryArchivedConflict('guest', archiveEntry.id),
        tabB.reopenPantryArchivedConflict('guest', archiveEntry.id),
      ]);
      expect(names).toEqual(['ikuck:pantry:guest', 'ikuck:pantry:guest']);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(window.localStorage.getItem(archiveKey)).toBe(archiveRaw);
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(canonicalRaw);
      const activeBackup = JSON.parse(window.localStorage.getItem(scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY)) ?? 'null') as {
        copies?: Array<{ id: string }>;
      } | null;
      expect(activeBackup?.copies?.map((copy) => copy.id)).toEqual(['archived-copy', 'other-copy', 'current-reopen-race']);
    } finally {
      restoreLocks();
      localOnly.mockRestore();
    }
  });

  it.each([
    { operation: 'recovery', lockState: 'unavailable' },
    { operation: 'recovery', lockState: 'rejected' },
    { operation: 'archive reopen', lockState: 'unavailable' },
    { operation: 'archive reopen', lockState: 'rejected' },
  ] as const)(
    'fails closed without changing localStorage during %s when Web Locks are %s',
    async ({ operation, lockState }) => {
      const localOnly = vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
      const backupKey = scopeStorageKey('guest', PANTRY_CONFLICT_BACKUP_KEY);
      const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
      const copy = {
        id: 'preserved-copy',
        label: 'Copia conservata',
        revision: 10,
        snapshot: { pantryItems: [{ id: 'preserved-copy', label: 'Conservata', known: true }], stapleIds: [] },
      };
      const archiveEntry = {
        id: 'preserved-archive',
        scope: 'guest' as const,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-08T10:00:00.000Z',
        resolvedAt: '2026-10-08T11:00:00.000Z',
        selectedCopyId: copy.id,
        copies: [copy],
      };
      const canonicalRaw = persistedPantry('protected-canonical');
      window.localStorage.setItem(PANTRY_STORAGE_KEY, canonicalRaw);
      if (operation === 'recovery') {
        window.localStorage.setItem(backupKey, JSON.stringify({
          id: 'active-preserved', scope: 'guest', reason: 'concurrent-write',
          createdAt: '2026-10-08T10:00:00.000Z', copies: [copy],
        }));
        window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-conflict`, '1');
      } else {
        window.localStorage.setItem(archiveKey, JSON.stringify([archiveEntry]));
      }
      const backupBefore = window.localStorage.getItem(backupKey);
      const archiveBefore = window.localStorage.getItem(archiveKey);
      const markerBefore = window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`);
      let requestCount = 0;
      const lockManager: TestLockManager | undefined = lockState === 'unavailable' ? undefined : {
        async request() {
          requestCount += 1;
          throw new Error('lock backend rejected');
        },
      };
      const restoreLocks = setNavigatorLocks(lockManager);

      try {
        const operationPromise = operation === 'recovery'
          ? recoverPantrySnapshot('guest', copy.id)
          : reopenPantryArchivedConflict('guest', archiveEntry.id);
        await expect(operationPromise).rejects.toThrow(/Web Locks/);
        expect(requestCount).toBe(lockState === 'rejected' ? 1 : 0);
        expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(canonicalRaw);
        expect(window.localStorage.getItem(backupKey)).toBe(backupBefore);
        expect(window.localStorage.getItem(archiveKey)).toBe(archiveBefore);
        expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBe(markerBefore);
      } finally {
        restoreLocks();
        localOnly.mockRestore();
      }
    },
  );

  it('aborts finalization when conflict copies change after commit and archives the refreshed set on retry', async () => {
    const indexedDbRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'indexed-a', label: 'Pasta', known: true }], stapleIds: ['salt'] },
      version: 1,
      revision: 42,
      mirrorObsolete: true,
    });
    const localRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'local-b', label: 'Riso', known: true }], stapleIds: [] },
      version: 1,
    });
    await indexedDb.writeKeyValue('pantry', indexedDbRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, localRaw);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-idb-pending`, '1');
    await expect(readPantrySnapshot()).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });

    const actualFinalize = indexedDb.finalizePantryRecoverySnapshot;
    const actualRead = indexedDb.readKeyValue;
    const actualWrite = indexedDb.writeKeyValue;
    let appended = false;
    const appendBetweenCommitAndFinalize = vi.spyOn(indexedDb, 'finalizePantryRecoverySnapshot').mockImplementation(async (...args) => {
      if (!appended) {
        const conflictKey = args[1];
        const active = await actualRead<Record<string, unknown>>(conflictKey);
        expect(active).toMatchObject({ recoveryPendingCopyId: 'local-storage' });
        const addedCopy = {
          id: 'late-writer',
          label: 'Modifica concorrente',
          revision: 43,
          snapshot: { pantryItems: [{ id: 'late-writer', label: 'Fagioli', known: true }], stapleIds: [] },
        };
        await actualWrite(conflictKey, {
          ...active,
          copies: [...(active?.copies as unknown[]), addedCopy],
        });
        appended = true;
      }
      return actualFinalize(...args);
    });

    try {
      await expect(recoverPantrySnapshot('guest', 'local-storage')).rejects.toThrow(/could not be finalized/i);
      expect(appended).toBe(true);
      const active = await readPantryConflictBackup('guest');
      expect(active?.resolvedAt).toBeUndefined();
      expect(active?.copies.map((copy) => copy.id)).toEqual(['indexed-db', 'local-storage', 'late-writer']);
      const pendingArchive = await indexedDb.readKeyValue<{ entries: Array<Record<string, unknown>> }>(
        scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'),
      );
      expect(pendingArchive?.entries).toHaveLength(1);
      expect(pendingArchive?.entries[0]?.resolvedAt).toBeUndefined();
      await expect(readPantryConflictArchive('guest')).resolves.toEqual([]);
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).not.toBe(localRaw);
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBe('1');

      await expect(recoverPantrySnapshot('guest', 'local-storage')).resolves.toMatchObject({
        pantryItems: [{ id: 'local-b' }],
      });
      const archived = await readPantryConflictArchive('guest');
      expect(archived).toHaveLength(1);
      expect(archived[0]?.copies.map((copy) => copy.id)).toEqual(['indexed-db', 'local-storage', 'late-writer']);
      expect(archived[0]?.selectedCopyId).toBe('local-storage');
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-conflict`)).toBeNull();
    } finally {
      appendBetweenCommitAndFinalize.mockRestore();
    }
  });

  it.each(['entries', 'array'] as const)(
    'unions and reopens local-only archive entries beside a non-empty IndexedDB %s archive',
    async (archiveFormat) => {
      const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
      const indexedDbEntry = {
        id: 'existing-indexed-entry',
        scope: 'guest' as const,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-08T10:00:00.000Z',
        resolvedAt: '2026-10-08T10:30:00.000Z',
        selectedCopyId: 'indexed-copy',
        copies: [{
          id: 'indexed-copy',
          label: 'Copia IndexedDB',
          revision: 10,
          snapshot: { pantryItems: [{ id: 'indexed-item', label: 'Pasta', known: true }], stapleIds: [] },
        }],
      };
      const localEntry = {
        id: 'local-only-entry',
        scope: 'guest' as const,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-08T11:00:00.000Z',
        resolvedAt: '2026-10-08T11:30:00.000Z',
        selectedCopyId: 'local-copy-a',
        copies: [
          {
            id: 'local-copy-a',
            label: 'Copia localStorage selezionata',
            revision: 11,
            snapshot: { pantryItems: [{ id: 'local-item-a', label: 'Riso', known: true }], stapleIds: ['salt'] },
          },
          {
            id: 'local-copy-b',
            label: 'Altra copia localStorage',
            revision: null,
            snapshot: { pantryItems: [{ id: 'local-item-b', label: 'Fagioli', known: true }], stapleIds: [] },
          },
        ],
      };
      const indexedDbArchive = archiveFormat === 'entries'
        ? { entries: [indexedDbEntry] }
        : [indexedDbEntry];
      const localArchiveRaw = JSON.stringify([localEntry]);
      const currentRaw = persistedPantry('current-canonical');
      await indexedDb.writeKeyValue(archiveKey, indexedDbArchive);
      await indexedDb.writeKeyValue('pantry', currentRaw);
      window.localStorage.setItem(archiveKey, localArchiveRaw);
      window.localStorage.setItem(PANTRY_STORAGE_KEY, currentRaw);

      const visible = await readPantryConflictArchive('guest');
      expect(visible.map((entry) => entry.id)).toEqual(['existing-indexed-entry', 'local-only-entry']);
      expect(visible[1]).toMatchObject(localEntry);
      // @ts-expect-error Vite query IDs provide isolated module state for a reload.
      const reloaded = await import('./pantryStorage?tab=archive-union-reload') as typeof import('./pantryStorage');
      expect((await reloaded.readPantryConflictArchive('guest')).map((entry) => entry.id)).toEqual([
        'existing-indexed-entry',
        'local-only-entry',
      ]);
      expect(await indexedDb.readKeyValue(archiveKey)).toEqual(indexedDbArchive);
      expect(window.localStorage.getItem(archiveKey)).toBe(localArchiveRaw);

      const reopened = await reopenPantryArchivedConflict('guest', localEntry.id);
      expect(reopened.copies.map((copy) => copy.id)).toEqual([
        'local-copy-a',
        'local-copy-b',
        'current-local-only-entry',
      ]);
      expect(reopened.copies).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'local-copy-a',
          snapshot: expect.objectContaining({
            pantryItems: expect.arrayContaining([expect.objectContaining({ id: 'local-item-a', label: 'Riso' })]),
            stapleIds: ['salt'],
          }),
        }),
        expect.objectContaining({
          id: 'local-copy-b',
          snapshot: expect.objectContaining({
            pantryItems: expect.arrayContaining([expect.objectContaining({ id: 'local-item-b', label: 'Fagioli' })]),
            stapleIds: [],
          }),
        }),
        expect.objectContaining({
          id: 'current-local-only-entry',
          snapshot: expect.objectContaining({
            pantryItems: expect.arrayContaining([expect.objectContaining({ id: 'current-canonical' })]),
          }),
        }),
      ]));
      expect((await readPantryConflictArchive('guest')).map((entry) => entry.id)).toEqual([
        'existing-indexed-entry',
        'local-only-entry',
      ]);
      expect(await indexedDb.readKeyValue(archiveKey)).toEqual(indexedDbArchive);
      expect(window.localStorage.getItem(archiveKey)).toBe(localArchiveRaw);
    },
  );

  it('deduplicates identical archive records but preserves divergent entry and copy ID collisions', async () => {
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const indexedDbEntry = {
      id: 'shared-archive-entry',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      resolvedAt: '2026-10-08T10:30:00.000Z',
      selectedCopyId: 'shared-copy',
      copies: [{
        id: 'shared-copy',
        label: 'Copia IndexedDB',
        revision: 10,
        snapshot: { pantryItems: [{ id: 'indexed-item', label: 'Pasta', known: true }], stapleIds: [] },
      }],
    };
    const localConflictEntry = {
      ...indexedDbEntry,
      selectedCopyId: 'local-selected-copy',
      copies: [
        {
          id: 'shared-copy',
          label: 'Prima copia locale',
          revision: 11,
          snapshot: { pantryItems: [{ id: 'local-item-a', label: 'Riso', known: true }], stapleIds: [] },
        },
        {
          id: 'shared-copy',
          label: 'Seconda copia locale',
          revision: 12,
          snapshot: { pantryItems: [{ id: 'local-item-b', label: 'Fagioli', known: true }], stapleIds: ['salt'] },
        },
        {
          id: 'local-selected-copy',
          label: 'Scelta locale esplicita',
          revision: 13,
          snapshot: { pantryItems: [{ id: 'local-item-c', label: 'Orzo', known: true }], stapleIds: [] },
        },
      ],
    };
    await indexedDb.writeKeyValue(archiveKey, { entries: [indexedDbEntry, indexedDbEntry] });
    window.localStorage.setItem(archiveKey, JSON.stringify([indexedDbEntry, localConflictEntry]));

    const archive = await readPantryConflictArchive('guest');
    expect(archive.map((entry) => entry.id)).toEqual([
      'shared-archive-entry',
      'shared-archive-entry-local-storage',
    ]);
    expect(archive[1]?.copies.map((copy) => copy.id)).toEqual([
      'shared-copy',
      'shared-copy-duplicate-2',
      'local-selected-copy',
    ]);
    expect(archive[1]?.selectedCopyId).toBe('local-selected-copy');
    expect(archive[1]?.copies.map((copy) => copy.snapshot.pantryItems[0]?.id)).toEqual([
      'local-item-a',
      'local-item-b',
      'local-item-c',
    ]);
  });

  it.each(['entries', 'array'] as const)(
    'isolates malformed archive records and copies from valid %s history',
    async (archiveFormat) => {
      const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
      const indexedEntry = {
        id: 'indexed-valid-entry',
        scope: 'guest' as const,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-08T10:00:00.000Z',
        resolvedAt: '2026-10-08T10:30:00.000Z',
        selectedCopyId: 'indexed-valid-copy',
        copies: [
          { id: 'indexed-broken-copy', label: 'Copia danneggiata', revision: null, snapshot: {} },
          {
            id: 'indexed-valid-copy',
            label: 'Copia IndexedDB valida',
            revision: 10,
            snapshot: { pantryItems: [{ id: 'indexed-item', label: 'Pasta', known: true }], stapleIds: [] },
          },
        ],
      };
      const indexedCorruptOnlyEntry = {
        ...indexedEntry,
        id: 'indexed-corrupt-only-entry',
        selectedCopyId: 'indexed-broken-copy',
        copies: [{ id: 'indexed-broken-copy', label: 'Copia senza snapshot', revision: null, snapshot: {} }],
      };
      const indexedEntries = [indexedCorruptOnlyEntry, indexedEntry];
      const indexedArchive = archiveFormat === 'entries' ? { entries: indexedEntries } : indexedEntries;
      const localEntry = {
        id: 'local-valid-entry',
        scope: 'guest' as const,
        reason: 'concurrent-write' as const,
        createdAt: '2026-10-08T11:00:00.000Z',
        resolvedAt: '2026-10-08T11:30:00.000Z',
        selectedCopyId: 'local-valid-copy-b',
        copies: [
          { id: 'local-valid-copy-a', label: 'Copia localStorage danneggiata', revision: null, snapshot: {} },
          { id: 'local-invalid-structure', revision: null, snapshot: null },
          {
            id: 'local-valid-copy-a',
            label: 'Prima copia localStorage',
            revision: 11,
            snapshot: { pantryItems: [{ id: 'local-item-a', label: 'Riso', known: true }], stapleIds: [] },
          },
          {
            id: 'local-valid-copy-a',
            label: 'Copia divergente localStorage',
            revision: 13,
            snapshot: { pantryItems: [{ id: 'local-item-a-divergent', label: 'Orzo', known: true }], stapleIds: [] },
          },
          {
            id: 'local-valid-copy-b',
            label: 'Copia localStorage selezionata',
            revision: 12,
            snapshot: { pantryItems: [{ id: 'local-item-b', label: 'Fagioli', known: true }], stapleIds: ['salt'] },
          },
        ],
      };
      const localCorruptOnlyEntry = {
        ...localEntry,
        id: 'local-corrupt-only-entry',
        selectedCopyId: 'local-broken-copy',
        copies: [{ id: 'local-broken-copy', label: 'Copia danneggiata', revision: null, snapshot: {} }],
      };
      const localArchiveRaw = JSON.stringify([null, localCorruptOnlyEntry, localEntry]);
      const currentRaw = persistedPantry('current-canonical');
      await indexedDb.writeKeyValue(archiveKey, indexedArchive);
      await indexedDb.writeKeyValue('pantry', currentRaw);
      window.localStorage.setItem(archiveKey, localArchiveRaw);
      window.localStorage.setItem(PANTRY_STORAGE_KEY, currentRaw);

      const visible = await readPantryConflictArchive('guest');
      expect(visible.map((entry) => entry.id)).toEqual(['indexed-valid-entry', 'local-valid-entry']);
      expect(visible[0]?.copies.map((copy) => copy.id)).toEqual(['indexed-valid-copy']);
      expect(visible[0]?.selectedCopyId).toBe('indexed-valid-copy');
      expect(visible[1]?.copies.map((copy) => copy.id)).toEqual([
        'local-valid-copy-a',
        'local-valid-copy-a-duplicate-2',
        'local-valid-copy-b',
      ]);
      expect(visible[1]?.selectedCopyId).toBe('local-valid-copy-b');
      expect(visible[1]?.copies.map((copy) => copy.snapshot.pantryItems[0]?.id)).toEqual([
        'local-item-a',
        'local-item-a-divergent',
        'local-item-b',
      ]);

      // @ts-expect-error Vite query IDs provide an isolated module context for a reload-like read.
      const reloaded = await import('./pantryStorage?tab=malformed-archive-reload') as typeof import('./pantryStorage');
      const afterReload = await reloaded.readPantryConflictArchive('guest');
      expect(afterReload.map((entry) => entry.id)).toEqual(['indexed-valid-entry', 'local-valid-entry']);
      expect(await indexedDb.readKeyValue(archiveKey)).toEqual(indexedArchive);
      expect(window.localStorage.getItem(archiveKey)).toBe(localArchiveRaw);

      const reopened = await reloaded.reopenPantryArchivedConflict('guest', 'local-valid-entry');
      expect(reopened.copies.map((copy) => copy.id)).toEqual([
        'local-valid-copy-a',
        'local-valid-copy-a-duplicate-2',
        'local-valid-copy-b',
        'current-local-valid-entry',
      ]);
      expect(reopened.copies.map((copy) => copy.snapshot.pantryItems[0]?.id)).toEqual([
        'local-item-a',
        'local-item-a-divergent',
        'local-item-b',
        'current-canonical',
      ]);
      expect(await indexedDb.readKeyValue(archiveKey)).toEqual(indexedArchive);
      expect(window.localStorage.getItem(archiveKey)).toBe(localArchiveRaw);
    },
  );

  it('rejects archive copies with malformed pantry lots without hiding valid legacy copies', async () => {
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const entry = {
      id: 'archive-with-malformed-lot',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      resolvedAt: '2026-10-08T10:30:00.000Z',
      selectedCopyId: 'valid-legacy-copy',
      copies: [
        {
          id: 'malformed-lot-copy',
          label: 'Copia con lotto danneggiato',
          revision: null,
          snapshot: { pantryItems: [], stapleIds: [], pantryLots: [{}] },
        },
        {
          id: 'valid-legacy-copy',
          label: 'Copia legacy valida',
          revision: 10,
          snapshot: { pantryItems: [{ id: 'legacy-item', label: 'Pasta', known: true }], stapleIds: [] },
        },
      ],
    };
    await indexedDb.writeKeyValue(archiveKey, { entries: [entry] });

    await expect(readPantryConflictArchive('guest')).resolves.toMatchObject([
      expect.objectContaining({
        id: 'archive-with-malformed-lot',
        selectedCopyId: 'valid-legacy-copy',
        copies: [expect.objectContaining({ id: 'valid-legacy-copy' })],
      }),
    ]);
  });

  it('keeps the readable archive source available when the other source fails', async () => {
    const archiveKey = scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1');
    const indexedDbEntry = {
      id: 'readable-indexed-entry',
      scope: 'guest' as const,
      reason: 'concurrent-write' as const,
      createdAt: '2026-10-08T10:00:00.000Z',
      resolvedAt: '2026-10-08T10:30:00.000Z',
      selectedCopyId: 'indexed-copy',
      copies: [{
        id: 'indexed-copy',
        label: 'Copia IndexedDB',
        revision: 10,
        snapshot: { pantryItems: [{ id: 'indexed-item', label: 'Pasta', known: true }], stapleIds: [] },
      }],
    };
    const localEntry = {
      ...indexedDbEntry,
      id: 'readable-local-entry',
      copies: [{
        id: 'local-copy',
        label: 'Copia localStorage',
        revision: 11,
        snapshot: { pantryItems: [{ id: 'local-item', label: 'Riso', known: true }], stapleIds: [] },
      }],
    };
    await indexedDb.writeKeyValue(archiveKey, { entries: [indexedDbEntry] });
    window.localStorage.setItem(archiveKey, '{malformed-json');

    await expect(readPantryConflictArchive('guest')).resolves.toMatchObject([
      expect.objectContaining({ id: 'readable-indexed-entry' }),
    ]);

    const actualGetItem = window.localStorage.getItem.bind(window.localStorage);
    const deniedLocalRead = vi.spyOn(window.localStorage, 'getItem').mockImplementation((key) => {
      if (key === archiveKey) throw new Error('local archive read denied');
      return actualGetItem(key);
    });
    try {
      await expect(readPantryConflictArchive('guest')).resolves.toMatchObject([
        expect.objectContaining({ id: 'readable-indexed-entry' }),
      ]);
    } finally {
      deniedLocalRead.mockRestore();
    }

    const localArchiveRaw = JSON.stringify([localEntry]);
    window.localStorage.setItem(archiveKey, localArchiveRaw);
    const actualRead = indexedDb.readKeyValue;
    const failedIndexedDbRead = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key === archiveKey) throw new Error('IndexedDB archive read failed');
      return actualRead(key);
    });
    try {
      await expect(readPantryConflictArchive('guest')).resolves.toMatchObject([
        expect.objectContaining({ id: 'readable-local-entry' }),
      ]);
      expect(window.localStorage.getItem(archiveKey)).toBe(localArchiveRaw);
    } finally {
      failedIndexedDbRead.mockRestore();
    }
  });

  it('aborts recovery with the expanded copy set when a compare transaction appends a copy before commit', async () => {
    const indexedDbRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'indexed-a', label: 'Pasta', known: true }], stapleIds: ['salt'] },
      version: 1,
      revision: 42,
      mirrorObsolete: true,
    });
    const localRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'local-b', label: 'Riso', known: true }], stapleIds: [] },
      version: 1,
    });
    await indexedDb.writeKeyValue('pantry', indexedDbRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, localRaw);
    window.localStorage.setItem(`${PANTRY_STORAGE_KEY}-idb-pending`, '1');
    await expect(readPantrySnapshot()).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });

    const actualWrite = indexedDb.writeKeyValue;
    const actualCommit = indexedDb.commitPantryRecoverySnapshot;
    let appended = false;
    const controlledInterleaving = vi.spyOn(indexedDb, 'commitPantryRecoverySnapshot').mockImplementation(async (...args) => {
      if (!appended) {
        const [pantryKey, backupKey] = args;
        const addedCopy = {
          id: 'concurrent-tab',
          label: 'Modifica concorrente',
          revision: 43,
          snapshot: { pantryItems: [{ id: 'concurrent-c', label: 'Fagioli', known: true }], stapleIds: [] },
        };
        const compare = {
          expectedValue: 'stale-recovery-read',
          conflictKey: backupKey,
          preserveConflict: (_current: unknown, previous: unknown) => {
            const prior = previous as { copies: unknown[] };
            return { ...prior, copies: [...prior.copies, addedCopy] };
          },
        };
        await expect(actualWrite(pantryKey, 'concurrent-attempt', undefined, compare)).resolves.toBe(false);
        appended = true;
      }
      return actualCommit(...args);
    });

    try {
      await expect(recoverPantrySnapshot('guest', 'local-storage')).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        copies: expect.arrayContaining([expect.objectContaining({ id: 'concurrent-tab' })]),
      });
      expect(appended).toBe(true);
      const active = await readPantryConflictBackup('guest');
      expect(active?.copies.map((copy) => copy.id)).toEqual(['indexed-db', 'local-storage', 'concurrent-tab']);
      await expect(indexedDb.readKeyValue<string>('pantry')).resolves.toBe(indexedDbRaw);
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(localRaw);
      await expect(indexedDb.readKeyValue(scopeStorageKey('guest', 'ikuck-pantry-conflict-archive-v1'))).resolves.toBeNull();
    } finally {
      controlledInterleaving.mockRestore();
    }
  });

  it('does not recover a House pantry while membership scope is uncertain', async () => {
    const scope = 'house:pantry-recovery-uncertain';
    const indexedDbKey = scopeStorageKey(scope, 'pantry');
    const mirrorKey = scopeStorageKey(scope, PANTRY_STORAGE_KEY);
    const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
    const indexedDbRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'house-indexed', label: 'Pasta', known: true }], stapleIds: [] },
      version: 1,
      revision: 42,
      mirrorObsolete: true,
    });
    const localRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'house-local', label: 'Riso', known: true }], stapleIds: [] },
      version: 1,
    });
    await indexedDb.writeKeyValue(indexedDbKey, indexedDbRaw);
    window.localStorage.setItem(mirrorKey, localRaw);
    window.localStorage.setItem(`${mirrorKey}-idb-pending`, '1');
    await expect(readPantrySnapshot(scope)).rejects.toMatchObject({ code: 'pantry_snapshot_conflict' });
    const backupBefore = await indexedDb.readKeyValue<{ copies: unknown[] }>(backupKey);

    markScopeUncertain(scope);
    try {
      await expect(recoverPantrySnapshot(scope, 'local-storage')).rejects.toMatchObject({ code: 'scope_unverified' });
    } finally {
      resumeScope(scope);
    }

    await expect(indexedDb.readKeyValue<string>(indexedDbKey)).resolves.toBe(indexedDbRaw);
    expect(window.localStorage.getItem(mirrorKey)).toBe(localRaw);
    await expect(indexedDb.readKeyValue(backupKey)).resolves.toEqual(backupBefore);
    await expect(indexedDb.readKeyValue(scopeStorageKey(scope, 'ikuck-pantry-conflict-archive-v1'))).resolves.toBeNull();
  });

  it('does not conflict on identical legacy snapshots with synthesized lot timestamps', async () => {
    const identicalRaw = JSON.stringify({
      state: { pantryItems: [{ id: 'same-item', label: 'Same', known: true }], stapleIds: [] },
      version: 1,
      revision: 17,
      mirrorObsolete: true,
    });
    await indexedDb.writeKeyValue('pantry', identicalRaw);
    window.localStorage.setItem(PANTRY_STORAGE_KEY, identicalRaw);
    let generatedTimestamp = 0;
    const timestamp = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      const second = String(generatedTimestamp).padStart(2, '0');
      generatedTimestamp += 1;
      return `2026-10-08T10:00:${second}.000Z`;
    });

    try {
      await expect(readPantrySnapshot()).resolves.toMatchObject({
        pantryItems: [{ id: 'same-item' }],
        stapleIds: [],
      });
    } finally {
      timestamp.mockRestore();
    }
  });

  it.each(['readPantrySnapshot', 'pantryStorage.getItem'] as const)(
    'preserves an unrevisioned mirror when revisioned obsolete IndexedDB lacks the pending marker via %s',
    async (reader) => {
      const indexedDbRaw = JSON.stringify({
        ...JSON.parse(persistedPantry('indexed-copy')) as Record<string, unknown>,
        revision: 52,
        mirrorObsolete: true,
      });
      const localRaw = persistedPantry('legacy-copy');
      await indexedDb.writeKeyValue('pantry', indexedDbRaw);
      window.localStorage.setItem(PANTRY_STORAGE_KEY, localRaw);
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBeNull();

      // The pending bit is only advisory: after a reload, its absence cannot order an
      // unrevisioned local snapshot against an obsolete revisioned IndexedDB snapshot.
      const read = reader === 'readPantrySnapshot'
        ? readPantrySnapshot()
        : pantryStorage.getItem(PANTRY_STORAGE_KEY);
      await expect(read).rejects.toMatchObject({
        code: 'pantry_snapshot_conflict',
        reason: 'unrevisioned-local-write',
        indexedDbSnapshot: { pantryItems: [{ id: 'indexed-copy' }] },
        localSnapshot: { pantryItems: [{ id: 'legacy-copy' }] },
      });

      const backup = await readPantryConflictBackup('guest');
      expect(backup?.copies.map((copy) => copy.snapshot.pantryItems[0]?.id)).toEqual(['indexed-copy', 'legacy-copy']);
      expect(await indexedDb.readKeyValue('pantry')).toBe(indexedDbRaw);
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(localRaw);
      expect(window.localStorage.getItem(`${PANTRY_STORAGE_KEY}-idb-pending`)).toBeNull();
    },
  );

  it('merges conflict copies observed by concurrent IndexedDB readers before backup writes', async () => {
    const scope = 'account:read-conflict-race';
    const databaseKey = scopeStorageKey(scope, 'pantry');
    const mirrorKey = scopeStorageKey(scope, PANTRY_STORAGE_KEY);
    const backupKey = scopeStorageKey(scope, PANTRY_CONFLICT_BACKUP_KEY);
    const revisionedPantry = (id: string) => JSON.stringify({
      state: { pantryItems: [{ id, label: id, known: true }], stapleIds: [] },
      version: 1,
      revision: 12,
      mirrorObsolete: true,
    });
    window.localStorage.setItem(mirrorKey, revisionedPantry('local-mirror'));
    // @ts-expect-error Vite query IDs provide isolated module contexts for independent tabs.
    const tabAImport = import('./pantryStorage?tab=read-conflict-race-a');
    // @ts-expect-error Vite query IDs provide isolated module contexts for independent tabs.
    const tabBImport = import('./pantryStorage?tab=read-conflict-race-b');
    const [tabA, tabB] = await Promise.all([tabAImport, tabBImport]) as [
      typeof import('./pantryStorage'),
      typeof import('./pantryStorage'),
    ];
    const actualRead = indexedDb.readKeyValue;
    let canonicalReads = 0;
    let backupReads = 0;
    let holdStaleBackupReads = true;
    let releaseStaleBackupReads!: () => void;
    let signalTwoStaleBackupReads!: () => void;
    let signalTwoAtomicBackupUpdates!: () => void;
    const staleBackupReadGate = new Promise<void>((resolve) => { releaseStaleBackupReads = resolve; });
    const twoStaleBackupReads = new Promise<void>((resolve) => { signalTwoStaleBackupReads = resolve; });
    const twoAtomicBackupUpdates = new Promise<void>((resolve) => { signalTwoAtomicBackupUpdates = resolve; });
    let atomicBackupUpdates = 0;
    const actualUpdate = indexedDb.updateKeyValue;
    const read = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key === databaseKey) {
        const readIndex = canonicalReads;
        canonicalReads += 1;
        const current = await actualRead(key);
        return current ?? revisionedPantry(readIndex === 0 ? 'indexed-a' : 'indexed-b');
      }
      if (key === backupKey) {
        backupReads += 1;
        const observed = await actualRead(key);
        if (backupReads > 2 && holdStaleBackupReads) {
          if (backupReads === 4) signalTwoStaleBackupReads();
          await staleBackupReadGate;
        }
        return observed;
      }
      return actualRead(key);
    });
    const update = vi.spyOn(indexedDb, 'updateKeyValue').mockImplementation(async (key, updater, assertWritable) => {
      if (key === backupKey) {
        atomicBackupUpdates += 1;
        if (atomicBackupUpdates === 2) signalTwoAtomicBackupUpdates();
      }
      return actualUpdate(key, updater, assertWritable);
    });

    try {
      const reads = [tabA.readPantrySnapshot(scope), tabB.readPantrySnapshot(scope)];
      await Promise.race([twoStaleBackupReads, twoAtomicBackupUpdates]);
      holdStaleBackupReads = false;
      releaseStaleBackupReads();
      const outcomes = await Promise.allSettled(reads);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
      const backup = await tabA.readPantryConflictBackup(scope) as {
        copies: Array<{ snapshot: { pantryItems: Array<{ id: string }> } }>;
      } | null;
      const preservedIds = backup?.copies.flatMap((copy) => copy.snapshot.pantryItems.map((item) => item.id));
      expect(preservedIds).toEqual(expect.arrayContaining(['indexed-a', 'indexed-b', 'local-mirror']));
      expect(atomicBackupUpdates).toBe(2);
    } finally {
      holdStaleBackupReads = false;
      releaseStaleBackupReads();
      read.mockRestore();
      update.mockRestore();
    }
  });

  it('uses a discordant legacy mirror when no pending-write marker exists', async () => {
    await indexedDb.writeKeyValue('pantry', persistedPantry('pasta'));
    window.localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify({
      state: { pantryItems: [{ id: 'tomato', label: 'Pomodoro', known: true }], stapleIds: [] },
      version: 1,
    }));

    await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.toContain('tomato');
    await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.not.toContain('pasta');
  });

  it('reads IndexedDB when the localStorage pantry mirror throws', async () => {
    await indexedDb.writeKeyValue('pantry', persistedPantry('tomato'));
    const getItemOriginal = Storage.prototype.getItem;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === PANTRY_STORAGE_KEY) throw new DOMException('Storage disabled', 'SecurityError');
      return getItemOriginal.call(this, key);
    });

    await expect(pantryStorage.getItem(PANTRY_STORAGE_KEY)).resolves.toContain('tomato');

    getItem.mockRestore();
  });

  it('imports the iKuck localStorage snapshot into IndexedDB once', async () => {
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('pasta'));

    await migrateLegacyPantry();

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'pasta' }],
      stapleIds: ['salt'],
    });
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBeNull();
  });

  it('imports the legacy iRicetto snapshot and removes it after a successful write', async () => {
    window.localStorage.setItem(LEGACY_PANTRY_STORAGE_KEY, persistedPantry('legacy-pasta'));

    await migrateLegacyPantry();

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'legacy-pasta' }],
    });
    expect(window.localStorage.getItem(LEGACY_PANTRY_STORAGE_KEY)).toBeNull();
  });

  it('does not erase the localStorage snapshot when the IndexedDB write fails', async () => {
    const snapshot = persistedPantry('pasta');
    window.localStorage.setItem(PANTRY_STORAGE_KEY, snapshot);
    vi.spyOn(indexedDb, 'writeKeyValue').mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(migrateLegacyPantry()).rejects.toThrow('quota exceeded');
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBe(snapshot);
  });

  it('preserves a concurrent IndexedDB pantry commit when legacy migration resumes', async () => {
    const legacyRaw = persistedPantry('legacy-copy');
    window.localStorage.setItem(PANTRY_STORAGE_KEY, legacyRaw);
    // @ts-expect-error Vite query IDs provide isolated module contexts for independent tabs.
    const migrationTab = await import('./pantryStorage?tab=legacy-migration-race');
    // @ts-expect-error Vite query IDs provide isolated module contexts for independent tabs.
    const writerTab = await import('./pantryStorage?tab=legacy-migration-writer');
    const { manager } = createSerializedTestLocks();
    const restoreLocks = setNavigatorLocks(manager);
    let releaseMigrationRead!: () => void;
    let signalMigrationRead!: () => void;
    const migrationReadStarted = new Promise<void>((resolve) => { signalMigrationRead = resolve; });
    const migrationReadGate = new Promise<void>((resolve) => { releaseMigrationRead = resolve; });
    const actualRead = indexedDb.readKeyValue;
    let pausedMigrationRead = false;
    const read = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key === 'pantry' && !pausedMigrationRead) {
        pausedMigrationRead = true;
        signalMigrationRead();
        await migrationReadGate;
        return null;
      }
      return actualRead(key);
    });

    try {
      const migration = migrationTab.migrateLegacyPantry();
      await migrationReadStarted;
      const concurrentWrite = writerTab.writePantrySnapshot({
        pantryItems: [{ id: 'concurrent-copy', label: 'Modifica concorrente', known: true }],
        stapleIds: [],
      });
      await vi.waitFor(async () => {
        expect(await actualRead<string>('pantry')).toContain('concurrent-copy');
      });
      releaseMigrationRead();
      const [migrationResult, writeResult] = await Promise.allSettled([migration, concurrentWrite]);

      expect(migrationResult.status).toBe('rejected');
      expect(writeResult.status).toBe('fulfilled');
      const stored = await actualRead<string>('pantry');
      expect(stored).toContain('concurrent-copy');
      const backup = await migrationTab.readPantryConflictBackup('guest') as {
        copies: Array<{ snapshot: { pantryItems: Array<{ id: string }> } }>;
      } | null;
      const preservedIds = backup?.copies.flatMap((copy) => copy.snapshot.pantryItems.map((item) => item.id));
      expect(preservedIds).toEqual(expect.arrayContaining(['legacy-copy', 'concurrent-copy']));
    } finally {
      releaseMigrationRead();
      read.mockRestore();
      restoreLocks();
    }
  });

  it('writes and reads a clean pantry snapshot through the adapter', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
    });

    await expect(readPantrySnapshot()).resolves.toEqual({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
      pantryLots: [expect.objectContaining({
        id: 'pasta',
        ingredientId: 'pasta',
        quantity: null,
        unit: null,
        expiresAt: null,
      })],
    });
  });

  it('reads the latest snapshot while its IndexedDB write is still pending', async () => {
    await indexedDb.writeKeyValue('pantry', persistedPantry('old-pasta'));
    let resolveWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writeSpy = vi.spyOn(indexedDb, 'writeKeyValue').mockReturnValue(pendingWrite);
    const persistPromise = writePantrySnapshot({
      pantryItems: [{ id: 'new-pasta', label: 'Pasta', known: true }],
      stapleIds: ['salt'],
    });

    await Promise.resolve();

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'new-pasta' }],
    });

    resolveWrite?.();
    await persistPromise;
    writeSpy.mockRestore();
  });

  it('serializes concurrent revision reads so the last requested pantry snapshot wins', async () => {
    let releaseFirstRead!: () => void;
    let signalFirstRead!: () => void;
    let readCount = 0;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const firstReadStarted = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    const actualRead = indexedDb.readKeyValue;
    const read = vi.spyOn(indexedDb, 'readKeyValue').mockImplementation(async (key) => {
      if (key === 'pantry') {
        readCount += 1;
        if (readCount === 1) {
          signalFirstRead();
          await firstReadGate;
          return null;
        }
      }
      return actualRead(key);
    });

    const firstWrite = writePantrySnapshot({
      pantryItems: [{ id: 'first-pasta', label: 'First', known: true }],
      stapleIds: [],
    });
    await firstReadStarted;
    const lastWrite = writePantrySnapshot({
      pantryItems: [{ id: 'last-pasta', label: 'Last', known: true }],
      stapleIds: [],
    });

    try {
      await Promise.resolve();
      expect(readCount).toBe(1);
    } finally {
      releaseFirstRead();
      await Promise.all([firstWrite, lastWrite]);
      read.mockRestore();
    }

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryItems: [{ id: 'last-pasta' }],
    });
  });

  it('round-trips multiple lots without losing nullable details', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
      pantryLots: [
        {
          id: 'lot-1',
          ingredientId: 'pasta',
          label: 'Pasta',
          known: true,
          quantity: 500,
          unit: 'g',
          expiresAt: '2026-10-01',
          createdAt: '2026-09-13T10:00:00.000Z',
          updatedAt: '2026-09-13T10:00:00.000Z',
        },
        {
          id: 'lot-2',
          ingredientId: 'pasta',
          label: 'Pasta',
          known: true,
          quantity: null,
          unit: null,
          expiresAt: null,
          createdAt: '2026-09-13T11:00:00.000Z',
          updatedAt: '2026-09-13T11:00:00.000Z',
        },
      ],
    });

    await expect(readPantrySnapshot()).resolves.toMatchObject({
      pantryLots: [
        expect.objectContaining({ id: 'lot-1', quantity: 500, unit: 'g', expiresAt: '2026-10-01' }),
        expect.objectContaining({ id: 'lot-2', quantity: null, unit: null, expiresAt: null }),
      ],
    });
  });

  it('retains a guest edit committed after import comparison but before pantry clear', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'submitted-copy', label: 'Pasta', known: true }],
      stapleIds: [],
    });
    const expectedSnapshot = await readPantrySnapshot();
    if (expectedSnapshot === null) throw new Error('The imported pantry snapshot was not available');
    // @ts-expect-error Vite query IDs provide an isolated module context for the concurrent writer tab.
    const writerTab = await import('./pantryStorage?tab=clear-write-race');
    let releaseClearMutation!: () => void;
    let signalClearMutation!: () => void;
    const clearMutationStarted = new Promise<void>((resolve) => { signalClearMutation = resolve; });
    const clearMutationGate = new Promise<void>((resolve) => { releaseClearMutation = resolve; });
    let pausedClearMutation = false;
    const actualDelete = indexedDb.deleteKeyValue;
    const actualDeleteIfValue = indexedDb.deleteKeyValueIfValue;
    const actualRead = indexedDb.readKeyValue;
    const pauseClearMutation = async (): Promise<void> => {
      if (pausedClearMutation) return;
      pausedClearMutation = true;
      signalClearMutation();
      await clearMutationGate;
    };
    const deleteKey = vi.spyOn(indexedDb, 'deleteKeyValue').mockImplementation(async (key, assertWritable) => {
      if (key === 'pantry') await pauseClearMutation();
      return actualDelete(key, assertWritable);
    });
    const deleteIfValue = vi.spyOn(indexedDb, 'deleteKeyValueIfValue').mockImplementation(async (key, expectedValue, assertWritable) => {
      if (key === 'pantry') await pauseClearMutation();
      return actualDeleteIfValue(key, expectedValue, assertWritable);
    });

    try {
      const clear = clearPantrySnapshot('guest', expectedSnapshot);
      await clearMutationStarted;
      const concurrentWrite = writerTab.writePantrySnapshot({
        pantryItems: [{ id: 'concurrent-copy', label: 'Modifica concorrente', known: true }],
        stapleIds: [],
      });
      await vi.waitFor(async () => {
        expect(await actualRead<string>('pantry')).toContain('concurrent-copy');
      });
      releaseClearMutation();
      await Promise.all([clear, concurrentWrite]);

      expect(await actualRead<string>('pantry')).toContain('concurrent-copy');
      expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toContain('concurrent-copy');
    } finally {
      releaseClearMutation();
      deleteKey.mockRestore();
      deleteIfValue.mockRestore();
    }
  });

  it('clears a scoped pantry snapshot after a successful house import', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      stapleIds: [],
    });

    await clearPantrySnapshot('guest');

    await expect(readPantrySnapshot()).resolves.toBeNull();
    expect(window.localStorage.getItem(PANTRY_STORAGE_KEY)).toBeNull();
  });

  it('allows a fresh write after clearing the last observed pantry snapshot', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'before-clear', label: 'Pasta', known: true }],
      stapleIds: [],
    });

    await clearPantrySnapshot('guest');

    await expect(writePantrySnapshot({
      pantryItems: [{ id: 'after-clear', label: 'Riso', known: true }],
      stapleIds: [],
    })).resolves.toBeUndefined();
    await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'after-clear' }] });
  });

  it('re-seeds an empty IndexedDB after its previously observed database is removed', async () => {
    await writePantrySnapshot({
      pantryItems: [{ id: 'before-reset', label: 'Pasta', known: true }],
      stapleIds: [],
    });

    await indexedDb.deleteLocalDatabase();
    window.localStorage.clear();

    await expect(writePantrySnapshot({
      pantryItems: [{ id: 'after-reset', label: 'Riso', known: true }],
      stapleIds: [],
    })).resolves.toBeUndefined();
    await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'after-reset' }] });
  });

  it('rejects clear when a readable stale mirror cannot be removed', async () => {
    await indexedDb.writeKeyValue('pantry', persistedPantry('tomato'));
    window.localStorage.setItem(PANTRY_STORAGE_KEY, persistedPantry('tomato'));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });

    await expect(clearPantrySnapshot('guest')).rejects.toThrow(/mirror could not be cleared/i);
    await expect(readPantrySnapshot()).resolves.toMatchObject({ pantryItems: [{ id: 'tomato' }] });
  });

  it('rejects a pantry write when IndexedDB and localStorage are both unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });
    vi.spyOn(indexedDb, 'isIndexedDbAvailable').mockReturnValue(false);
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });

    try {
      await expect(writePantrySnapshot({ pantryItems: [{ id: 'tomato', label: 'Pomodoro', known: true }], stapleIds: [] }))
        .rejects.toThrow(/persist/i);
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      setItem.mockRestore();
    }
  });
});
