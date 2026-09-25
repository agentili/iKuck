import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import { deleteLocalDatabase, readMeta } from '../../storage/indexedDb';
import * as dietProfileStorage from '../../storage/dietProfileStorage';
import { readDietProfile } from '../../storage/dietProfileStorage';
import { GUEST_SYNC_SCOPE, readQueuedMutations } from '../../sync/syncQueue';
import { setActiveDataScope, setPersonalDataScope } from '../../sync/scopeContext';
import { hydrateDietProfileStore, useDietProfileStore, waitForPendingDietProfileWrites } from '../dietProfileStore';
import { usePersistenceStatusStore } from '../persistenceStatusStore';

const profile: DietProfilePayload = {
  diet: 'vegetarian',
  excludedAllergens: ['fish', 'peanuts'],
  nutrition: { maxCaloriesPerServing: 650, minProteinGramsPerServing: 20 },
};

describe('diet profile store', () => {
  beforeEach(async () => {
    await waitForPendingDietProfileWrites();
    await deleteLocalDatabase();
    usePersistenceStatusStore.getState().reset();
    useDietProfileStore.setState({
      hasHydrated: false,
      profile: {
        diet: 'omnivore',
        excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
        updatedAt: '2026-09-13T10:00:00.000Z',
      },
    });
  });

  it('hydrates the safe default for a guest', async () => {
    await hydrateDietProfileStore();

    expect(useDietProfileStore.getState()).toMatchObject({ hasHydrated: true, profile: { diet: 'omnivore', excludedAllergens: [] } });
  });

  it('retries the profile hydration after the account changes in flight', async () => {
    const accountA = 'account:diet-a' as const;
    const accountB = 'account:diet-b' as const;
    let releaseOld: (() => void) | undefined;
    const oldRequest = new Promise<void>((resolve) => { releaseOld = resolve; });
    const readSpy = vi.spyOn(dietProfileStorage, 'readDietProfile').mockImplementation(async (scope) => {
      if (scope === accountA) await oldRequest;
      return {
        ...profile,
        diet: scope === accountA ? 'vegetarian' : 'vegan',
        updatedAt: '2026-09-24T10:00:00.000Z',
      };
    });

    setActiveDataScope(accountA);
    const firstHydration = hydrateDietProfileStore();
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledWith(accountA));
    setPersonalDataScope(accountB);
    const secondHydration = hydrateDietProfileStore();
    releaseOld?.();
    await Promise.all([firstHydration, secondHydration]);

    expect(useDietProfileStore.getState()).toMatchObject({ hasHydrated: true, profile: { diet: 'vegan' } });
    readSpy.mockRestore();
    setActiveDataScope('guest');
  });

  it('updates the profile immediately and queues one synchronized resource', async () => {
    expect(useDietProfileStore.getState().setDietProfile(profile)).toBe(true);
    expect(useDietProfileStore.getState().profile).toMatchObject(profile);
    await waitForPendingDietProfileWrites();

    expect(await readDietProfile()).toMatchObject(profile);
    expect(await readQueuedMutations(GUEST_SYNC_SCOPE)).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'diet_profile', entityId: 'profile', operation: 'upsert', payload: expect.objectContaining(profile) }),
    ]));
    await expect(readMeta('deviceId')).resolves.toBeTypeOf('string');
  });

  it('surfaces a diet persistence failure while keeping the local profile available', async () => {
    vi.spyOn(dietProfileStorage, 'writeDietProfile').mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    expect(useDietProfileStore.getState().setDietProfile(profile)).toBe(true);

    await vi.waitFor(() => expect(usePersistenceStatusStore.getState().statuses.diet.state).toBe('memory-only'));
    expect(useDietProfileStore.getState().profile).toMatchObject(profile);
  });

  it('rejects invalid thresholds and resets explicitly', () => {
    expect(useDietProfileStore.getState().setDietProfile({
      ...profile,
      nutrition: { maxCaloriesPerServing: -1, minProteinGramsPerServing: 10 },
    })).toBe(false);
    expect(useDietProfileStore.getState().profile.diet).toBe('omnivore');

    useDietProfileStore.getState().resetDietProfile();
    expect(useDietProfileStore.getState().profile).toMatchObject({ diet: 'omnivore', excludedAllergens: [] });
  });
});
