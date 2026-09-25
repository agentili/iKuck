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
import { getActiveDataScope, getPersonalDataScope, subscribePersonalDataScope, type SyncScope } from '../sync/scopeContext';

export interface DietProfileState {
  hasHydrated: boolean;
  profile: DietProfile;
  setDietProfile: (input: DietProfilePayload) => boolean;
  resetDietProfile: () => void;
}

let hydrationPromise: Promise<void> | null = null;
let hydrationGeneration = 0;
let hydratedScope: SyncScope | null = null;
let pendingStorageWrites = Promise.resolve();

const createDefaultProfile = (): DietProfile => normalizeDietProfile({
  ...DEFAULT_DIET_PROFILE,
  updatedAt: new Date().toISOString(),
});

const persistProfile = (profile: DietProfile, scope: SyncScope): Promise<void> => {
  const operation = pendingStorageWrites.then(() => writeDietProfile(profile, scope));
  pendingStorageWrites = operation.catch(() => undefined);
  return operation;
};

const persistAndQueue = (profile: DietProfile): void => {
  const personalScope = getPersonalDataScope();
  void trackPersistence('diet', () => persistProfile(profile, personalScope));
  void trackSync('diet', () => enqueueEntityMutation(getMutationScope('diet_profile', getActiveDataScope(), personalScope), 'diet_profile', 'profile', 'upsert', profile));
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

subscribePersonalDataScope(() => {
  hydrationGeneration += 1;
  hydratedScope = null;
  useDietProfileStore.setState({ hasHydrated: false, profile: createDefaultProfile() });
});

export async function waitForPendingDietProfileWrites(): Promise<void> {
  await pendingStorageWrites;
  await waitForPendingQueueWrites();
}

export async function hydrateDietProfileStore(): Promise<void> {
  for (;;) {
    const scope = getPersonalDataScope();
    const generation = hydrationGeneration;
    if (useDietProfileStore.getState().hasHydrated && hydratedScope === scope) return;
    if (hydrationPromise === null) {
      const currentPromise = readDietProfile(scope)
        .then((profile) => {
          if (getPersonalDataScope() !== scope || hydrationGeneration !== generation) return;
          hydratedScope = scope;
          useDietProfileStore.setState({ profile: normalizeDietProfile(profile), hasHydrated: true });
        })
        .catch(() => {
          if (getPersonalDataScope() !== scope || hydrationGeneration !== generation) return;
          hydratedScope = scope;
          useDietProfileStore.setState({ profile: createDefaultProfile(), hasHydrated: true });
        })
        .finally(() => {
          hydrationPromise = null;
        });
      hydrationPromise = currentPromise;
    }
    const pendingHydration = hydrationPromise;
    if (pendingHydration !== null) await pendingHydration;
    if (getPersonalDataScope() === scope && hydrationGeneration === generation
      && useDietProfileStore.getState().hasHydrated && hydratedScope === scope) return;
  }
}
