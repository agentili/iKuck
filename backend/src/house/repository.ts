import { and, asc, eq, sql } from 'drizzle-orm';
import type { HouseMember, HouseRole, HouseState, HouseSummary } from '@ikuck/shared/contracts';
import type { ApplicationDatabase } from '../db/client.js';
import { houseMemberships, houses, processedSyncMutations, syncItems, userProfiles, users } from '../db/schema.js';
import type { HouseRole as ValidatedHouseRole } from './validation.js';

export interface HouseUserRecord {
  id: string;
  email: string;
  displayName: string | null;
  emailVerifiedAt: Date | null;
}

export interface HouseRecord {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HouseMembershipRecord {
  id: string;
  houseId: string;
  userId: string;
  role: ValidatedHouseRole;
  joinedAt: Date;
  updatedAt: Date;
}

export interface HouseRepository {
  createHouse: (input: { name: string; userId: string; now: Date }) => Promise<{ house: HouseRecord; membership: HouseMembershipRecord }>;
  getStateForUser: (userId: string) => Promise<HouseState | null>;
  getMembershipForUser: (userId: string) => Promise<HouseMembershipRecord | null>;
  addExistingMember: (input: { adminUserId: string; email: string; now: Date }) => Promise<
    | { kind: 'added'; member: HouseMember }
    | { kind: 'admin_required' }
    | { kind: 'not_registered' }
    | { kind: 'already_member' }
    | { kind: 'already_in_house' }
  >;
  updateMemberRole: (input: { adminUserId: string; userId: string; role: HouseRole; now: Date }) => Promise<'updated' | 'admin_required' | 'not_found' | 'last_admin_required'>;
  removeMember: (input: { adminUserId: string; userId: string }) => Promise<'removed' | 'admin_required' | 'not_found' | 'last_admin_required'>;
  leaveHouse: (input: { userId: string }) => Promise<'left' | 'not_found' | 'last_admin_required'>;
  countAdmins: (houseId: string) => Promise<number>;
}

export type SeedHouseUser = HouseUserRecord;

const toHouseRecord = (house: typeof houses.$inferSelect): HouseRecord => ({
  id: house.id,
  name: house.name,
  createdByUserId: house.createdByUserId,
  createdAt: house.createdAt,
  updatedAt: house.updatedAt,
});

const toMembershipRecord = (membership: typeof houseMemberships.$inferSelect): HouseMembershipRecord => ({
  id: membership.id,
  houseId: membership.houseId,
  userId: membership.userId,
  role: membership.role as ValidatedHouseRole,
  joinedAt: membership.joinedAt,
  updatedAt: membership.updatedAt,
});

const toHouseSummary = (house: HouseRecord): HouseSummary => ({
  id: house.id,
  name: house.name,
  createdAt: house.createdAt.toISOString(),
});

const toHouseMember = (user: HouseUserRecord, membership: HouseMembershipRecord): HouseMember => ({
  userId: user.id,
  email: user.email,
  displayName: user.displayName,
  role: membership.role,
  joinedAt: membership.joinedAt.toISOString(),
});

const toState = (house: HouseRecord, membership: HouseMembershipRecord, members: HouseMember[]): HouseState => ({
  house: toHouseSummary(house),
  membership: { role: membership.role, joinedAt: membership.joinedAt.toISOString() },
  members,
});

export const createMemoryHouseRepository = (seedUsers: readonly SeedHouseUser[] = []): HouseRepository & {
  seedUser: (user: SeedHouseUser) => void;
} => {
  const usersById = new Map(seedUsers.map((user) => [user.id, user]));
  const usersByEmail = new Map(seedUsers.map((user) => [user.email.toLowerCase(), user]));
  const housesById = new Map<string, HouseRecord>();
  const membershipsByUser = new Map<string, HouseMembershipRecord>();
  const membershipsByHouse = new Map<string, HouseMembershipRecord[]>();

  const seedUser = (user: SeedHouseUser): void => {
    usersById.set(user.id, user);
    usersByEmail.set(user.email.toLowerCase(), user);
  };

  const getMembershipForUser = async (userId: string): Promise<HouseMembershipRecord | null> => membershipsByUser.get(userId) ?? null;
  const listMembers = (houseId: string): HouseMember[] => (membershipsByHouse.get(houseId) ?? [])
    .slice()
    .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime())
    .map((membership) => {
      const user = usersById.get(membership.userId);
      if (user === undefined) throw new Error('Seed user missing for membership');
      return toHouseMember(user, membership);
    });

  return {
    seedUser,
    createHouse: async ({ name, userId, now }) => {
      const id = `house-${housesById.size + 1}`;
      const house: HouseRecord = { id, name, createdByUserId: userId, createdAt: now, updatedAt: now };
      const membership: HouseMembershipRecord = {
        id: `membership-${membershipsByUser.size + 1}`,
        houseId: id,
        userId,
        role: 'admin',
        joinedAt: now,
        updatedAt: now,
      };
      housesById.set(id, house);
      membershipsByUser.set(userId, membership);
      membershipsByHouse.set(id, [membership]);
      return { house, membership };
    },
    getStateForUser: async (userId) => {
      const membership = membershipsByUser.get(userId);
      if (membership === undefined) return null;
      const house = housesById.get(membership.houseId);
      if (house === undefined) return null;
      return toState(house, membership, listMembers(house.id));
    },
    getMembershipForUser,
    addExistingMember: async ({ adminUserId, email, now }) => {
      const adminMembership = membershipsByUser.get(adminUserId);
      if (adminMembership?.role !== 'admin') return { kind: 'admin_required' };
      const target = usersByEmail.get(email.toLowerCase());
      if (target === undefined) return { kind: 'not_registered' };
      const existing = membershipsByUser.get(target.id);
      if (existing !== undefined) {
        return existing.houseId === adminMembership.houseId ? { kind: 'already_member' } : { kind: 'already_in_house' };
      }
      const membership: HouseMembershipRecord = {
        id: `membership-${membershipsByUser.size + 1}`,
        houseId: adminMembership.houseId,
        userId: target.id,
        role: 'member',
        joinedAt: now,
        updatedAt: now,
      };
      membershipsByUser.set(target.id, membership);
      membershipsByHouse.set(membership.houseId, [...(membershipsByHouse.get(membership.houseId) ?? []), membership]);
      return { kind: 'added', member: toHouseMember(target, membership) };
    },
    updateMemberRole: async ({ adminUserId, userId, role, now }) => {
      const adminMembership = membershipsByUser.get(adminUserId);
      const target = membershipsByUser.get(userId);
      if (adminMembership?.role !== 'admin') return 'admin_required';
      if (target === undefined || target.houseId !== adminMembership.houseId) return 'not_found';
      if (target.role === 'admin' && role === 'member'
        && (membershipsByHouse.get(target.houseId) ?? []).filter((membership) => membership.role === 'admin').length <= 1) {
        return 'last_admin_required';
      }
      target.role = role;
      target.updatedAt = now;
      return 'updated';
    },
    removeMember: async ({ adminUserId, userId }) => {
      const adminMembership = membershipsByUser.get(adminUserId);
      const target = membershipsByUser.get(userId);
      if (adminMembership?.role !== 'admin') return 'admin_required';
      if (target === undefined || target.houseId !== adminMembership.houseId) return 'not_found';
      if (target.role === 'admin'
        && (membershipsByHouse.get(target.houseId) ?? []).filter((membership) => membership.role === 'admin').length <= 1) {
        return 'last_admin_required';
      }
      membershipsByUser.delete(userId);
      membershipsByHouse.set(target.houseId, (membershipsByHouse.get(target.houseId) ?? []).filter((item) => item.userId !== userId));
      return 'removed';
    },
    leaveHouse: async ({ userId }) => {
      const membership = membershipsByUser.get(userId);
      if (membership === undefined) return 'not_found';
      const members = membershipsByHouse.get(membership.houseId) ?? [];
      const adminCount = members.filter((item) => item.role === 'admin').length;
      if (membership.role === 'admin' && adminCount <= 1 && members.length > 1) return 'last_admin_required';
      membershipsByUser.delete(userId);
      const remaining = members.filter((item) => item.userId !== userId);
      membershipsByHouse.set(membership.houseId, remaining);
      if (remaining.length === 0) {
        housesById.delete(membership.houseId);
        membershipsByHouse.delete(membership.houseId);
      }
      return 'left';
    },
    countAdmins: async (houseId) => (membershipsByHouse.get(houseId) ?? []).filter((membership) => membership.role === 'admin').length,
  };
};

export const createDrizzleHouseRepository = (database: ApplicationDatabase['db']): HouseRepository => {
  return {
    createHouse: async ({ name, userId, now }) => database.transaction(async (transaction) => {
      const [house] = await transaction.insert(houses).values({ name, createdByUserId: userId, createdAt: now, updatedAt: now }).returning();
      const [membership] = await transaction.insert(houseMemberships).values({
        houseId: house.id,
        userId,
        role: 'admin',
        joinedAt: now,
        updatedAt: now,
      }).returning();
      return { house: toHouseRecord(house), membership: toMembershipRecord(membership) };
    }),
    getStateForUser: async (userId) => {
      const [row] = await database.select({ house: houses, membership: houseMemberships })
        .from(houseMemberships)
        .innerJoin(houses, eq(houses.id, houseMemberships.houseId))
        .where(eq(houseMemberships.userId, userId))
        .limit(1);
      if (row === undefined) return null;
      const members = await database.select({ user: users, profile: userProfiles, membership: houseMemberships })
        .from(houseMemberships)
        .innerJoin(users, eq(users.id, houseMemberships.userId))
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(houseMemberships.houseId, row.house.id))
        .orderBy(asc(houseMemberships.joinedAt));
      return toState(
        toHouseRecord(row.house),
        toMembershipRecord(row.membership),
        members.map((member) => toHouseMember({
          id: member.user.id,
          email: member.user.email,
          displayName: member.profile?.displayName ?? null,
          emailVerifiedAt: member.user.emailVerifiedAt,
        }, toMembershipRecord(member.membership))),
      );
    },
    getMembershipForUser: async (userId) => {
      const [membership] = await database.select().from(houseMemberships).where(eq(houseMemberships.userId, userId)).limit(1);
      return membership === undefined ? null : toMembershipRecord(membership);
    },
    addExistingMember: async ({ adminUserId, email, now }) => database.transaction(async (transaction) => {
      const [adminMembershipRow] = await transaction.select().from(houseMemberships).where(eq(houseMemberships.userId, adminUserId)).limit(1);
      if (adminMembershipRow?.role !== 'admin') return { kind: 'admin_required' as const };
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${adminMembershipRow.houseId} FOR UPDATE`);
      const [target] = await transaction.select({ user: users, profile: userProfiles })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(users.email, email))
        .limit(1);
      if (target === undefined) return { kind: 'not_registered' as const };
      const [existing] = await transaction.select().from(houseMemberships).where(eq(houseMemberships.userId, target.user.id)).limit(1);
      if (existing !== undefined) {
        return existing.houseId === adminMembershipRow.houseId ? { kind: 'already_member' as const } : { kind: 'already_in_house' as const };
      }
      const [membership] = await transaction.insert(houseMemberships).values({
        houseId: adminMembershipRow.houseId,
        userId: target.user.id,
        role: 'member',
        joinedAt: now,
        updatedAt: now,
      }).returning();
      return {
        kind: 'added' as const,
        member: toHouseMember({
          id: target.user.id,
          email: target.user.email,
          displayName: target.profile?.displayName ?? null,
          emailVerifiedAt: target.user.emailVerifiedAt,
        }, toMembershipRecord(membership)),
      };
    }),
    updateMemberRole: async ({ adminUserId, userId, role, now }) => database.transaction(async (transaction) => {
      const [admin] = await transaction.select().from(houseMemberships).where(eq(houseMemberships.userId, adminUserId)).limit(1);
      if (admin?.role !== 'admin') return 'admin_required' as const;
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${admin.houseId} FOR UPDATE`);
      const [target] = await transaction.select().from(houseMemberships).where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, admin.houseId))).limit(1);
      if (target === undefined) return 'not_found' as const;
      if (target.role === 'admin' && role === 'member') {
        const admins = await transaction.select({ id: houseMemberships.id }).from(houseMemberships).where(and(
          eq(houseMemberships.houseId, admin.houseId),
          eq(houseMemberships.role, 'admin'),
        ));
        if (admins.length <= 1) return 'last_admin_required' as const;
      }
      await transaction.update(houseMemberships).set({ role, updatedAt: now }).where(eq(houseMemberships.id, target.id));
      return 'updated' as const;
    }),
    removeMember: async ({ adminUserId, userId }) => database.transaction(async (transaction) => {
      const [admin] = await transaction.select().from(houseMemberships).where(eq(houseMemberships.userId, adminUserId)).limit(1);
      if (admin?.role !== 'admin') return 'admin_required' as const;
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${admin.houseId} FOR UPDATE`);
      const [target] = await transaction.select().from(houseMemberships).where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, admin.houseId))).limit(1);
      if (target === undefined) return 'not_found' as const;
      if (target.role === 'admin') {
        const admins = await transaction.select({ id: houseMemberships.id }).from(houseMemberships).where(and(
          eq(houseMemberships.houseId, admin.houseId),
          eq(houseMemberships.role, 'admin'),
        ));
        if (admins.length <= 1) return 'last_admin_required' as const;
      }
      await transaction.delete(houseMemberships).where(eq(houseMemberships.id, target.id));
      return 'removed' as const;
    }),
    leaveHouse: async ({ userId }) => database.transaction(async (transaction) => {
      const [membership] = await transaction.select().from(houseMemberships).where(eq(houseMemberships.userId, userId)).limit(1);
      if (membership === undefined) return 'not_found' as const;
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR UPDATE`);
      const members = await transaction.select({ id: houseMemberships.id, role: houseMemberships.role })
        .from(houseMemberships)
        .where(eq(houseMemberships.houseId, membership.houseId));
      const adminCount = members.filter((member) => member.role === 'admin').length;
      if (membership.role === 'admin' && adminCount <= 1 && members.length > 1) return 'last_admin_required' as const;
      await transaction.delete(houseMemberships).where(eq(houseMemberships.id, membership.id));
      if (members.length === 1) {
        await transaction.delete(syncItems).where(and(eq(syncItems.scopeType, 'house'), eq(syncItems.scopeId, membership.houseId)));
        await transaction.delete(processedSyncMutations).where(and(
          eq(processedSyncMutations.scopeType, 'house'),
          eq(processedSyncMutations.scopeId, membership.houseId),
        ));
        await transaction.delete(houses).where(eq(houses.id, membership.houseId));
      }
      return 'left' as const;
    }),
    countAdmins: async (houseId) => {
      const rows = await database.select({ role: houseMemberships.role }).from(houseMemberships).where(eq(houseMemberships.houseId, houseId));
      return rows.filter((row) => row.role === 'admin').length;
    },
  };
};
