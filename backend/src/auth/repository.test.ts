import { describe, expect, it, vi } from 'vitest';
import type { ApplicationDatabase } from '../db/client.js';
import { userProfiles, users } from '../db/schema.js';
import { createDrizzleAuthRepository } from './repository.js';

describe('Drizzle auth repository', () => {
  it('rolls back user creation when the profile insert fails', async () => {
    const createdUser = {
      id: 'user-1',
      email: 'atomic@example.com',
      passwordHash: 'password-hash',
      emailVerifiedAt: null,
    };
    const profileError = new Error('profile insert failed');
    const insert = vi.fn((table: unknown) => table === userProfiles
      ? { values: vi.fn(async () => { throw profileError; }) }
      : {
          values: vi.fn(() => ({
            returning: vi.fn(async () => [createdUser]),
          })),
        });
    const transaction = { insert };
    const database = {
      insert,
      transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as ApplicationDatabase['db'];

    const repository = createDrizzleAuthRepository(database);

    await expect(repository.createUser({
      email: createdUser.email,
      passwordHash: createdUser.passwordHash,
    })).rejects.toThrow('profile insert failed');
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(users);
    expect(insert).toHaveBeenCalledWith(userProfiles);
  });
});
