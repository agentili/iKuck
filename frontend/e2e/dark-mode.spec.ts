import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const themePreferenceKey = 'ikuck-color-theme';
const firstPaintThemeKey = 'ikuck-e2e-first-paint-theme';

const auditedPages = [
  { path: '/', heading: 'Cucina viva', name: 'home' },
  { path: '/shopping-list', heading: 'Lista della spesa', name: 'shopping-list' },
  { path: '/recipes/pasta-tonno-pomodoro', heading: 'Pasta tonno e pomodoro', name: 'recipe-detail' },
  { path: '/profile', heading: 'Accedi al tuo profilo', name: 'profile' },
] as const;

const expectTheme = async (page: Page, theme: 'light' | 'dark'): Promise<void> => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
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

test('header quick toggle switches between light and dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expectTheme(page, 'light');

  await page.getByRole('button', { name: 'Attiva tema scuro' }).click();
  await expectTheme(page, 'dark');
  await expect(page.getByRole('button', { name: 'Attiva tema chiaro' })).toBeVisible();

  await page.getByRole('button', { name: 'Attiva tema chiaro' }).click();
  await expectTheme(page, 'light');
  await expect(page.getByRole('button', { name: 'Attiva tema scuro' })).toBeVisible();
});

test('legacy UI colors and radii resolve to iKuck design tokens in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript(({ key, preference }) => localStorage.setItem(key, preference), {
      key: themePreferenceKey,
      preference: theme,
    });
    await page.goto('/');
    await expectTheme(page, theme);
    await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
    const expectedHeadingFontSize = (page.viewportSize()?.width ?? 0) >= 1200 ? '60px' : '36px';

    const styles = await page.evaluate(() => {
      const heading = document.querySelector('main h1');
      const description = document.querySelector('main header > p:last-child');
      const activeNavigationLink = document.querySelector('nav[aria-label="Navigazione principale"] a[aria-current="page"]');
      const primaryButton = document.querySelector('.ik-button-primary');
      const pantryWorkbench = document.querySelector('.ik-pantry-workbench');

      if (!heading || !description || !activeNavigationLink || !primaryButton || !pantryWorkbench) {
        throw new Error('Expected design-system elements were not rendered.');
      }

      return {
        pageBackground: getComputedStyle(document.body).backgroundColor,
        headingColor: getComputedStyle(heading).color,
        bodyTextColor: getComputedStyle(description).color,
        activeNavigationBackground: getComputedStyle(activeNavigationLink).backgroundColor,
        navigationRadius: getComputedStyle(activeNavigationLink).borderRadius,
        primaryActionBackground: getComputedStyle(primaryButton).backgroundColor,
        primaryActionRadius: getComputedStyle(primaryButton).borderRadius,
        workbenchRadius: getComputedStyle(pantryWorkbench).borderRadius,
        usesDesignFont: getComputedStyle(heading).fontFamily.includes('Bricolage Grotesque Variable'),
        responsiveHeadingFontSize: getComputedStyle(heading).fontSize,
      };
    });

    expect(styles).toEqual(theme === 'light'
      ? {
        pageBackground: 'rgb(250, 251, 247)',
        headingColor: 'rgb(24, 48, 40)',
        bodyTextColor: 'rgb(82, 102, 91)',
        activeNavigationBackground: 'rgb(225, 236, 228)',
        navigationRadius: '12px',
        primaryActionBackground: 'rgb(36, 122, 74)',
        primaryActionRadius: '12px',
        workbenchRadius: '28px',
        usesDesignFont: true,
        responsiveHeadingFontSize: expectedHeadingFontSize,
      }
      : {
        pageBackground: 'rgb(16, 22, 19)',
        headingColor: 'rgb(232, 239, 233)',
        bodyTextColor: 'rgb(159, 176, 167)',
        activeNavigationBackground: 'rgb(28, 40, 35)',
        navigationRadius: '12px',
        primaryActionBackground: 'rgb(69, 184, 119)',
        primaryActionRadius: '12px',
        workbenchRadius: '28px',
        usesDesignFont: true,
        responsiveHeadingFontSize: expectedHeadingFontSize,
      });
  }
});

test('captures desktop screenshots of the four requested dark-theme pages', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Report screenshots are captured at desktop size.');
  await page.addInitScript((key) => localStorage.setItem(key, 'dark'), themePreferenceKey);

  for (const route of auditedPages) {
    await page.goto(route.path);
    await expectTheme(page, 'dark');
    await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
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
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();

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

test('reapplies dark theme from the service-worker cache while offline without a light first frame', async ({ page, context }) => {
  await page.addInitScript((key) => {
    requestAnimationFrame(() => {
      const observed = JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[];
      observed.push(document.documentElement.dataset.theme ?? 'unset');
      sessionStorage.setItem(key, JSON.stringify(observed));
    });
  }, firstPaintThemeKey);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
  await page.getByRole('button', { name: 'Attiva tema scuro' }).click();
  await expectTheme(page, 'dark');
  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await page.evaluate((key) => sessionStorage.setItem(key, '[]'), firstPaintThemeKey);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
  await expectTheme(page, 'dark');
  await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[], firstPaintThemeKey))
    .toEqual(['dark']);
  await context.setOffline(false);
});
