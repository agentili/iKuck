import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';
import { COLOR_PALETTES } from '../src/domain/colorPalette';
import {
  goToKitchen,
  isSousChefBuild,
  kitchenHeading,
  kitchenPath,
  landingHeading,
} from './helpers/appMode';

const themePreferenceKey = 'ikuck-color-theme';
const palettePreferenceKey = 'ikuck-color-palette';
const firstPaintThemeKey = 'ikuck-e2e-first-paint-theme';

const auditedPages = [
  ...(isSousChefBuild ? [{ path: '/', heading: landingHeading, name: 'chef' }] : []),
  { path: kitchenPath, heading: kitchenHeading, name: 'home' },
  { path: '/shopping-list', heading: 'Lista della spesa', name: 'shopping-list' },
  { path: '/recipes/pasta-tonno-pomodoro', heading: 'Pasta tonno e pomodoro', name: 'recipe-detail' },
  { path: '/profile', heading: 'Accedi al tuo profilo', name: 'profile' },
] as const;

const expectTheme = async (page: Page, theme: 'light' | 'dark'): Promise<void> => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
};

test.beforeEach(async ({ context, page }, testInfo) => {
  await context.clearCookies();
  await installOfflineBackend(page, {
    serviceWorkers: testInfo.tags.includes('@service-worker-offline') ? 'allow' : 'block',
  });
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('persists the selected dark theme across reloads', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/profile');
  await expect(page.getByRole('radio', { name: 'Sistema' })).toBeChecked();

  await page.getByRole('radio', { name: 'Scuro' }).check();
  await expectTheme(page, 'dark');
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), themePreferenceKey)).toBe('dark');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Accedi al tuo profilo' })).toBeVisible();
  await expectTheme(page, 'dark');
  await expect(page.getByRole('radio', { name: 'Scuro' })).toBeChecked();
});

test('offers ten color palettes and keeps the selected palette across reloads and dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/profile');

  const palettes = page.getByRole('radiogroup', { name: 'Palette colori' });
  await expect(palettes.getByRole('radio')).toHaveCount(10);
  const accentColors: string[] = [];
  for (const palette of COLOR_PALETTES) {
    await palettes.getByText(palette.label, { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', palette.value);
    accentColors.push(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ik-basil').trim()));
  }
  expect(new Set(accentColors).size).toBe(10);
  await palettes.getByText('Oceano', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'oceano');
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), palettePreferenceKey)).toBe('oceano');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ik-basil').trim()))
    .toBe('#276285');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(245, 250, 252)');
  const lightAudit = await new AxeBuilder({ page }).analyze();
  expect(lightAudit.violations.map(({ id }) => id)).toEqual([]);
  for (const route of auditedPages) {
    await page.goto(route.path);
    await expect(page.locator('main')).toBeVisible();
    const routeAudit = await new AxeBuilder({ page }).analyze();
    expect(routeAudit.violations.map(({ id }) => id), `${route.name} in Oceano light theme`).toEqual([]);
  }

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'oceano');
  await expect(page.getByRole('radio', { name: /Oceano/ })).toBeChecked();

  await page.getByRole('radio', { name: 'Scuro' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'oceano');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(16, 25, 30)');
  const darkAudit = await new AxeBuilder({ page }).analyze();
  expect(darkAudit.violations.map(({ id }) => id)).toEqual([]);
  for (const route of auditedPages) {
    await page.goto(route.path);
    await expect(page.locator('main')).toBeVisible();
    const routeAudit = await new AxeBuilder({ page }).analyze();
    expect(routeAudit.violations.map(({ id }) => id), `${route.name} in Oceano dark theme`).toEqual([]);
  }
});

test('system preference follows dark and light device schemes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/profile');
  await page.getByRole('radio', { name: 'Scuro' }).check();
  await page.getByRole('radio', { name: 'Sistema' }).check();
  await expect(page.getByRole('radio', { name: 'Sistema' })).toBeChecked();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), themePreferenceKey)).toBe('system');
  await expectTheme(page, 'dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
});

test('header leaves theme selection in profile settings', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await goToKitchen(page);
  await expectTheme(page, 'light');

  await expect(page.getByRole('button', { name: /Attiva tema (chiaro|scuro)|Tema (chiaro|scuro)/ })).toHaveCount(0);
  await page.goto('/profile');
  await expect(page.getByRole('radio', { name: 'Scuro' })).toBeVisible();
});

test('captures desktop screenshots of the four requested dark-theme pages', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Report screenshots are captured at desktop size.');
  await page.addInitScript((key) => localStorage.setItem(key, 'dark'), themePreferenceKey);

  for (const route of auditedPages) {
    await page.goto(route.path);
    await expectTheme(page, 'dark');
    await expect(page.locator('main').getByRole('heading', { name: route.heading, exact: true })).toBeVisible();
    const screenshotPath = testInfo.outputPath(`dark-${route.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe has no violations on the four pages in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(({ key, preference }) => localStorage.setItem(key, preference), {
      key: themePreferenceKey,
      preference: theme,
    });

    const routeViolations: string[] = [];
    for (const route of auditedPages) {
      await page.goto(route.path);
      await expectTheme(page, theme);
      await expect(page.locator('main').getByRole('heading', { name: route.heading, exact: true })).toBeVisible();

      const results = await new AxeBuilder({ page }).analyze();
      const colorContrastViolations = results.violations.filter((violation) => violation.id === 'color-contrast');
      if (colorContrastViolations.length > 0 || results.violations.length > 0) {
        routeViolations.push(JSON.stringify({
          page: route.name,
          colorContrast: colorContrastViolations.map((violation) => ({
            impact: violation.impact,
            nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
          })),
          otherViolations: results.violations.filter((violation) => violation.id !== 'color-contrast').map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
          })),
        }));
      }
    }
    expect(routeViolations, `${theme} axe violations across all requested pages`).toEqual([]);
  });
}

test('reapplies dark theme from the service-worker cache while offline without a light first frame', {
  tag: '@service-worker-offline',
}, async ({ page, context }) => {
  await page.addInitScript((key) => {
    requestAnimationFrame(() => {
      const observed = JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[];
      observed.push(document.documentElement.dataset.theme ?? 'unset');
      sessionStorage.setItem(key, JSON.stringify(observed));
    });
  }, firstPaintThemeKey);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/profile');
  await page.getByRole('radio', { name: 'Scuro' }).check();
  await goToKitchen(page);
  await expect(page.getByRole('heading', { name: kitchenHeading })).toBeVisible();
  await expectTheme(page, 'dark');
  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await page.evaluate((key) => sessionStorage.setItem(key, '[]'), firstPaintThemeKey);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: kitchenHeading })).toBeVisible();
  await expectTheme(page, 'dark');
  await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[], firstPaintThemeKey))
    .toEqual(['dark']);
  await context.setOffline(false);
});
