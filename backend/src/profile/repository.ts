import type { AccountSummary } from '@ikuck/shared/contracts';
import { eq } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/client.js';
import { userProfiles, users } from '../db/schema.js';
import type { SyncRepository } from '../sync/repository.js';

export interface ProfileRecord {
  displayName: string | null;
  updatedAt: Date;
}

export interface AccountExport {
  account: AccountSummary;
  profile: ProfileRecord | null;
  sync: Awaited<ReturnType<SyncRepository['readAll']>>;
}

export interface ProfileRepository {
  getProfile: (userId: string) => Promise<ProfileRecord | null>;
  updateProfile: (userId: string, displayName: string | null) => Promise<ProfileRecord>;
  exportAccount: (userId: string) => Promise<AccountExport>;
  deleteAccount: (userId: string) => Promise<void>;
}

export const createMemoryProfileRepository = (): ProfileRepository => {
  const profiles = new Map<string, ProfileRecord>();
  return {
    getProfile: async (userId) => profiles.get(userId) ?? null,
    updateProfile: async (userId, displayName) => {
      const profile = { displayName, updatedAt: new Date() };
      profiles.set(userId, profile);
      return profile;
    },
    exportAccount: async (userId) => ({
      account: { id: userId, email: 'user@example.com', emailVerifiedAt: new Date().toISOString() },
      profile: profiles.get(userId) ?? null,
      sync: [],
    }),
    deleteAccount: async (userId) => {
      profiles.delete(userId);
    },
  };
};

export const createDrizzleProfileRepository = (
  database: ApplicationDatabase['db'],
  sync: SyncRepository,
): ProfileRepository => {
  const getProfile = async (userId: string): Promise<ProfileRecord | null> => {
    const [profile] = await database.select({
      displayName: userProfiles.displayName,
      updatedAt: userProfiles.updatedAt,
    }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    return profile ?? null;
  };

  const updateProfile = async (userId: string, displayName: string | null): Promise<ProfileRecord> => {
    const now = new Date();
    await database.insert(userProfiles).values({ userId, displayName, updatedAt: now })
      .onConflictDoUpdate({ target: userProfiles.userId, set: { displayName, updatedAt: now } });
    const profile = await database.select({
      displayName: userProfiles.displayName,
      updatedAt: userProfiles.updatedAt,
    }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    return profile[0];
  };

  const exportAccount = async (userId: string): Promise<AccountExport> => {
    const [user] = await database.select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
    }).from(users).where(eq(users.id, userId)).limit(1);
    if (user === undefined || user.emailVerifiedAt === null) throw new Error('Account not found');
    return {
      account: {
        id: user.id,
        email: user.email,
        emailVerifiedAt: user.emailVerifiedAt.toISOString(),
      },
      profile: await getProfile(userId),
      sync: await sync.readAll(userId),
    };
  };

  const deleteAccount = async (userId: string): Promise<void> => {
    await database.delete(users).where(eq(users.id, userId));
  };

  return { getProfile, updateProfile, exportAccount, deleteAccount };
};
