import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { isCookEvent, isRecipePreference } from '../domain/activity';
import { isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';

export const ACTIVITY_DATABASE_KEY = 'activity';
export const PREFERENCES_DATABASE_KEY = 'recipe-preferences';
export const ACTIVITY_STORAGE_KEY = 'ikuck-activity-v1';
export const PREFERENCES_STORAGE_KEY = 'ikuck-recipe-preferences-v1';

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

export async function readCookEvents(): Promise<CookEvent[]> {
  if (!isIndexedDbAvailable()) return parseCollection(window.localStorage.getItem(ACTIVITY_STORAGE_KEY), normalizeCookEvents);
  try {
    return parseCollection(await readKeyValue<string>(ACTIVITY_DATABASE_KEY), normalizeCookEvents);
  } catch {
    return parseCollection(window.localStorage.getItem(ACTIVITY_STORAGE_KEY), normalizeCookEvents);
  }
}

export async function writeCookEvents(events: readonly CookEvent[]): Promise<void> {
  const serialized = serializeCollection(events, normalizeCookEvents);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, serialized);
    return;
  }
  try {
    await writeKeyValue(ACTIVITY_DATABASE_KEY, serialized);
  } catch (error) {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, serialized);
    throw error;
  }
}

export async function readRecipePreferences(): Promise<RecipePreference[]> {
  if (!isIndexedDbAvailable()) return parseCollection(window.localStorage.getItem(PREFERENCES_STORAGE_KEY), normalizeRecipePreferences);
  try {
    return parseCollection(await readKeyValue<string>(PREFERENCES_DATABASE_KEY), normalizeRecipePreferences);
  } catch {
    return parseCollection(window.localStorage.getItem(PREFERENCES_STORAGE_KEY), normalizeRecipePreferences);
  }
}

export async function writeRecipePreferences(preferences: readonly RecipePreference[]): Promise<void> {
  const serialized = serializeCollection(preferences, normalizeRecipePreferences);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, serialized);
    return;
  }
  try {
    await writeKeyValue(PREFERENCES_DATABASE_KEY, serialized);
  } catch (error) {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, serialized);
    throw error;
  }
}
