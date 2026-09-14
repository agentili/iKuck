import { describe, expect, it, vi } from 'vitest';
import type { ApplicationDatabase } from '../db/client.js';
import { accountIdentities, emailVerificationTokens, userProfiles, users } from '../db/schema.js';
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

  it('rolls back a Google user when identity creation fails', async () => {
    const createdUser = {
      id: 'google-user-1',
      email: 'google@example.com',
      passwordHash: null,
      emailVerifiedAt: new Date('2026-09-13T12:00:00.000Z'),
    };
    const identityError = new Error('identity insert failed');
    const insert = vi.fn((table: unknown) => table === accountIdentities
      ? { values: vi.fn(async () => { throw identityError; }) }
      : {
          values: vi.fn(() => ({
            returning: vi.fn(async () => [createdUser]),
          })),
        });
    const transaction = { insert };
    const database = {
      transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as ApplicationDatabase['db'];

    const repository = createDrizzleAuthRepository(database) as unknown as {
      createGoogleUser: (input: {
        email: string;
        providerSubject: string;
        providerEmail: string;
        emailVerifiedAt: Date;
      }) => Promise<unknown>;
    };

    await expect(repository.createGoogleUser({
      email: createdUser.email,
      providerSubject: 'google-subject-1',
      providerEmail: createdUser.email,
      emailVerifiedAt: createdUser.emailVerifiedAt,
    })).rejects.toThrow('identity insert failed');
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(users);
    expect(insert).toHaveBeenCalledWith(accountIdentities);
  });

  it('consumes an email verification token with one conditional update', async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const transaction = { select: vi.fn(), update };
    const database = {
      transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as ApplicationDatabase['db'];
    const repository = createDrizzleAuthRepository(database);

    await expect(repository.consumeVerificationToken('token-hash', new Date('2026-09-13T12:00:00.000Z')))
      .resolves.toBeNull();
    expect(update).toHaveBeenCalledWith(emailVerificationTokens);
    expect(transaction.select).not.toHaveBeenCalled();
  });
});
