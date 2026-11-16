import { isIndexedDbAvailable, readKeyValue } from './indexedDb';

// A failed primary read is not proof of absence, even with an empty fallback.
export async function readCollectionSnapshot(databaseKey: string, storageKey: string): Promise<string | null> {
  if (!isIndexedDbAvailable()) return window.localStorage.getItem(storageKey);
  const raw = await readKeyValue<unknown>(databaseKey);
  if (raw === null) return window.localStorage.getItem(storageKey);
  if (typeof raw !== 'string') throw new Error('Invalid local collection snapshot');
  return raw;
}

export function parseCollectionSnapshot<T>(raw: string | null, guard: (value: unknown) => value is T): T[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('items' in parsed)
    || !Array.isArray(parsed.items) || !parsed.items.every(guard)) {
    throw new Error('Invalid local collection snapshot');
  }
  return parsed.items;
}
