import type { DiaryDraftSet, DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { isDiaryDraftSet, isDinnerEntry, isSavedRecipe } from '@ikuck/shared/dinnerDiary';
import { getActiveDataScope, scopeStorageKey, type SyncScope } from '../sync/scopeContext';
import { deleteKeyValue, isIndexedDbAvailable, readKeyValue, writeKeyValue } from './indexedDb';

const ENTRIES_DATABASE_KEY = 'dinner-entries';
const RECIPES_DATABASE_KEY = 'saved-recipes';
const ENTRIES_STORAGE_KEY = 'ikuck-dinner-entries-v1';
const RECIPES_STORAGE_KEY = 'ikuck-saved-recipes-v1';
const DRAFTS_DATABASE_KEY = 'dinner-drafts';
const DRAFTS_STORAGE_KEY = 'ikuck-dinner-drafts-v1';
const keyFor = (scope: SyncScope, key: string): string => scopeStorageKey(scope, key);

const normalizeByNewest = <T extends { id: string; updatedAt: string }>(items: readonly unknown[], guard: (item: unknown) => item is T): T[] => {
  const unique = new Map<string, T>();
  for (const item of items) {
    if (!guard(item)) continue;
    const current = unique.get(item.id);
    if (!current || Date.parse(item.updatedAt) > Date.parse(current.updatedAt)) unique.set(item.id, item);
  }
  return [...unique.values()];
};

const normalizeEntries = (items: readonly unknown[]): DinnerEntry[] => normalizeByNewest(items, isDinnerEntry);
const normalizeRecipes = (items: readonly unknown[]): SavedRecipe[] => normalizeByNewest(items, isSavedRecipe);

const parseCollection = <T>(raw: string | null, normalize: (items: readonly unknown[]) => T[]): T[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && 'items' in parsed && Array.isArray(parsed.items)
      ? normalize(parsed.items)
      : [];
  } catch {
    return [];
  }
};

const serializeCollection = <T>(items: readonly T[], normalize: (values: readonly unknown[]) => T[]): string => JSON.stringify({ items: normalize(items), version: 1 });

async function readCollection<T>(databaseKey: string, storageKey: string, scope: SyncScope, normalize: (items: readonly unknown[]) => T[]): Promise<T[]> {
  const scopedDbKey = keyFor(scope, databaseKey);
  const scopedStorageKey = keyFor(scope, storageKey);
  const fallback = () => parseCollection(window.localStorage.getItem(scopedStorageKey), normalize);
  if (!isIndexedDbAvailable()) return fallback();
  try {
    return parseCollection(await readKeyValue<string>(scopedDbKey), normalize);
  } catch {
    return fallback();
  }
}

async function writeCollection<T>(databaseKey: string, storageKey: string, values: readonly T[], scope: SyncScope, normalize: (items: readonly unknown[]) => T[]): Promise<void> {
  const serialized = serializeCollection(values, normalize);
  const scopedDbKey = keyFor(scope, databaseKey);
  const scopedStorageKey = keyFor(scope, storageKey);
  if (!isIndexedDbAvailable()) {
    window.localStorage.setItem(scopedStorageKey, serialized);
    return;
  }
  try {
    await writeKeyValue(scopedDbKey, serialized);
  } catch (error) {
    window.localStorage.setItem(scopedStorageKey, serialized);
    throw error;
  }
}

export const readDinnerEntries = (scope: SyncScope = getActiveDataScope()): Promise<DinnerEntry[]> => readCollection(ENTRIES_DATABASE_KEY, ENTRIES_STORAGE_KEY, scope, normalizeEntries);
export const writeDinnerEntries = (entries: readonly DinnerEntry[], scope: SyncScope): Promise<void> => writeCollection(ENTRIES_DATABASE_KEY, ENTRIES_STORAGE_KEY, entries, scope, normalizeEntries);
export const readSavedRecipes = (scope: SyncScope = getActiveDataScope()): Promise<SavedRecipe[]> => readCollection(RECIPES_DATABASE_KEY, RECIPES_STORAGE_KEY, scope, normalizeRecipes);
export const writeSavedRecipes = (recipes: readonly SavedRecipe[], scope: SyncScope): Promise<void> => writeCollection(RECIPES_DATABASE_KEY, RECIPES_STORAGE_KEY, recipes, scope, normalizeRecipes);

export async function readDiaryDraftSets(scope: SyncScope): Promise<DiaryDraftSet[]> {
  return readCollection(DRAFTS_DATABASE_KEY, DRAFTS_STORAGE_KEY, scope, (items) => {
    const latest = new Map<string, DiaryDraftSet>();
    for (const item of items) if (isDiaryDraftSet(item)) latest.set(item.entryId, item);
    return [...latest.values()];
  });
}
export async function writeDiaryDraftSets(sets: readonly DiaryDraftSet[], scope: SyncScope): Promise<void> {
  await writeCollection(DRAFTS_DATABASE_KEY, DRAFTS_STORAGE_KEY, sets, scope, (items) => {
    const latest = new Map<string, DiaryDraftSet>();
    for (const item of items) if (isDiaryDraftSet(item)) latest.set(item.entryId, item);
    return [...latest.values()];
  });
}

export async function clearDinnerDiary(scope: SyncScope): Promise<void> {
  if (isIndexedDbAvailable()) {
    await deleteKeyValue(keyFor(scope, ENTRIES_DATABASE_KEY));
    await deleteKeyValue(keyFor(scope, RECIPES_DATABASE_KEY));
    await deleteKeyValue(keyFor(scope, DRAFTS_DATABASE_KEY));
  }
  window.localStorage.removeItem(keyFor(scope, ENTRIES_STORAGE_KEY));
  window.localStorage.removeItem(keyFor(scope, RECIPES_STORAGE_KEY));
  window.localStorage.removeItem(keyFor(scope, DRAFTS_STORAGE_KEY));
}
