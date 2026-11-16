import { readPrivateImage, writePrivateImage } from './recipeImageCache';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RecipeImageMetadata } from '@ikuck/shared/contracts';
import { apiRequest } from '../api/apiClient';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import { RECIPES } from '../domain/recipes';
import { RECIPE_IMAGES } from '../domain/recipeImages';
const catalog = new Set(RECIPES.map(r => r.id));
// Authenticated images never enter the shared HTTP cache.
const privateCache = new Map<string, { metadata: RecipeImageMetadata; blob: Blob }>();
subscribeActiveDataScope(() => privateCache.clear());
export function useRecipeImage(recipeId: string) {
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope);
  const [result, setResult] = useState<{ key: string; metadata: RecipeImageMetadata; url?: string }>();
  const key = `${scope}:${recipeId}`;
  useEffect(() => {
    if (RECIPE_IMAGES[recipeId] !== undefined || (!catalog.has(recipeId) && scope === 'guest')) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let objectUrl: string | undefined; let loadSequence = 0;
    const isCatalog = catalog.has(recipeId);
    const path = `/v1/recipe-images/${encodeURIComponent(recipeId)}?kind=${isCatalog ? 'catalog' : 'private'}`;
    const load = async () => {
      const sequence = ++loadSequence;
      const isCurrent = () => !cancelled && sequence === loadSequence;
      try {
        const cache = isCatalog && 'caches' in window ? await caches.open('ikuck-public-recipe-images-v1').catch(() => null) : null;
        let metadata: RecipeImageMetadata; let blob: Blob;
        const stored = privateCache.get(key) ?? (!isCatalog ? await readPrivateImage(key).catch(() => undefined) : undefined);
        if (!navigator.onLine && stored) { metadata = stored.metadata; blob = stored.blob; }
        else {
          const cached = !navigator.onLine ? await cache?.match(path) : undefined;
          if (!navigator.onLine && !cached) {
            if (isCurrent()) setResult({ key, metadata: { state: 'missing' } });
            return;
          }
          metadata = cached ? await cached.json() : await apiRequest<RecipeImageMetadata>(path);
          if (!isCurrent()) return;
          if (metadata.state !== 'ready' || !metadata.url?.startsWith('/v1/recipe-images/assets/')) {
            setResult({ key, metadata });
            if (metadata.state === 'pending' || metadata.state === 'processing') timer = setTimeout(() => { void load(); }, 5000);
            return;
          }
          const cachedImage = !navigator.onLine ? await cache?.match(metadata.url) : undefined;
          const response = cachedImage ?? await fetch(metadata.url, { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/webp')) throw new Error('image_unavailable');
          blob = await response.blob();
          if (!isCurrent() || blob.size > 1024 * 1024) return;
          if (cache) {
            try {
            await cache.put(path, new Response(JSON.stringify(metadata)));
            await cache.put(metadata.url, new Response(blob, { headers: { 'content-type': 'image/webp' } }));
            const keys = await cache.keys(); for (const old of keys.slice(0, Math.max(0, keys.length - 100))) await cache.delete(old);
            } catch { /* Display the downloaded image even when offline storage is full. */ }
          } else { await writePrivateImage(key, { metadata, blob }, scope).catch(() => undefined); privateCache.set(key, { metadata, blob }); if (privateCache.size > 50) privateCache.delete(privateCache.keys().next().value!); }
        }
        if (isCurrent()) { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(blob); setResult({ key, metadata, url: objectUrl }); }
      } catch { if (isCurrent()) setResult({ key, metadata: { state: 'failed' } }); }
    };
    const reload = () => { clearTimeout(timer); void load(); };
    window.addEventListener('recipe-image-retry', reload);
    void load();
    return () => { window.removeEventListener('recipe-image-retry', reload); cancelled = true; clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [recipeId, scope, key]);
  return { ...(result?.key === key ? result : {}) };
}
