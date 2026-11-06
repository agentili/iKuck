import {
  deleteLocalDatabase,
  LOCAL_DATABASE_NAME,
  openLocalDatabase,
  readKeyValue,
  readQueueValues,
  writeKeyValue,
} from './indexedDb';

describe('IndexedDB adapter', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
  });

  it('creates the local stores and round-trips JSON values', async () => {
    await writeKeyValue('pantry', { pantryItems: [{ id: 'pasta' }], stapleIds: ['salt'] });

    await expect(readKeyValue('pantry')).resolves.toEqual({
      pantryItems: [{ id: 'pasta' }],
      stapleIds: ['salt'],
    });

    const database = await openLocalDatabase();
    expect(database.name).toBe(LOCAL_DATABASE_NAME);
    expect([...database.objectStoreNames]).toEqual(
      expect.arrayContaining(['keyValue', 'syncQueue', 'syncMeta']),
    );
    database.close();
  });

  it('keeps values isolated by key', async () => {
    await writeKeyValue('pantry', { version: 1 });
    await writeKeyValue('profile', { displayName: 'Ale' });

    await expect(readKeyValue('pantry')).resolves.toEqual({ version: 1 });
    await expect(readKeyValue('profile')).resolves.toEqual({ displayName: 'Ale' });
  });

  it('migrates legacy queue records into the guest scope', async () => {
    const request = indexedDB.open(LOCAL_DATABASE_NAME, 1);
    const legacyDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('keyValue');
        const queue = database.createObjectStore('syncQueue', { keyPath: 'mutationId' });
        queue.createIndex('byCreatedAt', 'createdAt');
        database.createObjectStore('syncMeta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise<void>((resolve, reject) => {
      const transaction = legacyDatabase.transaction('syncQueue', 'readwrite');
      transaction.objectStore('syncQueue').put({
        mutationId: 'legacy-mutation',
        deviceId: 'device-1',
        entityType: 'pantry_item',
        entityId: 'pasta',
        operation: 'upsert',
        payload: { id: 'pasta', label: 'Pasta', known: true },
        clientUpdatedAt: '2026-09-12T12:00:00.000Z',
        createdAt: '2026-09-12T12:00:00.000Z',
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    legacyDatabase.close();

    await expect(readQueueValues<{ mutationId: string; scope: string }>('guest')).resolves.toEqual([
      expect.objectContaining({ mutationId: 'legacy-mutation', scope: 'guest' }),
    ]);
    await expect(readQueueValues('account:user-1')).resolves.toEqual([]);
  });

  it('assigns deterministic local order when upgrading older queued meal-plan commands', async () => {
    const request = indexedDB.open(LOCAL_DATABASE_NAME, 3);
    const legacyDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('keyValue');
        const queue = database.createObjectStore('syncQueue', { keyPath: 'mutationId' });
        queue.createIndex('byCreatedAt', 'createdAt');
        queue.createIndex('byScope', 'scope');
        database.createObjectStore('syncMeta');
        const consumption = database.createObjectStore('dinnerConsumption', { keyPath: 'operationId' });
        consumption.createIndex('byScope', 'scope');
        consumption.createIndex('byScopeEntryId', 'scopeEntryId', { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const legacyCommand = (mutationId: string, recipeId: string) => ({
      version: 2,
      scope: 'house:house-1',
      date: '2026-10-29',
      operationId: mutationId,
      deviceId: 'device-1',
      clientUpdatedAt: '2026-10-29T10:00:00.000Z',
      action: 'manual_set',
      recipeId,
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = legacyDatabase.transaction('syncQueue', 'readwrite');
      const queue = transaction.objectStore('syncQueue');
      queue.put({
        mutationId: 'z-created-first', entityType: 'meal_plan_entry', scope: 'house:house-1',
        command: legacyCommand('z-created-first', 'first-recipe'), createdAt: '2026-10-29T10:00:00.000Z',
      });
      queue.put({
        mutationId: 'a-created-second', entityType: 'meal_plan_entry', scope: 'house:house-1',
        command: legacyCommand('a-created-second', 'second-recipe'), createdAt: '2026-10-29T10:00:00.000Z',
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    legacyDatabase.close();

    const upgraded = await readQueueValues<Record<string, unknown>>('house:house-1');

    expect(upgraded.filter((record) => record.entityType === 'meal_plan_entry'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ mutationId: 'a-created-second', localOrder: 1 }),
        expect.objectContaining({ mutationId: 'z-created-first', localOrder: 2 }),
      ]));
  });
});
