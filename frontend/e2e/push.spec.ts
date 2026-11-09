import { expect, test, type Page } from '@playwright/test';
import { installOfflineBackend, assertOfflineBackendClean } from './helpers/backendMode';
const monday = '2030-01-07';
const id = '00000000-0000-4000-8000-000000000001';
const pushStatus = { enabled: true, publicKey: 'B' + 'A'.repeat(86), preferencesConfigured: true, preferences: { enabled: false, fridayTime: '19:00', timeZone: 'Europe/Rome' }, effectiveTimeZone: 'Europe/Rome' };
async function setupAccount(page: Page, serviceWorkers: 'block' | 'allow' = 'block') {
  await installOfflineBackend(page, { serviceWorkers, responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: 'push-browser-user', email: 'push@example.test', emailVerifiedAt: '2026-01-01T00:00:00Z' }, csrfToken: 'csrf', expiresAt: '2099-01-01T00:00:00Z' } },
    'GET /v1/profile': { json: { profile: { displayName: 'Push' } } },
    'GET /v1/house': { json: null },
    'GET /v1/push': { json: pushStatus },
    'GET /v1/push/subscriptions': { json: [] },
    'POST /v1/push/subscriptions': { json: { id } },
    'PUT /v1/push/preferences': { status: 204, json: null },
    [`DELETE /v1/push/subscriptions/${id}`]: { status: 204, json: null },
    'GET /v1/meal-plan/capabilities': { json: { version: 2, syncReadVersion: 2 } },
    'GET /v1/ai-recipes/consent': { json: { consent: { enabled: false, updatedAt: '2026-01-01T00:00:00Z' }, selectedProvider: 'openai' } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
  } });
  await page.route('**/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { cursor?: number } | null;
    await route.fulfill({ json: { changes: [], nextCursor: body?.cursor ?? 0 } });
  });
  await page.route('**/v1/meal-plan/read', async (route) => {
    const body = route.request().postDataJSON() as { dates: string[] };
    await route.fulfill({ json: { version: 2, states: body.dates.map((date, index) => ({ date, state: { date, revision: '123e4567-e89b-42d3-a456-426614174000', serverSequence: index + 1, kind: 'manual', recipeId: 'seed-recipe' } })) } });
  });
}
test('il link del promemoria conserva la settimana quando serve accedere', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto(`/plan?week=${monday}`);
  await expect(page.getByRole('link', { name: 'Accedi e apri il piano' })).toHaveAttribute('href', `/profile?returnTo=${encodeURIComponent(`/plan?week=${monday}`)}`);
  assertOfflineBackendClean(page);
});
test('la vista del promemoria mostra lunedì–domenica e conserva la finestra mobile', async ({ page }) => {
  await setupAccount(page);
  await page.goto(`/plan?week=${monday}`);
  const rows = page.getByRole('list', { name: 'Pasti della settimana' }).getByRole('listitem');
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toHaveAttribute('data-date', monday);
  await expect(rows.last()).toHaveAttribute('data-date', '2030-01-13');
  await page.getByRole('link', { name: 'Prossimi sette giorni', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem')).toHaveCount(7);
  assertOfflineBackendClean(page);
});
test('il profilo spiega come riabilitare un permesso negato', async ({ page }) => {
  await setupAccount(page, 'allow');
  await page.addInitScript(() => { Object.defineProperty(Notification, 'permission', { configurable: true, value: 'denied' }); });
  await page.goto('/profile');
  await expect(page.getByText(/Notifiche bloccate/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attiva notifiche' })).toBeDisabled();
  assertOfflineBackendClean(page);
});
test('attivazione esplicita, ricezione nel service worker e disattivazione', async ({ page, context }) => {
  await setupAccount(page, 'allow');
  const registrationsSent: unknown[] = [];
  await page.route('**/v1/push/subscriptions', async (route) => {
    if (route.request().method() === 'POST') registrationsSent.push(route.request().postDataJSON());
    await route.fulfill({ json: route.request().method() === 'POST' ? { id } : [] });
  });
  await context.grantPermissions(['notifications']);
  await page.addInitScript(() => {
    // Managed Chromium may block OS notifications even when CDP grants permission.
    Object.defineProperty(Notification, 'permission', { configurable: true, value: 'granted' });
    Object.defineProperty(Notification, 'requestPermission', { configurable: true, value: async () => 'granted' });
    const subscription = { endpoint: 'https://fcm.googleapis.com/send/test', options: {}, unsubscribe: async () => true, toJSON: () => ({ expirationTime: null, endpoint: 'https://fcm.googleapis.com/send/test', keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }) };
    Object.defineProperty(PushManager.prototype, 'getSubscription', { configurable: true, value: async () => null });
    Object.defineProperty(PushManager.prototype, 'subscribe', { configurable: true, value: async () => subscription });
  });
  const cdp = await context.newCDPSession(page);
  const registrations: { registrationId: string; scopeURL: string }[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => registrations.push(...event.registrations));
  await cdp.send('ServiceWorker.enable');
  await page.goto('/profile');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const scope = globalThis as unknown as ServiceWorkerGlobalScope & { pushTestNotifications: { title: string; options?: NotificationOptions }[] };
    scope.pushTestNotifications = [];
    scope.registration.showNotification = async (title, options) => { scope.pushTestNotifications.push({ title, options }); };
  });
  await page.getByRole('button', { name: 'Attiva notifiche' }).click();
  await expect(page.getByText('Notifiche attive su questo dispositivo.')).toBeVisible();
  expect(registrationsSent).toEqual([{ endpoint: 'https://fcm.googleapis.com/send/test', keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }]);
  await expect.poll(() => registrations.length).toBeGreaterThan(0);
  const registration = registrations.find((item) => item.scopeURL === new URL('/', page.url()).href)!;
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(page.url()).origin, registrationId: registration.registrationId, data: JSON.stringify({ accountId: 'push-browser-user', title: 'Prepara il piano della prossima settimana', body: 'Completa il piano.', tag: 'weekly-test', url: `/plan?week=${monday}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
  await expect.poll(() => worker.evaluate(() => Reflect.get(globalThis, 'pushTestNotifications'))).toEqual([expect.objectContaining({ title: 'Prepara il piano della prossima settimana', options: expect.objectContaining({ tag: 'weekly-test', data: expect.objectContaining({ url: `/plan?week=${monday}` }) }) })]);
  await page.getByRole('button', { name: 'Disattiva su questo dispositivo' }).click();
  await expect(page.getByText('Notifiche disattivate su questo dispositivo.')).toBeVisible();
  expect(await page.evaluate(() => caches.has('ikuck-push-consent'))).toBe(false);
  // Dispatch the click handler with a synthetic notification because managed browsers block OS UI.
  await worker.evaluate(async (url) => {
    const scope = globalThis as unknown as ServiceWorkerGlobalScope;
    const matchAll = scope.clients.matchAll.bind(scope.clients);
    scope.clients.matchAll = async (options) => {
      const clients = await matchAll(options);
      // Synthetic clicks lack OS user activation; keep the real navigation and stub focus only.
      for (const client of clients) Object.defineProperty(client, 'focus', { value: async () => client });
      return clients;
    };
    let completion: Promise<unknown> | undefined;
    const event = new Event('notificationclick');
    Object.defineProperty(event, 'notification', { value: { close() {}, data: { url } } });
    Object.defineProperty(event, 'waitUntil', { value: (promise: Promise<unknown>) => { completion = promise; } });
    globalThis.dispatchEvent(event);
    await completion;
  }, `/plan?week=${monday}`);
  await expect(page).toHaveURL(new RegExp(`/plan\\?week=${monday}$`));
  await cdp.detach();
  assertOfflineBackendClean(page);
});
