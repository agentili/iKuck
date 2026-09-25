import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { isCookEvent, isRecipePreference } from '../domain/activity';
import { deleteKeyValue, isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';
import { getPersonalDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';

export const ACTIVITY_DATABASE_KEY = 'activity';
export const PREFERENCES_DATABASE_KEY = 'recipe-preferences';
export const ACTIVITY_STORAGE_KEY = 'ikuck-activity-v1';
export const PREFERENCES_STORAGE_KEY = 'ikuck-recipe-preferences-v1';

const scopedKey = (base: string, scope: SyncScope = getPersonalDataScope()): string => scope === 'guest' ? base : scopeStorageKey(scope, base);
const personalScopedKey = (base: string, scope: SyncScope = getPersonalDataScope()): string => scope === 'guest' ? base : scopeStorageKey(scope, base);

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

export async function readCookEvents(scope: SyncScope = getPersonalDataScope()): Promise<CookEvent[]> {
  if (!isIndexedDbAvailable()) return parseCollection(window.localStorage.getItem(scopedKey(ACTIVITY_STORAGE_KEY, scope)), normalizeCookEvents);
  try {
    return parseCollection(await readKeyValue<string>(scopedKey(ACTIVITY_DATABASE_KEY, scope)), normalizeCookEvents);
  } catch {
    return parseCollection(window.localStorage.getItem(scopedKey(ACTIVITY_STORAGE_KEY, scope)), normalizeCookEvents);
  }
}

export async function writeCookEvents(events: readonly CookEvent[], scope: SyncScope = getPersonalDataScope()): Promise<void> {
  const serialized = serializeCollection(events, normalizeCookEvents);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(scopedKey(ACTIVITY_STORAGE_KEY, scope), serialized);
    return;
  }
  try {
    await writeKeyValue(scopedKey(ACTIVITY_DATABASE_KEY, scope), serialized);
  } catch (error) {
    window.localStorage.setItem(scopedKey(ACTIVITY_STORAGE_KEY, scope), serialized);
    throw error;
  }
}

export async function clearCookEvents(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(scopedKey(ACTIVITY_DATABASE_KEY, scope));
  window.localStorage.removeItem(scopedKey(ACTIVITY_STORAGE_KEY, scope));
}

export async function readRecipePreferences(scope: SyncScope = getPersonalDataScope()): Promise<RecipePreference[]> {
  if (!isIndexedDbAvailable()) return parseCollection(window.localStorage.getItem(personalScopedKey(PREFERENCES_STORAGE_KEY, scope)), normalizeRecipePreferences);
  try {
    return parseCollection(await readKeyValue<string>(personalScopedKey(PREFERENCES_DATABASE_KEY, scope)), normalizeRecipePreferences);
  } catch {
    return parseCollection(window.localStorage.getItem(personalScopedKey(PREFERENCES_STORAGE_KEY, scope)), normalizeRecipePreferences);
  }
}

export async function writeRecipePreferences(preferences: readonly RecipePreference[], scope: SyncScope = getPersonalDataScope()): Promise<void> {
  const serialized = serializeCollection(preferences, normalizeRecipePreferences);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(personalScopedKey(PREFERENCES_STORAGE_KEY, scope), serialized);
    return;
  }
  try {
    await writeKeyValue(personalScopedKey(PREFERENCES_DATABASE_KEY, scope), serialized);
  } catch (error) {
    window.localStorage.setItem(personalScopedKey(PREFERENCES_STORAGE_KEY, scope), serialized);
    throw error;
  }
}

export async function clearRecipePreferences(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) await deleteKeyValue(personalScopedKey(PREFERENCES_DATABASE_KEY, scope));
  window.localStorage.removeItem(personalScopedKey(PREFERENCES_STORAGE_KEY, scope));
}
