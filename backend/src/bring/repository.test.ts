import { describe, expect, it } from 'vitest';
import type { ApplicationDatabase } from '../db/client.js';
import { createDrizzleBringRepository, createMemoryBringRepository } from './repository.js';

const row = {
  connectionId: '10000000-0000-4000-8000-000000000001',
  encryptedSession: 'synthetic-envelope-a',
  connectedAt: '2026-10-06T00:00:00.000Z',
};

const createFakeDatabase = (maxConnections = 10): ApplicationDatabase['db'] => {
  const transaction = {
    execute: async () => [{ acquired: true }],
    select: (...selection: unknown[]) => ({
      from: () => ({
        where: () => ({
          limit: () => selection.length > 0
            ? { for: async () => [{ id: '10000000-0000-4000-8000-000000000001' }] }
            : Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => [] }) }),
    delete: () => ({ where: async () => [] }),
  };
  const database = {
    $client: { options: { max: maxConnections } },
    transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(transaction),
  };
  return database as unknown as ApplicationDatabase['db'];
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('personal Bring repository', () => {
  it('isolates owners, replaces the current revision, and rolls back failed callbacks', async () => {
    const repository = createMemoryBringRepository();
    await repository.withUser('owner-a', async (unit) => { await unit.put(row); });
    expect(await repository.withUser('owner-b', (unit) => unit.get())).toBeNull();

    const nextRevision = { ...row, encryptedSession: 'synthetic-envelope-b', connectedAt: '2026-10-07T00:00:00.000Z' };
    await repository.withUser('owner-a', async (unit) => { await unit.put(nextRevision); });
    expect(await repository.withUser('owner-a', (unit) => unit.get())).toEqual(nextRevision);

    await expect(repository.withUser('owner-a', async (unit) => {
      await unit.remove();
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await repository.withUser('owner-a', (unit) => unit.get())).toEqual(nextRevision);

    await repository.withUser('owner-a', async (unit) => { await unit.remove(); });
    expect(await repository.withUser('owner-a', (unit) => unit.get())).toBeNull();
  });

  it('rejects overlapping owner work and releases the lock after an exception', async () => {
    const repository = createMemoryBringRepository();
    const entered = deferred();
    const continueWork = deferred();
    const first = repository.withUser('owner-a', async () => {
      entered.resolve();
      await continueWork.promise;
    });
    await entered.promise;

    await expect(repository.withUser('owner-a', async () => undefined))
      .rejects.toMatchObject({ code: 'bring_busy', status: 409 });
    continueWork.resolve();
    await first;

    await expect(repository.withUser('owner-a', async () => { throw new Error('rollback'); }))
      .rejects.toThrow('rollback');
    await expect(repository.withUser('owner-a', async () => 'released')).resolves.toBe('released');
  });

  it('limits database work to two active slots and rejects beyond its bounded queue', async () => {
    const repository = createDrizzleBringRepository(createFakeDatabase());
    const started = Array.from({ length: 10 }, () => deferred());
    const work = Array.from({ length: 10 }, () => deferred());
    let enteredCount = 0;
    const jobs = started.map((start, index) => repository.withUser(`owner-${index}`, async () => {
      enteredCount += 1;
      start.resolve();
      await work[index]?.promise;
    }));

    await Promise.all([started[0]?.promise, started[1]?.promise]);
    expect(enteredCount).toBe(2);
    await expect(repository.withUser('overflow-owner', async () => undefined))
      .rejects.toMatchObject({ code: 'bring_busy', status: 503 });

    for (let index = 0; index < jobs.length; index += 1) {
      await started[index]?.promise;
      work[index]?.resolve();
      await jobs[index];
    }
    expect(enteredCount).toBe(10);
  });
});
