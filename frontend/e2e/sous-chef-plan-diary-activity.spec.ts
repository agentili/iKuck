import { expect, test, type Locator, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const themePreferenceKey = 'ikuck-color-theme';

const routeCases: Array<{
  path: string;
  heading: string;
  name: string;
  emptyStateText?: string;
  surface: (page: Page) => Locator;
}> = [
  {
    path: '/plan',
    heading: 'Piano settimanale',
    name: 'plan',
    surface: (page) => page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first(),
  },
  {
    path: '/activity',
    heading: 'La tua attività',
    name: 'activity',
    emptyStateText: 'Non hai ancora segnato ricette come cucinate.',
    surface: (page) => page.getByRole('region', { name: 'La tua attività' }),
  },
];

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const themes = ['light', 'dark'] as const;

const matchesColorToken = async (
  locator: Locator,
  tokenName: string,
  property: 'color' | 'backgroundColor',
): Promise<boolean> => locator.evaluate((element, options) => {
  const token = getComputedStyle(document.documentElement).getPropertyValue(options.tokenName).trim();
  const hex = token.replace(/^#/, '');
  if (!/^[\da-f]{6}$/i.test(hex)) return false;
  const expected = `rgb(${Number.parseInt(hex.slice(0, 2), 16)}, ${Number.parseInt(hex.slice(2, 4), 16)}, ${Number.parseInt(hex.slice(4, 6), 16)})`;
  const actual = getComputedStyle(element)[options.property].replace(/\s+/g, '');
  return actual === expected.replace(/\s+/g, '');
}, { tokenName, property });

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

for (const theme of themes) {
  for (const viewport of viewports) {
    test(`${theme} ${viewport.name}: Piano e Attività usano superfici di tema`, async ({ page }, testInfo) => {
      await installOfflineBackend(page);
      await page.addInitScript(({ key, value }) => {
        localStorage.setItem(key, value);
      }, { key: themePreferenceKey, value: theme });

      for (const route of routeCases) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const response = await page.goto(route.path);
        expect(response?.status()).toBe(200);
        const pageHeading = page.getByRole('heading', { name: route.heading, exact: true });
        await expect(pageHeading).toBeVisible();
        expect(await matchesColorToken(pageHeading, '--ik-ink', 'color'), `${route.name} heading should use --ik-ink in ${theme}`).toBe(true);
        await expect(page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link')).toHaveCount(5);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const surfaceMatchesTheme = await matchesColorToken(route.surface(page), '--ik-surface', 'backgroundColor');
        expect(surfaceMatchesTheme, `${route.name} should use --ik-surface in ${theme}`).toBe(true);
        if (route.emptyStateText !== undefined) {
          const emptyStateText = page.getByText(route.emptyStateText, { exact: true });
          await expect(emptyStateText).toBeVisible();
          expect(await matchesColorToken(emptyStateText, '--ik-ink-muted', 'color'), `${route.name} empty state text should use --ik-ink-muted in ${theme}`).toBe(true);
          expect(await matchesColorToken(emptyStateText.locator('..'), '--ik-mist', 'backgroundColor'), `${route.name} empty state should use --ik-mist in ${theme}`).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        await page.screenshot({
          path: testInfo.outputPath(`${route.name}-${theme}-${viewport.name}.png`),
          fullPage: true,
        });
      }
    });
  }
}
