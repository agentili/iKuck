import { describe, expect, it, vi } from 'vitest';
import type { HouseRepository } from '../house/repository.js';
import type { PantryCandidateRepository } from './candidatesRepository.js';
import { createPantryCandidateService } from './candidatesService.js';

describe('pantry candidates service', () => {
  it('resolves the current house, syncs Bring first, then returns that house inbox', async () => {
    const calls: string[] = [];
    const repository = {
      listPending: vi.fn(async (userId: string, houseId: string) => {
        calls.push('list');
        return [{ id: 'candidate-1', houseId, rawLabel: 'Milch', label: 'Latte' }];
      }),
      resolveMany: vi.fn(),
    } as unknown as PantryCandidateRepository;
    const houseRepository = {
      getMembershipForUser: vi.fn(async () => ({ houseId: 'house-a' })),
    } as unknown as HouseRepository;
    const bringService = {
      syncCandidates: vi.fn(async () => {
        calls.push('sync');
        return { connected: true, baseline: false, created: 1 };
      }),
    };
    const service = createPantryCandidateService({ repository, houseRepository, bringService });

    await expect(service.list('user-a')).resolves.toMatchObject({
      candidates: [{ id: 'candidate-1', houseId: 'house-a' }],
    });
    expect(calls).toEqual(['sync', 'list']);
    expect(bringService.syncCandidates).toHaveBeenCalledWith('user-a', 'house-a');
    expect(repository.listPending).toHaveBeenCalledWith('user-a', 'house-a', expect.any(String));
  });

  it('refuses candidate access when the account has no house membership', async () => {
    const repository = { listPending: vi.fn(), resolveMany: vi.fn() } as unknown as PantryCandidateRepository;
    const houseRepository = { getMembershipForUser: vi.fn(async () => null) } as unknown as HouseRepository;
    const bringService = { syncCandidates: vi.fn() };
    const service = createPantryCandidateService({ repository, houseRepository, bringService });

    await expect(service.list('user-a')).rejects.toMatchObject({ code: 'house_membership_required', status: 403 });
    expect(bringService.syncCandidates).not.toHaveBeenCalled();
    expect(repository.listPending).not.toHaveBeenCalled();
  });

  it('applies batch actions only in the authenticated member current house', async () => {
    const repository = {
      listPending: vi.fn(),
      resolveMany: vi.fn(async (_userId: string, _houseId: string, ids: readonly string[]) => ids.map((id) => ({ id, ok: true, code: 'ignored' }))),
    } as unknown as PantryCandidateRepository;
    const houseRepository = { getMembershipForUser: vi.fn(async () => ({ houseId: 'house-b' })) } as unknown as HouseRepository;
    const service = createPantryCandidateService({ repository, houseRepository });

    await expect(service.ignore('user-b', ['candidate-a', 'candidate-b'])).resolves.toMatchObject({
      results: [{ id: 'candidate-a', ok: true }, { id: 'candidate-b', ok: true }],
    });
    expect(repository.resolveMany).toHaveBeenCalledWith('user-b', 'house-b', ['candidate-a', 'candidate-b'], 'ignore', expect.any(String));
  });
});
