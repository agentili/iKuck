import { create } from 'zustand';
import type { DietProfile, DietProfilePayload } from '@ikuck/shared/contracts';
import {
  DEFAULT_DIET_PROFILE,
  isDietProfile,
  normalizeDietProfile,
  validateDietProfileDetails,
} from '../domain/dietary';
import { readDietProfile, writeDietProfile } from '../storage/dietProfileStorage';
import {
  getMutationScope,
  enqueueEntityMutation,
  registerDietProfileSnapshotListener,
  waitForPendingQueueWrites,
} from '../sync/syncQueue';
import { trackPersistence, trackSync } from './persistenceStatusStore';

export interface DietProfileState {
  hasHydrated: boolean;
  profile: DietProfile;
  setDietProfile: (input: DietProfilePayload) => boolean;
  resetDietProfile: () => void;
}

let hydrationPromise: Promise<void> | null = null;
let pendingStorageWrites = Promise.resolve();

const createDefaultProfile = (): DietProfile => normalizeDietProfile({
  ...DEFAULT_DIET_PROFILE,
  updatedAt: new Date().toISOString(),
});

const persistProfile = (profile: DietProfile): Promise<void> => {
  const operation = pendingStorageWrites.then(() => writeDietProfile(profile));
  pendingStorageWrites = operation.catch(() => undefined);
  return operation;
};

const persistAndQueue = (profile: DietProfile): void => {
  void trackPersistence('diet', () => persistProfile(profile));
  void trackSync('diet', () => enqueueEntityMutation(getMutationScope('diet_profile'), 'diet_profile', 'profile', 'upsert', profile));
};

export const useDietProfileStore = create<DietProfileState>((set) => ({
  hasHydrated: false,
  profile: createDefaultProfile(),
  setDietProfile: (input) => {
    if (validateDietProfileDetails(input.diet, input.excludedAllergens, input.nutrition).length > 0) return false;
    const profile = normalizeDietProfile({ ...input, updatedAt: new Date().toISOString() });
    if (!isDietProfile(profile)) return false;
    set({ profile });
    persistAndQueue(profile);
    return true;
  },
  resetDietProfile: () => {
    const profile = createDefaultProfile();
    set({ profile });
    persistAndQueue(profile);
  },
}));

registerDietProfileSnapshotListener((profile) => {
  useDietProfileStore.setState({ profile: normalizeDietProfile(profile) });
});

export async function waitForPendingDietProfileWrites(): Promise<void> {
  await pendingStorageWrites;
  await waitForPendingQueueWrites();
}

export async function hydrateDietProfileStore(): Promise<void> {
  if (useDietProfileStore.getState().hasHydrated) return;
  if (hydrationPromise === null) {
    hydrationPromise = readDietProfile()
      .then((profile) => useDietProfileStore.setState({ profile: normalizeDietProfile(profile), hasHydrated: true }))
      .catch(() => useDietProfileStore.setState({ profile: createDefaultProfile(), hasHydrated: true }))
      .finally(() => {
        hydrationPromise = null;
      });
  }
  await hydrationPromise;
}
