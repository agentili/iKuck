import type { RecipeImageMetadata } from '@ikuck/shared/contracts';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
type Entry = { metadata: RecipeImageMetadata; blob: Blob; updatedAt: number };
const database = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open('ikuck-private-images-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('images');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export async function readPrivateImage(key: string): Promise<Entry | undefined> {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const request = db.transaction('images').objectStore('images').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
export async function writePrivateImage(key: string, entry: Omit<Entry, 'updatedAt'>, scope: string) {
  const db = await database();
  try {
    if (getActiveDataScope() !== scope) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite'); const store = tx.objectStore('images');
      store.put({ ...entry, updatedAt: Date.now() }, key);
      const keys = store.getAllKeys(); keys.onsuccess = () => { for (const old of keys.result.slice(0, Math.max(0, keys.result.length - 50))) store.delete(old); };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function clearPrivateImages() {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('images', 'readwrite'); tx.objectStore('images').clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
}
subscribeActiveDataScope(() => { if (import.meta.env.VITE_RECIPE_IMAGES_ENABLED === 'true') void clearPrivateImages().catch(() => undefined); });
