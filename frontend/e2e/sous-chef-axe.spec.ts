import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const themePreferenceKey = 'ikuck-color-theme';

const offlineResponses = {
  'GET /v1/auth/session': { json: { authenticated: false } },
  'GET /v1/meal-plan/capabilities': { json: { version: 2, syncReadVersion: 2 } },
};

const auditedPages = [
  { path: '/plan', heading: 'Piano settimanale', name: 'Piano' },
  { path: '/recipes', heading: 'Ricette', name: 'Ricette' },
] as const;

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page, { responses: offlineResponses });
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

for (const theme of ['light', 'dark'] as const) {
  for (const route of auditedPages) {
    test(`Sous-Chef ${route.name}: landmark e axe puliti in modalità ${theme}`, async ({ page }) => {
      await page.addInitScript(({ key, preference }) => localStorage.setItem(key, preference), {
        key: themePreferenceKey,
        preference: theme,
      });
      await page.goto(route.path);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main').last().getByRole('heading', { name: route.heading, exact: true })).toBeVisible();

      const results = await new AxeBuilder({ page }).analyze();
      expect({
        mainCount: await page.getByRole('main').count(),
        mainContentCount: await page.locator('#main-content').count(),
        violations: results.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map(({ target }) => target),
        })),
      }, `${route.name} landmark and axe violations in ${theme} mode`).toEqual({
        mainCount: 1,
        mainContentCount: 1,
        violations: [],
      });
    });
  }
}
