import { expect, test } from '@playwright/test';
import { installOfflineBackend, assertOfflineBackendClean } from './helpers/backendMode';

for (const verified of [false, true]) {
  test(`keeps local nutrition and allergens without remote enrichment (${verified ? 'verified' : 'guest'})`, async ({ page }) => {
    await installOfflineBackend(page);
    if (verified) {
      await page.route('**/v1/auth/session', route => route.fulfill({ json: { authenticated: true,
        user: { id: 'nutrition-fixture', email: 'fixture@example.com', emailVerifiedAt: '2026-09-13T10:00:00.000Z' },
        csrfToken: 'fixture', expiresAt: '2026-12-13T10:00:00.000Z',
      } }));
      await page.route('**/v1/profile', route => route.fulfill({ json: { profile: { displayName: null } } }));
      await page.route('**/v1/house', route => route.fulfill({ json: { house: null, membership: null, members: [] } }));
      await page.route('**/v1/sync', route => route.fulfill({ json: { changes: [], nextCursor: 0 } }));
    }
    const remoteNutrition: string[] = [];
    page.on('request', request => { if (/recipes\/nutrition|usda\.gov/.test(request.url())) remoteNutrition.push(request.url()); });
    await page.goto('/recipes/pasta-tonno-pomodoro');
    await expect(page.getByRole('heading', { name: 'Nutrizione stimata per porzione' })).toBeVisible();
    await expect(page.getByText('Stima indicativa', { exact: true })).toBeVisible();
    await expect(page.getByText(/Allergeni dichiarati:/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Aggiorna stima/ })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Stima indicativa', { exact: true })).toBeVisible();
    expect(remoteNutrition).toEqual([]);
    assertOfflineBackendClean(page);
  });
}
