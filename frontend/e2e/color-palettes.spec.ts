import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const palettePreferenceKey = 'ikuck-color-palette';
const themePreferenceKey = 'ikuck-color-theme';
const palettes = [
  'pistachio-lemon',
  'peach-coral',
  'lavender-blueberry',
  'sea-terracotta',
] as const;
const themes = ['light', 'dark'] as const;

test.beforeEach(async ({ page }) => {
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

for (const palette of palettes) {
  for (const theme of themes) {
    test(`${palette} palette renders with ${theme} mode and passes axe`, async ({ page }) => {
      await page.addInitScript(({ paletteId, themePreference, paletteKey, themeKey }) => {
        localStorage.setItem(paletteKey, paletteId);
        localStorage.setItem(themeKey, themePreference);
      }, {
        paletteId: palette,
        themePreference: theme,
        paletteKey: palettePreferenceKey,
        themeKey: themePreferenceKey,
      });

      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-palette', palette);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();

      const browserThemeColor = await page.evaluate(() => (
        getComputedStyle(document.documentElement).getPropertyValue('--ik-browser-theme-color').trim()
      ));
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', browserThemeColor);

      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations, `${palette} / ${theme} accessibilità`).toEqual([]);
    });
  }
}

test('la palette scelta nel profilo resta attiva dopo il riavvio', async ({ page }) => {
  await page.goto('/profile');

  const paletteGroup = page.getByRole('radiogroup', { name: 'Palette' });
  await expect(paletteGroup.getByRole('radio', { name: /Pistacchio e limone/ })).toBeChecked();
  await paletteGroup.getByRole('radio', { name: /Pesca e corallo/ }).check();

  await expect(page.locator('html')).toHaveAttribute('data-palette', 'peach-coral');
  await expect(page).toHaveURL(/\/profile$/);
  await page.reload();

  await expect(page.locator('html')).toHaveAttribute('data-palette', 'peach-coral');
  await expect(page.getByRole('radiogroup', { name: 'Palette' }).getByRole('radio', { name: /Pesca e corallo/ })).toBeChecked();
});
