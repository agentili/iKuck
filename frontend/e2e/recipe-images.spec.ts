import { expect, test } from '@playwright/test';
import { installOfflineBackend } from './helpers/backendMode';
const enabled = process.env.VITE_RECIPE_IMAGES_ENABLED === 'true';
test.skip(!enabled, 'Image feature explicitly enabled in the dedicated browser run');
test('catalog image arrives asynchronously with attribution and remains available offline', async ({ page, context }) => {
  await installOfflineBackend(page);
  // New read-only image endpoints are explicitly mocked after the context guard.
  await context.route('**/v1/recipe-images/**', async route => {
    if (route.request().url().includes('/assets/')) {
      // A small valid WebP fixture is served by the existing local artwork.
      const response = await page.request.get('/recipe-images/uova-al-pomodoro.webp');
      await route.fulfill({ status: 200, contentType: 'image/webp', body: await response.body() });
    } else await route.fulfill({ json: { state: 'ready', url: '/v1/recipe-images/assets/11111111-1111-1111-1111-111111111111', width: 720, height: 720, source: 'pexels', author: 'Test photographer', sourceUrl: 'https://www.pexels.com/photo/test', license: 'Pexels' } });
  });
  await page.goto('/recipes/pollo-al-limone');
  await expect(page.getByRole('img', { name: 'Pollo al limone: immagine illustrativa' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pexels', exact: true })).toBeVisible();
  // SPA navigation exercises the bounded offline cache without relying on a service worker.
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Chef', exact: true }).first().click();
  await page.goBack();
  await expect(page.getByRole('img', { name: 'Pollo al limone: immagine illustrativa' })).toBeVisible();
});


test('profile explicitly queues and saves recipe library images in the background', async ({ page }) => {
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: 'image-user', email: 'image@example.test', emailVerifiedAt: '2026-11-13T10:00:00Z' }, csrfToken: 'image-csrf', expiresAt: '2099-01-01T00:00:00Z' } },
    'GET /v1/house': { json: { house: null } },
    'GET /v1/profile': { json: { profile: { displayName: 'Ale' } } },
    'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
    'POST /v1/sync': { json: { uploaded: 0, downloaded: 0, pending: 0, complete: true } },
    'GET /v1/ai-recipes/consent': { json: { consent: { enabled: true, homeProvider: 'openai', imagePolicyVersion: 'recipe-images-v1', imageProvider: 'openai', updatedAt: '2026-11-13T10:00:00Z' }, selectedProvider: 'openai', selectedImageProvider: 'openai' } },
    'POST /v1/recipe-images/generate-library': { status: 202, json: { queued: 3 } },
  } });
  await page.goto('/profile');
  const button = page.getByRole('button', { name: 'Genera e salva le immagini delle ricette' });
  await expect(button).toBeEnabled();
  const request = page.waitForRequest(req => req.url().endsWith('/v1/recipe-images/generate-library') && req.method() === 'POST');
  await button.click();
  expect((await request).postDataJSON()).toEqual({ scope: 'account:image-user' });
  await expect(page.getByRole('status').filter({ hasText: '3 immagini accodate' })).toBeVisible();
});
