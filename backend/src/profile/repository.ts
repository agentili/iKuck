import type { AccountSummary } from '@ikuck/shared/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { AuthServiceError } from '../auth/service.js';
import type { ApplicationDatabase } from '../db/client.js';
import { houseMemberships, houses, processedSyncMutations, syncItems, userProfiles, users } from '../db/schema.js';
import { isSharedEntityType, type SyncRepository } from '../sync/repository.js';

type ExportedSyncData = Awaited<ReturnType<SyncRepository['readAll']>>;

export interface ProfileRecord {
  displayName: string | null;
  updatedAt: Date;
}

export interface AccountExport {
  account: AccountSummary;
  profile: ProfileRecord | null;
  personalData: ExportedSyncData;
  houseData: ExportedSyncData;
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
      personalData: [],
      houseData: [],
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
    const changes = await sync.readAll(userId);
    return {
      account: {
        id: user.id,
        email: user.email,
        emailVerifiedAt: user.emailVerifiedAt.toISOString(),
      },
      profile: await getProfile(userId),
      personalData: changes.filter((change) => change.syncScope === `account:${userId}`),
      houseData: changes.filter((change) => change.syncScope?.startsWith('house:') && isSharedEntityType(change.entityType)),
    };
  };

  const deleteAccount = async (userId: string): Promise<void> => {
    await database.transaction(async (transaction) => {
      // Match the user-then-house lock order of membership creation and shared writes.
      await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`);
      const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
        .from(houseMemberships).where(eq(houseMemberships.userId, userId)).limit(1);
      if (membership !== undefined) {
        await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR UPDATE`);
        const [current] = await transaction.select({ id: houseMemberships.id, role: houseMemberships.role })
          .from(houseMemberships).where(and(
            eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, membership.houseId),
          )).limit(1);
        if (current !== undefined) {
          const members = await transaction.select({ role: houseMemberships.role })
            .from(houseMemberships).where(eq(houseMemberships.houseId, membership.houseId));
          if (current.role === 'admin' && members.length > 1
            && members.filter((member) => member.role === 'admin').length === 1) {
            throw new AuthServiceError('house_last_admin_required', 409, 'The house must keep at least one admin');
          }
          if (members.length === 1) {
            await transaction.delete(syncItems).where(and(eq(syncItems.scopeType, 'house'), eq(syncItems.scopeId, membership.houseId)));
            await transaction.delete(processedSyncMutations).where(and(
              eq(processedSyncMutations.scopeType, 'house'), eq(processedSyncMutations.scopeId, membership.houseId),
            ));
            await transaction.delete(houses).where(eq(houses.id, membership.houseId));
          }
        }
      }
      // Account-scoped rows must not survive as orphaned personal data.
      await transaction.delete(syncItems).where(and(eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, userId)));
      await transaction.delete(processedSyncMutations).where(and(
        eq(processedSyncMutations.scopeType, 'user'), eq(processedSyncMutations.scopeId, userId),
      ));
      await transaction.delete(users).where(eq(users.id, userId));
    });
  };

  return { getProfile, updateProfile, exportAccount, deleteAccount };
};
