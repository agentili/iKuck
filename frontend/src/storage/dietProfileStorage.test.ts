import { beforeEach, describe, expect, it } from 'vitest';
import type { DietProfile } from '@ikuck/shared/contracts';
import { deleteLocalDatabase, writeKeyValue } from './indexedDb';
import { readDietProfile, writeDietProfile } from './dietProfileStorage';

const profile: DietProfile = {
  diet: 'vegan',
  excludedAllergens: ['fish', 'gluten', 'milk'],
  nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 18 },
  updatedAt: '2026-09-13T12:00:00.000Z',
};

describe('diet profile storage', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
  });

  it('returns the safe default when no profile exists', async () => {
    await expect(readDietProfile()).resolves.toMatchObject({
      diet: 'omnivore',
      excludedAllergens: [],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    });
  });

  it('round-trips diets, allergens and nutrition thresholds', async () => {
    await writeDietProfile(profile);

    await expect(readDietProfile()).resolves.toEqual(profile);
  });

  it('normalizes malformed values to the safe default', async () => {
    await writeKeyValue('diet-profile', JSON.stringify({ profile: {
      diet: 'unknown', excludedAllergens: ['fish', 'fish'], nutrition: { maxCaloriesPerServing: -1 },
    } }));

    await expect(readDietProfile()).resolves.toMatchObject({ diet: 'omnivore', excludedAllergens: [] });
  });
});
