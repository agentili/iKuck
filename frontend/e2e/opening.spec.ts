import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installOfflineBackend, assertOfflineBackendClean } from './helpers/backendMode';

test('opens with a single pantry action, supports local editing and passes an accessibility audit', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  await page.getByRole('link', { name: 'Aggiungi un ingrediente' }).click();
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
  assertOfflineBackendClean(page);
});
