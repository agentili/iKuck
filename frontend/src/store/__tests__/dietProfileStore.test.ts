import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import { deleteLocalDatabase, readMeta } from '../../storage/indexedDb';
import * as dietProfileStorage from '../../storage/dietProfileStorage';
import { readDietProfile, writeDietProfile } from '../../storage/dietProfileStorage';
import { GUEST_SYNC_SCOPE, readQueuedMutations } from '../../sync/syncQueue';
import { setActiveDataScope, setPersonalDataScope } from '../../sync/scopeContext';
import { waitForScopedWrites } from '../../sync/scopeWriteFence';
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
    setActiveDataScope(GUEST_SYNC_SCOPE);
    setPersonalDataScope(GUEST_SYNC_SCOPE);
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

  it('hydrates the current house diet instead of the member’s obsolete account profile', async () => {
    const accountScope = 'account:diet-user' as const;
    const houseScope = 'house:diet-home' as const;
    await writeDietProfile({ ...profile, diet: 'vegetarian', updatedAt: '2026-09-20T10:00:00.000Z' }, accountScope);
    await writeDietProfile({ ...profile, diet: 'vegan', excludedAllergens: ['fish', 'peanuts', 'milk'], updatedAt: '2026-09-21T10:00:00.000Z' }, houseScope);
    setPersonalDataScope(accountScope);
    setActiveDataScope(houseScope);

    await hydrateDietProfileStore();

    expect(useDietProfileStore.getState()).toMatchObject({
      hasHydrated: true,
      profile: { diet: 'vegan', excludedAllergens: expect.arrayContaining(['fish', 'peanuts', 'milk']) },
    });
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([]);
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
    setActiveDataScope(accountB);
    setPersonalDataScope(accountB);
    const secondHydration = hydrateDietProfileStore();
    releaseOld?.();
    await Promise.all([firstHydration, secondHydration]);

    expect(useDietProfileStore.getState()).toMatchObject({ hasHydrated: true, profile: { diet: 'vegan' } });
    readSpy.mockRestore();
    setActiveDataScope('guest');
  });

  it('tracks a queued diet-profile persistence callback before its storage write starts', async () => {
    const scope = 'account:diet-pending' as const;
    setActiveDataScope(scope);
    const originalWrite = dietProfileStorage.writeDietProfile;
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(dietProfileStorage, 'writeDietProfile').mockImplementation(async (...args) => {
      await paused;
      return originalWrite(...args);
    });
    try {
      expect(useDietProfileStore.getState().setDietProfile(profile)).toBe(true);
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      let drained = false;
      const drain = waitForScopedWrites(scope).then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release?.();
      await drain;
      await expect(readDietProfile(scope)).resolves.toMatchObject({ diet: 'vegetarian' });
    } finally { release?.(); await waitForPendingDietProfileWrites(); spy.mockRestore(); }
  });

  it('stores and queues the diet/allergen profile in the active house', async () => {
    const accountScope = 'account:diet-user' as const;
    const houseScope = 'house:diet-home' as const;
    setPersonalDataScope(accountScope);
    setActiveDataScope(houseScope);

    expect(useDietProfileStore.getState().setDietProfile(profile)).toBe(true);
    await waitForPendingDietProfileWrites();

    await expect(readDietProfile(houseScope)).resolves.toMatchObject(profile);
    await expect(readDietProfile(accountScope)).resolves.toMatchObject({ diet: 'omnivore', excludedAllergens: [] });
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([
      expect.objectContaining({ entityType: 'diet_profile', entityId: 'profile', operation: 'upsert' }),
    ]);
    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
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
