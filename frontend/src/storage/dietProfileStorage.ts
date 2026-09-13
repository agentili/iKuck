import type { DietProfile } from '@ikuck/shared/contracts';
import { normalizeDietProfile } from '../domain/dietary';
import { isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';

export const DIET_PROFILE_DATABASE_KEY = 'diet-profile';
export const DIET_PROFILE_STORAGE_KEY = 'ikuck-diet-profile-v1';

interface PersistedDietProfile {
  profile: DietProfile;
  version: number;
}

const defaultProfile = (): DietProfile => normalizeDietProfile(null);

const parse = (raw: unknown): DietProfile => {
  if (typeof raw !== 'string') return defaultProfile();
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedDietProfile> | unknown;
    if (typeof parsed === 'object' && parsed !== null && 'profile' in parsed) {
      return normalizeDietProfile((parsed as Partial<PersistedDietProfile>).profile);
    }
    return normalizeDietProfile(parsed);
  } catch {
    return defaultProfile();
  }
};

const serialize = (profile: DietProfile): string => JSON.stringify({
  profile: normalizeDietProfile(profile),
  version: 1,
} satisfies PersistedDietProfile);

const readFallback = (): DietProfile => parse(window.localStorage.getItem(DIET_PROFILE_STORAGE_KEY));

export async function readDietProfile(): Promise<DietProfile> {
  if (!isIndexedDbAvailable()) return readFallback();

  try {
    return parse(await readKeyValue<string>(DIET_PROFILE_DATABASE_KEY));
  } catch {
    return readFallback();
  }
}

export async function writeDietProfile(profile: DietProfile): Promise<void> {
  const serialized = serialize(profile);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(DIET_PROFILE_STORAGE_KEY, serialized);
    return;
  }

  try {
    await writeKeyValue(DIET_PROFILE_DATABASE_KEY, serialized);
  } catch (error) {
    window.localStorage.setItem(DIET_PROFILE_STORAGE_KEY, serialized);
    throw error;
  }
}
