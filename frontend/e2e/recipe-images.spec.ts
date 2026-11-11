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
