import { expect, test } from '@playwright/test';
import { installOfflineBackend } from './helpers/backendMode';
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

test('bulk generation is only in profile and single generation stays in recipe detail', async ({ page, context }) => {
  const consent = { enabled: true, updatedAt: '2026-11-01T00:00:00Z', imageProvider: 'openai', imagePolicyVersion: 'recipe-images-v1' };
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: 'image-user', email: 'images@example.com', emailVerifiedAt: '2026-11-01T00:00:00Z' }, csrfToken: 'image-csrf', expiresAt: '2099-01-01T00:00:00Z' } },
    'GET /v1/profile': { json: { profile: { displayName: 'Images' } } },
    'GET /v1/house': { json: null },
    'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
    'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
    'GET /v1/ai-recipes/consent': { json: { consent, selectedProvider: 'openai', selectedImageProvider: 'openai' } },
  } });
  let collectionRequests = 0; let singleRequests = 0; let requested = false;
  await context.route('**/v1/recipe-images/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('image-csrf');
      if (url.pathname === '/v1/recipe-images/generate') collectionRequests += 1;
      else { expect(url.pathname).toBe('/v1/recipe-images/pollo-al-limone/generate'); singleRequests += 1; requested = true; }
      await route.fulfill({ status: 202, json: { queued: url.pathname === '/v1/recipe-images/generate' ? 20 : 1 } });
    } else if (url.pathname.includes('/assets/')) {
      const image = await page.request.get('/recipe-images/uova-al-pomodoro.webp');
      await route.fulfill({ contentType: 'image/webp', body: await image.body() });
    } else await route.fulfill({ json: requested && url.pathname.endsWith('/pollo-al-limone')
      ? { state: 'ready', url: '/v1/recipe-images/assets/11111111-1111-1111-1111-111111111111', width: 720, height: 720, source: 'ai', author: 'OpenAI' }
      : { state: 'missing' } });
  });
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Genera tutte le immagini', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '20 immagini aggiunte alla coda' })).toBeVisible();
  await page.goto('/recipes');
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Genera tutte le immagini', exact: true })).toHaveCount(0);
  expect(collectionRequests).toBe(1);
  await page.goto('/recipes/pollo-al-limone');
  await page.getByRole('button', { name: 'Genera immagine', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Pollo al limone: immagine illustrativa' })).toBeVisible();
  await expect(page.getByText(/Immagine generata con AI/)).toBeVisible();
  expect(singleRequests).toBe(1);
});
