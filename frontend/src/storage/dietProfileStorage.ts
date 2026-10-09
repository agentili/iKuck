import type { DietProfile } from '@ikuck/shared/contracts';
import { normalizeDietProfile } from '../domain/dietary';
import { deleteKeyValue, isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';
import { getActiveDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { trackScopedWrite } from '../sync/scopeWriteFence';

export const DIET_PROFILE_DATABASE_KEY = 'diet-profile';
export const DIET_PROFILE_STORAGE_KEY = 'ikuck-diet-profile-v1';
const scopedKey = (base: string, scope: SyncScope = getActiveDataScope()): string => scope === 'guest' ? base : scopeStorageKey(scope, base);

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

const readFallback = (scope: SyncScope = getActiveDataScope()): DietProfile => parse(window.localStorage.getItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope)));

export async function readPersistedDietProfile(scope: SyncScope = getActiveDataScope()): Promise<DietProfile | null> {
  const fallback = (): DietProfile | null => {
    const raw = window.localStorage.getItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope));
    return raw === null ? null : parse(raw);
  };
  if (!isIndexedDbAvailable()) return fallback();
  try {
    const raw = await readKeyValue<string>(scopedKey(DIET_PROFILE_DATABASE_KEY, scope));
    return raw === null ? null : parse(raw);
  } catch {
    return fallback();
  }
}

export async function readDietProfile(scope: SyncScope = getActiveDataScope()): Promise<DietProfile> {
  if (!isIndexedDbAvailable()) return readFallback(scope);

  try {
    return parse(await readKeyValue<string>(scopedKey(DIET_PROFILE_DATABASE_KEY, scope)));
  } catch {
    return readFallback(scope);
  }
}

export async function writeDietProfile(profile: DietProfile, scope: SyncScope = getActiveDataScope()): Promise<void> {
  return trackScopedWrite(scope, async (assertWritable) => {
    const serialized = serialize(profile);
    if (!isIndexedDbAvailable()) {
      assertWritable();
      window.localStorage.setItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope), serialized);
      return;
    }
    try {
      assertWritable();
      await writeKeyValue(scopedKey(DIET_PROFILE_DATABASE_KEY, scope), serialized, assertWritable);
      assertWritable();
    } catch (error) {
      assertWritable();
      window.localStorage.setItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope), serialized);
      throw error;
    }
  });
}

export async function clearDietProfile(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(scopedKey(DIET_PROFILE_DATABASE_KEY, scope));
  window.localStorage.removeItem(scopedKey(DIET_PROFILE_STORAGE_KEY, scope));
}
