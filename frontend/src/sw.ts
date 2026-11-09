/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { parsePushPayload, safePushDestination } from './push/payload';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/v1\//] }));
clientsClaim();
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = parsePushPayload(event.data?.json()); } catch { return; }
    if (!payload) return;
    const consent = await (await caches.open('ikuck-push-consent')).match('/__ikuck_push_consent');
    if (!consent || (await consent.json() as { userId: string }).userId !== payload.accountId) return;
    await self.registration.showNotification(payload.title, {
      body: payload.body, tag: payload.tag, icon: '/icons/icon-192x192.png', badge: '/icons/icon-192x192.png',
      data: { url: payload.url, expiresAt: payload.expiresAt },
    });
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = safePushDestination(event.notification.data?.url);
  if (!destination) return;
  event.waitUntil((async () => {
    const url = new URL(destination, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((window) => new URL(window.url).origin === self.location.origin);
    if (client) { await client.navigate(url); await client.focus(); }
    else await self.clients.openWindow(url);
  })());
});
