import { describe, expect, it } from 'vitest';
import { createRecoveringDatabaseWithFactory } from './client.js';

describe('recovering dedicated database', () => {
  it('replaces a terminated pool and serves later reservations from the replacement', async () => {
    const endedPools: Array<{ id: number; timeout: number }> = [];
    let nextPoolId = 0;
    const database = createRecoveringDatabaseWithFactory(() => {
      const id = ++nextPoolId;
      const client = {
        reserve: async () => ({ poolId: id, release: () => undefined }),
        end: async ({ timeout }: { timeout: number }) => { endedPools.push({ id, timeout }); },
      };
      return { client, db: { poolId: id, dialect: { poolId: id } } };
    });
    const poolClient = database.db.$client as { reserve: () => Promise<unknown>; end: (options: { timeout: number }) => Promise<unknown> };

    await expect(poolClient.reserve()).resolves.toMatchObject({ poolId: 1 });
    await poolClient.end({ timeout: 0 });
    await expect(poolClient.reserve()).resolves.toMatchObject({ poolId: 2 });
    expect(endedPools).toEqual([{ id: 1, timeout: 0 }]);
    expect(database.db.dialect).toEqual({ poolId: 1 });
    expect(database.db.poolId).toBe(2);

    await database.close();
    expect(endedPools).toEqual([{ id: 1, timeout: 0 }, { id: 2, timeout: 5 }]);
  });

  it('retries pool construction on the next request after a replacement factory error', async () => {
    let createAttempts = 0;
    const database = createRecoveringDatabaseWithFactory(() => {
      createAttempts += 1;
      if (createAttempts === 2) throw new Error('temporary pool construction failure');
      return {
        client: {
          reserve: async () => ({ poolId: createAttempts, release: () => undefined }),
          end: async () => undefined,
        },
        db: { dialect: { name: 'postgres' } },
      };
    });
    const poolClient = database.db.$client as { reserve: () => Promise<unknown>; end: (options: { timeout: number }) => Promise<unknown> };

    await expect(poolClient.end({ timeout: 0 })).rejects.toThrow('temporary pool construction failure');
    await expect(poolClient.reserve()).resolves.toMatchObject({ poolId: 3 });
    await database.close();
  });

  it('releases a reservation that resolves after database shutdown and rejects the late caller', async () => {
    let finishReservation!: (connection: { release: () => void }) => void;
    let released = 0;
    const database = createRecoveringDatabaseWithFactory(() => ({
      client: {
        reserve: () => new Promise((resolve) => { finishReservation = resolve; }),
        end: async () => undefined,
      },
      db: { dialect: { name: 'postgres' } },
    }));
    const poolClient = database.db.$client as { reserve: () => Promise<unknown> };
    const pending = poolClient.reserve();
    await database.close();
    finishReservation({ release: () => { released += 1; } });
    await expect(pending).rejects.toThrow('s2s_database_unavailable');
    expect(released).toBe(1);
  });

  it('fails startup immediately when the initial pool factory cannot construct a pool', () => {
    expect(() => createRecoveringDatabaseWithFactory(() => { throw new Error('invalid database configuration'); })).toThrow('invalid database configuration');
  });
});
