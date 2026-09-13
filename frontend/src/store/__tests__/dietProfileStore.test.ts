import { beforeEach, describe, expect, it } from 'vitest';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import { deleteLocalDatabase, readMeta } from '../../storage/indexedDb';
import { readDietProfile } from '../../storage/dietProfileStorage';
import { readQueuedMutations } from '../../sync/syncQueue';
import { hydrateDietProfileStore, useDietProfileStore, waitForPendingDietProfileWrites } from '../dietProfileStore';

const profile: DietProfilePayload = {
  diet: 'vegetarian',
  excludedAllergens: ['fish', 'peanuts'],
  nutrition: { maxCaloriesPerServing: 650, minProteinGramsPerServing: 20 },
};

describe('diet profile store', () => {
  beforeEach(async () => {
    await waitForPendingDietProfileWrites();
    await deleteLocalDatabase();
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

  it('updates the profile immediately and queues one synchronized resource', async () => {
    expect(useDietProfileStore.getState().setDietProfile(profile)).toBe(true);
    expect(useDietProfileStore.getState().profile).toMatchObject(profile);
    await waitForPendingDietProfileWrites();

    expect(await readDietProfile()).toMatchObject(profile);
    expect(await readQueuedMutations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'diet_profile', entityId: 'profile', operation: 'upsert', payload: expect.objectContaining(profile) }),
    ]));
    await expect(readMeta('deviceId')).resolves.toBeTypeOf('string');
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
