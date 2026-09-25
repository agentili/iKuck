import type { DietProfile } from '@ikuck/shared/contracts';
import { normalizeDietProfile } from '../domain/dietary';
import { isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';
import { getPersonalDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';

export const DIET_PROFILE_DATABASE_KEY = 'diet-profile';
export const DIET_PROFILE_STORAGE_KEY = 'ikuck-diet-profile-v1';
const scopedKey = (base: string, scope: SyncScope = getPersonalDataScope()): string => scope === 'guest' ? base : scopeStorageKey(scope, base);

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

const readFallback = (scope: SyncScope = getPersonalDataScope()): DietProfile => parse(window.localStorage.getItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope)));

export async function readDietProfile(scope: SyncScope = getPersonalDataScope()): Promise<DietProfile> {
  if (!isIndexedDbAvailable()) return readFallback(scope);

  try {
    return parse(await readKeyValue<string>(scopedKey(DIET_PROFILE_DATABASE_KEY, scope)));
  } catch {
    return readFallback(scope);
  }
}

export async function writeDietProfile(profile: DietProfile, scope: SyncScope = getPersonalDataScope()): Promise<void> {
  const serialized = serialize(profile);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope), serialized);
    return;
  }

  try {
    await writeKeyValue(scopedKey(DIET_PROFILE_DATABASE_KEY, scope), serialized);
  } catch (error) {
    window.localStorage.setItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope), serialized);
    throw error;
  }
}
