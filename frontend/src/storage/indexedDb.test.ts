import {
  deleteLocalDatabase,
  LOCAL_DATABASE_NAME,
  openLocalDatabase,
  readKeyValue,
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
});
