import { AuthServiceError } from '../auth/service.js';
import type { HouseRepository } from '../house/repository.js';
import type { BringService } from '../bring/service.js';
import type { PantryCandidateRepository } from './candidatesRepository.js';

export interface PantryCandidateServiceDependencies {
  repository: PantryCandidateRepository;
  houseRepository: HouseRepository;
  bringService?: Pick<BringService, 'syncCandidates'>;
  clock?: () => Date;
}

export const createPantryCandidateService = ({ repository, houseRepository, bringService, clock = () => new Date() }: PantryCandidateServiceDependencies) => {
  const houseForUser = async (userId: string): Promise<string> => {
    const membership = await houseRepository.getMembershipForUser(userId);
    if (membership === null) throw new AuthServiceError('house_membership_required', 403, 'House membership required');
    return membership.houseId;
  };

  const now = (): string => clock().toISOString();

  return {
    list: async (userId: string) => {
      const houseId = await houseForUser(userId);
      await bringService?.syncCandidates(userId, houseId);
      return { candidates: await repository.listPending(userId, houseId, now()) };
    },
    accept: async (userId: string, ids: readonly string[]) => {
      const houseId = await houseForUser(userId);
      return { results: await repository.resolveMany(userId, houseId, ids, 'accept', now()) };
    },
    ignore: async (userId: string, ids: readonly string[]) => {
      const houseId = await houseForUser(userId);
      return { results: await repository.resolveMany(userId, houseId, ids, 'ignore', now()) };
    },
  };
};

export type PantryCandidateService = ReturnType<typeof createPantryCandidateService>;
