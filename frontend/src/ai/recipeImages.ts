import { readPrivateImage, writePrivateImage } from './recipeImageCache';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasCommonsImageCredit, RECIPE_IMAGE_METADATA_VERSION, type RecipeImageMetadata } from '@ikuck/shared/contracts';
import { apiRequest } from '../api/apiClient';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import { RECIPES } from '../domain/recipes';
import { RECIPE_IMAGES } from '../domain/recipeImages';
const catalog = new Set(RECIPES.map(r => r.id));
const versionQuery = `metadataVersion=${RECIPE_IMAGE_METADATA_VERSION}`;
const publicCacheName = `ikuck-public-recipe-images-v${RECIPE_IMAGE_METADATA_VERSION}`;
function readyImageUrl(metadata: RecipeImageMetadata) {
  const { url, source, width, height } = metadata;
  if (metadata.state !== 'ready' || typeof url !== 'string'
    || !Number.isInteger(width) || !Number.isInteger(height) || width! < 1 || height! < 1) return undefined;
  const assetPath = /^\/v1\/recipe-images\/assets\/[a-z0-9-]+$/i;
  const v2 = url.endsWith(`?${versionQuery}`) && assetPath.test(url.slice(0, -(versionQuery.length + 1)));
  if (source === 'wikimedia') return v2 && metadata.metadataVersion === RECIPE_IMAGE_METADATA_VERSION
    && hasCommonsImageCredit(metadata.author, metadata.sourceUrl, metadata.license) ? url : undefined;
  // Old APIs ignore the query and still return their original Pexels/AI contract.
  return (source === 'pexels' || source === 'ai') && (v2 || assetPath.test(url)) ? url : undefined;
}
// Authenticated images never enter the shared HTTP cache.
const privateCache = new Map<string, { metadata: RecipeImageMetadata; blob: Blob }>();
subscribeActiveDataScope(() => privateCache.clear());
export function useRecipeImage(recipeId: string) {
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope);
  const [result, setResult] = useState<{ key: string; metadata: RecipeImageMetadata; url?: string }>();
  const key = `v${RECIPE_IMAGE_METADATA_VERSION}:${scope}:${recipeId}`;
  useEffect(() => {
    if (RECIPE_IMAGES[recipeId] !== undefined || (!catalog.has(recipeId) && scope === 'guest')) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let objectUrl: string | undefined; let loadSequence = 0;
    const isCatalog = catalog.has(recipeId);
    const path = `/v1/recipe-images/${encodeURIComponent(recipeId)}?kind=${isCatalog ? 'catalog' : 'private'}&${versionQuery}`;
    const load = async () => {
      const sequence = ++loadSequence;
      const isCurrent = () => !cancelled && sequence === loadSequence;
      try {
        const cache = isCatalog && 'caches' in window ? await caches.open(publicCacheName).catch(() => null) : null;
        let metadata: RecipeImageMetadata; let blob: Blob;
        const stored = !isCatalog && !navigator.onLine ? privateCache.get(key) ?? await readPrivateImage(key).catch(() => undefined) : undefined;
        if (!navigator.onLine && stored) { metadata = stored.metadata; blob = stored.blob; }
        else {
          const cached = !navigator.onLine ? await cache?.match(path) : undefined;
          if (!navigator.onLine && !cached) {
            if (isCurrent()) setResult({ key, metadata: { state: 'missing' } });
            return;
          }
          metadata = cached ? await cached.json() : await apiRequest<RecipeImageMetadata>(path);
          if (!isCurrent()) return;
          if (metadata.state !== 'ready') {
            setResult({ key, metadata });
            if (metadata.state === 'pending' || metadata.state === 'processing') timer = setTimeout(() => { void load(); }, 5000);
            return;
          }
          const url = readyImageUrl(metadata);
          if (!url) { setResult({ key, metadata: { state: 'missing' } }); return; }
          const cachedImage = !navigator.onLine ? await cache?.match(url) : undefined;
          const response = cachedImage ?? await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/webp')) throw new Error('image_unavailable');
          blob = await response.blob();
          if (!isCurrent()) return;
          if (blob.size > 1024 * 1024) throw new Error('image_unavailable');
          if (cache && !cachedImage) {
            try {
              await cache.put(url, new Response(blob, { headers: { 'content-type': 'image/webp' } }));
              await cache.put(path, new Response(JSON.stringify(metadata)));
              const keys = await cache.keys(); for (const old of keys.slice(0, Math.max(0, keys.length - 100))) await cache.delete(old);
            } catch { /* Display the downloaded image even when offline storage is full. */ }
          } else if (!isCatalog) {
            await writePrivateImage(key, { metadata, blob }, scope).catch(() => undefined);
            if (isCurrent() && getActiveDataScope() === scope) {
              privateCache.set(key, { metadata, blob });
              if (privateCache.size > 50) privateCache.delete(privateCache.keys().next().value!);
            }
          }
        }
        if (!readyImageUrl(metadata) || blob.size > 1024 * 1024) {
          if (isCurrent()) setResult({ key, metadata: { state: 'missing' } });
          return;
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
