import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate, CacheFirst } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Cache immagini ricette
registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: 'recipe-images',
  })
);

// Cache API Supabase (per offline-first)
registerRoute(
  ({ url }) => url.hostname.includes('supabase.co'),
  new StaleWhileRevalidate({
    cacheName: 'supabase-api-cache',
  })
);

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
