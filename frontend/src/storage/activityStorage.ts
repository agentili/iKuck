import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { isCookEvent, isRecipePreference } from '../domain/activity';
import { deleteKeyValue, isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';
import { getActiveDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { trackScopedWrite } from '../sync/scopeWriteFence';

export const ACTIVITY_DATABASE_KEY = 'activity';
export const PREFERENCES_DATABASE_KEY = 'recipe-preferences';
export const ACTIVITY_STORAGE_KEY = 'ikuck-activity-v1';
export const PREFERENCES_STORAGE_KEY = 'ikuck-recipe-preferences-v1';

const scopedKey = (base: string, scope: SyncScope = getActiveDataScope()): string => scope === 'guest' ? base : scopeStorageKey(scope, base);

const normalizeById = <T extends { id: string }>(items: readonly unknown[], guard: (value: unknown) => value is T): T[] => {
  const unique = new Map<string, T>();
  for (const item of items) {
    if (guard(item)) unique.set(item.id, item);
  }
  return [...unique.values()];
};

export const normalizeCookEvents = (items: readonly unknown[]): CookEvent[] => normalizeById(items, isCookEvent);

export const normalizeRecipePreferences = (items: readonly unknown[]): RecipePreference[] => {
  const unique = new Map<string, RecipePreference>();
  for (const item of items) {
    if (isRecipePreference(item)) unique.set(item.recipeId, item);
  }
  return [...unique.values()];
};

const parseCollection = <T>(raw: string | null, normalize: (items: readonly unknown[]) => T[]): T[] => {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    return Array.isArray(parsed.items) ? normalize(parsed.items) : [];
  } catch {
    return [];
  }
};

const serializeCollection = <T>(items: readonly T[], normalize: (values: readonly unknown[]) => T[]): string => JSON.stringify({
  items: normalize(items),
  version: 1,
});

const writeCollection = (scope: SyncScope, databaseKey: string, storageKey: string, serialized: string): Promise<void> => (
  trackScopedWrite(scope, async (assertWritable) => {
    if (!isIndexedDbAvailable()) {
      assertWritable();
      window.localStorage.setItem(scopedKey(storageKey, scope), serialized);
      return;
    }
    try {
      assertWritable();
      await writeKeyValue(scopedKey(databaseKey, scope), serialized, assertWritable);
      assertWritable();
    } catch (error) {
      assertWritable();
      window.localStorage.setItem(scopedKey(storageKey, scope), serialized);
      throw error;
    }
  })
);

export async function readCookEvents(scope: SyncScope = getActiveDataScope()): Promise<CookEvent[]> {
  if (!isIndexedDbAvailable()) return parseCollection(window.localStorage.getItem(scopedKey(ACTIVITY_STORAGE_KEY, scope)), normalizeCookEvents);
  try {
    return parseCollection(await readKeyValue<string>(scopedKey(ACTIVITY_DATABASE_KEY, scope)), normalizeCookEvents);
  } catch {
    return parseCollection(window.localStorage.getItem(scopedKey(ACTIVITY_STORAGE_KEY, scope)), normalizeCookEvents);
  }
}

export async function writeCookEvents(events: readonly CookEvent[], scope: SyncScope = getActiveDataScope()): Promise<void> {
  return writeCollection(scope, ACTIVITY_DATABASE_KEY, ACTIVITY_STORAGE_KEY, serializeCollection(events, normalizeCookEvents));
}

export async function clearCookEvents(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(scopedKey(ACTIVITY_DATABASE_KEY, scope));
  window.localStorage.removeItem(scopedKey(ACTIVITY_STORAGE_KEY, scope));
}

export async function readRecipePreferences(scope: SyncScope = getActiveDataScope()): Promise<RecipePreference[]> {
  if (!isIndexedDbAvailable()) return parseCollection(window.localStorage.getItem(scopedKey(PREFERENCES_STORAGE_KEY, scope)), normalizeRecipePreferences);
  try {
    return parseCollection(await readKeyValue<string>(scopedKey(PREFERENCES_DATABASE_KEY, scope)), normalizeRecipePreferences);
  } catch {
    return parseCollection(window.localStorage.getItem(scopedKey(PREFERENCES_STORAGE_KEY, scope)), normalizeRecipePreferences);
  }
}

export async function writeRecipePreferences(preferences: readonly RecipePreference[], scope: SyncScope = getActiveDataScope()): Promise<void> {
  return writeCollection(scope, PREFERENCES_DATABASE_KEY, PREFERENCES_STORAGE_KEY, serializeCollection(preferences, normalizeRecipePreferences));
}

export async function clearRecipePreferences(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(scopedKey(PREFERENCES_DATABASE_KEY, scope));
  window.localStorage.removeItem(scopedKey(PREFERENCES_STORAGE_KEY, scope));
}
