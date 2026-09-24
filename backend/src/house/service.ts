import type { HouseMember, HouseRole, HouseState } from '@ikuck/shared/contracts';
import { AuthServiceError } from '../auth/service.js';
import type { SyncRepository } from '../sync/repository.js';
import type { HouseRepository } from './repository.js';
import { houseNameSchema, houseRoleSchema, memberEmailSchema } from './validation.js';

export interface HouseService {
  createHouse: (userId: string, rawName: string) => Promise<{ state: HouseState; membership: { role: HouseRole; joinedAt: string } }>;
  getState: (userId: string) => Promise<HouseState | null>;
  addMember: (adminUserId: string, rawEmail: string) => Promise<HouseMember>;
  changeRole: (adminUserId: string, userId: string, role: HouseRole) => Promise<void>;
  removeMember: (adminUserId: string, userId: string) => Promise<void>;
  leaveHouse: (userId: string) => Promise<void>;
  importPersonalData: (userId: string) => Promise<void>;
}

interface HouseServiceOptions {
  repository: HouseRepository;
  syncRepository?: SyncRepository;
  clock?: () => Date;
}

const invalidPayload = (message: string): AuthServiceError => new AuthServiceError('invalid_payload', 400, message);

const requireState = async (repository: HouseRepository, userId: string): Promise<HouseState> => {
  const state = await repository.getStateForUser(userId);
  if (state === null) throw new AuthServiceError('house_membership_required', 403, 'House membership is required');
  return state;
};

const mapAddMemberResult = (result: Awaited<ReturnType<HouseRepository['addExistingMember']>>): HouseMember => {
  if (result.kind === 'added') return result.member;
  if (result.kind === 'admin_required') throw new AuthServiceError('house_admin_required', 403, 'House admin permission is required');
  if (result.kind === 'not_registered') throw new AuthServiceError('house_email_not_registered', 404, 'The email is not registered in iKuck');
  if (result.kind === 'already_member') throw new AuthServiceError('house_user_already_member', 409, 'The account is already a member of this house');
  throw new AuthServiceError('house_user_already_in_house', 409, 'The account already belongs to another house');
};

export const createHouseService = ({ repository, syncRepository, clock = () => new Date() }: HouseServiceOptions): HouseService => ({
  createHouse: async (userId, rawName) => {
    const nameResult = houseNameSchema.safeParse(rawName);
    if (!nameResult.success) throw invalidPayload('House name is invalid');
    if (await repository.getMembershipForUser(userId) !== null) {
      throw new AuthServiceError('house_membership_exists', 409, 'The account already belongs to a house');
    }
    const created = await repository.createHouse({ name: nameResult.data, userId, now: clock() });
    const state = await repository.getStateForUser(userId);
    if (state === null) throw new AuthServiceError('house_not_found', 500, 'Created house could not be loaded');
    return { state, membership: { role: created.membership.role, joinedAt: created.membership.joinedAt.toISOString() } };
  },

  getState: (userId) => repository.getStateForUser(userId),

  addMember: async (adminUserId, rawEmail) => {
    const emailResult = memberEmailSchema.safeParse(rawEmail);
    if (!emailResult.success) throw invalidPayload('Member email is invalid');
    await requireState(repository, adminUserId);
    return mapAddMemberResult(await repository.addExistingMember({ adminUserId, email: emailResult.data, now: clock() }));
  },

  changeRole: async (adminUserId, userId, rawRole) => {
    const roleResult = houseRoleSchema.safeParse(rawRole);
    if (!roleResult.success) throw invalidPayload('House role is invalid');
    const state = await requireState(repository, adminUserId);
    const target = state.members.find((member) => member.userId === userId);
    if (target === undefined) throw new AuthServiceError('house_membership_required', 404, 'House member was not found');
    if (target.role === 'admin' && roleResult.data === 'member' && state.members.filter((member) => member.role === 'admin').length <= 1) {
      throw new AuthServiceError('house_last_admin_required', 409, 'The house must keep at least one admin');
    }
    const result = await repository.updateMemberRole({ adminUserId, userId, role: roleResult.data, now: clock() });
    if (result === 'admin_required') throw new AuthServiceError('house_admin_required', 403, 'House admin permission is required');
    if (result === 'last_admin_required') throw new AuthServiceError('house_last_admin_required', 409, 'The house must keep at least one admin');
    if (result === 'not_found') throw new AuthServiceError('house_membership_required', 404, 'House member was not found');
  },

  removeMember: async (adminUserId, userId) => {
    const state = await requireState(repository, adminUserId);
    const target = state.members.find((member) => member.userId === userId);
    if (target === undefined) throw new AuthServiceError('house_membership_required', 404, 'House member was not found');
    if (target.role === 'admin' && state.members.filter((member) => member.role === 'admin').length <= 1) {
      throw new AuthServiceError('house_last_admin_required', 409, 'The house must keep at least one admin');
    }
    const result = await repository.removeMember({ adminUserId, userId });
    if (result === 'admin_required') throw new AuthServiceError('house_admin_required', 403, 'House admin permission is required');
    if (result === 'last_admin_required') throw new AuthServiceError('house_last_admin_required', 409, 'The house must keep at least one admin');
    if (result === 'not_found') throw new AuthServiceError('house_membership_required', 404, 'House member was not found');
  },

  leaveHouse: async (userId) => {
    const result = await repository.leaveHouse({ userId });
    if (result === 'last_admin_required') {
      throw new AuthServiceError('house_last_admin_required', 409, 'The house must keep at least one admin');
    }
    if (result === 'not_found') {
      throw new AuthServiceError('house_membership_required', 404, 'House membership was not found');
    }
  },

  importPersonalData: async (userId) => {
    if (syncRepository === undefined) {
      throw new AuthServiceError('house_not_found', 500, 'House data import is unavailable');
    }
    const state = await requireState(repository, userId);
    if (state.house === null) throw new AuthServiceError('house_not_found', 404, 'House not found');
    await syncRepository.migrateUserSharedDataToHouse(userId, state.house.id);
  },
});
