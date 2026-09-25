import { describe, expect, it, vi } from 'vitest';
import { AuthServiceError } from '../auth/service.js';
import type { SyncRepository } from '../sync/repository.js';
import { createHouseService } from './service.js';
import { createMemoryHouseRepository } from './repository.js';

describe('house service', () => {
  it('creates a house with the creator as admin and adds a registered member directly', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const service = createHouseService({ repository, clock: () => new Date('2026-09-24T12:00:00.000Z') });

    const created = await service.createHouse('admin-1', 'Casa');
    const member = await service.addMember('admin-1', ' MEMBER@EXAMPLE.COM ');

    expect(created.membership.role).toBe('admin');
    expect(member.role).toBe('member');
    expect(member.email).toBe('member@example.com');
  });

  it('automatically merges the creator and each new member pantry into the house', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const mergeUserPantryToHouse = vi.fn<SyncRepository['mergeUserPantryToHouse']>().mockResolvedValue({
      addedLots: 0,
      mergedLots: 0,
      mergedGroups: 0,
      importedStaples: 0,
    });
    const syncRepository = { mergeUserPantryToHouse } as unknown as SyncRepository;
    const service = createHouseService({ repository, syncRepository });

    await service.createHouse('admin-1', 'Casa');
    await service.addMember('admin-1', 'member@example.com');

    expect(mergeUserPantryToHouse).toHaveBeenNthCalledWith(1, 'admin-1', 'house-1');
    expect(mergeUserPantryToHouse).toHaveBeenNthCalledWith(2, 'member-1', 'house-1');
  });

  it('keeps a created membership retryable when the first pantry merge fails', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const mergeUserPantryToHouse = vi.fn<SyncRepository['mergeUserPantryToHouse']>()
      .mockRejectedValueOnce(new Error('temporary merge failure'))
      .mockResolvedValueOnce({ addedLots: 0, mergedLots: 0, mergedGroups: 0, importedStaples: 0 });
    const service = createHouseService({ repository, syncRepository: { mergeUserPantryToHouse } as unknown as SyncRepository });

    await expect(service.createHouse('admin-1', 'Casa')).rejects.toThrow('temporary merge failure');
    await expect(repository.getMembershipForUser('admin-1')).resolves.toMatchObject({ houseId: 'house-1' });
    await expect(service.getState('admin-1')).resolves.toMatchObject({ house: { id: 'house-1' } });
    expect(mergeUserPantryToHouse).toHaveBeenCalledTimes(2);
  });

  it('retries a member pantry merge on the member state read after an add failure', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const mergeUserPantryToHouse = vi.fn<SyncRepository['mergeUserPantryToHouse']>()
      .mockResolvedValueOnce({ addedLots: 0, mergedLots: 0, mergedGroups: 0, importedStaples: 0 })
      .mockRejectedValueOnce(new Error('temporary member merge failure'))
      .mockResolvedValueOnce({ addedLots: 0, mergedLots: 0, mergedGroups: 0, importedStaples: 0 });
    const service = createHouseService({ repository, syncRepository: { mergeUserPantryToHouse } as unknown as SyncRepository });

    await service.createHouse('admin-1', 'Casa');
    await expect(service.addMember('admin-1', 'member@example.com')).rejects.toThrow('temporary member merge failure');
    await expect(repository.getMembershipForUser('member-1')).resolves.toMatchObject({ houseId: 'house-1' });
    await expect(service.getState('member-1')).resolves.toMatchObject({ house: { id: 'house-1' } });
    expect(mergeUserPantryToHouse).toHaveBeenCalledTimes(3);
  });
  it('automatically merges guest pantry data into the member house', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const mergeGuestPantryToHouse = vi.fn<SyncRepository['mergeGuestPantryToHouse']>().mockResolvedValue({
      addedLots: 1,
      mergedLots: 0,
      mergedGroups: 0,
      importedStaples: 1,
    });
    const syncRepository = { mergeGuestPantryToHouse } as unknown as SyncRepository;
    const service = createHouseService({ repository, syncRepository });
    await service.createHouse('admin-1', 'Casa');

    await service.mergeGuestPantry('admin-1', {
      deviceId: 'device-1',
      lots: [],
      stapleIds: ['salt'],
    });

    expect(mergeGuestPantryToHouse).toHaveBeenCalledWith('admin-1', 'house-1', {
      deviceId: 'device-1',
      lots: [],
      stapleIds: ['salt'],
    });
  });

  it('returns a typed error without changing membership when the email is not registered', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const service = createHouseService({ repository });
    await service.createHouse('admin-1', 'Casa');

    await expect(service.addMember('admin-1', 'missing@example.com')).rejects.toMatchObject({
      code: 'house_email_not_registered',
      status: 404,
    });
    await expect(service.getState('admin-1')).resolves.toMatchObject({ members: [expect.objectContaining({ userId: 'admin-1' })] });
  });

  it('distinguishes duplicate membership and membership in another house', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
      { id: 'admin-2', email: 'second@example.com', displayName: 'Second', emailVerifiedAt: new Date() },
    ]);
    const service = createHouseService({ repository });
    await service.createHouse('admin-1', 'Casa A');
    await service.addMember('admin-1', 'member@example.com');
    await service.createHouse('admin-2', 'Casa B');

    await expect(service.addMember('admin-1', 'member@example.com')).rejects.toMatchObject({ code: 'house_user_already_member' });
    await expect(service.addMember('admin-1', 'second@example.com')).rejects.toMatchObject({ code: 'house_user_already_in_house' });
  });

  it('prevents removing or demoting the last admin', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const service = createHouseService({ repository });
    await service.createHouse('admin-1', 'Casa');

    await expect(service.changeRole('admin-1', 'admin-1', 'member')).rejects.toMatchObject({ code: 'house_last_admin_required' });
    await expect(service.removeMember('admin-1', 'admin-1')).rejects.toMatchObject({ code: 'house_last_admin_required' });
  });

  it('allows a member to leave and blocks the last admin while other members remain', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const service = createHouseService({ repository });
    await service.createHouse('admin-1', 'Casa');
    await service.addMember('admin-1', 'member@example.com');

    await expect(service.leaveHouse('admin-1')).rejects.toMatchObject({ code: 'house_last_admin_required' });
    await service.leaveHouse('member-1');
    await expect(service.getState('member-1')).resolves.toBeNull();
    await expect(service.leaveHouse('admin-1')).resolves.toBeUndefined();
  });

  it('deletes an empty house when its only admin leaves', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const service = createHouseService({ repository });
    await service.createHouse('admin-1', 'Casa');

    await service.leaveHouse('admin-1');

    await expect(service.getState('admin-1')).resolves.toBeNull();
  });

  it('imports only the current member personal shared data after explicit invocation', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
    ]);
    const migrateUserSharedDataToHouse = vi.fn<SyncRepository['migrateUserSharedDataToHouse']>().mockResolvedValue(undefined);
    const syncRepository = { migrateUserSharedDataToHouse } as unknown as SyncRepository;
    const service = createHouseService({ repository, syncRepository });
    await service.createHouse('admin-1', 'Casa');

    await service.importPersonalData('admin-1');

    expect(migrateUserSharedDataToHouse).toHaveBeenCalledWith('admin-1', 'house-1');
  });

  it('requires an admin for direct additions', async () => {
    const repository = createMemoryHouseRepository([
      { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin', emailVerifiedAt: new Date() },
      { id: 'member-1', email: 'member@example.com', displayName: 'Member', emailVerifiedAt: new Date() },
    ]);
    const service = createHouseService({ repository });
    await service.createHouse('admin-1', 'Casa');
    await service.addMember('admin-1', 'member@example.com');

    await expect(service.addMember('member-1', 'admin@example.com')).rejects.toBeInstanceOf(AuthServiceError);
    await expect(service.addMember('member-1', 'admin@example.com')).rejects.toMatchObject({ code: 'house_admin_required' });
  });
});
