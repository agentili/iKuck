import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.skip(process.env.VITE_SOUS_CHEF !== 'true', 'Sous-Chef build required');

test('Chef shows real chat interface with DailyRecipeCard', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');

  // DailyRecipeCard is visible
  await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();

  // Chat area shows welcome message (no messages yet)
  await expect(page.getByText(/Ciao! Sono Chef/i)).toBeVisible();

  // No simulated chat elements
  await expect(page.getByText(/chat non disponibile/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /autorizza e genera|input vocale/i })).toHaveCount(0);

  // Real chat input is present
  await expect(page.getByPlaceholder(/Chiedimi una ricetta/i)).toBeVisible();

  // Link to /cucina for AI recipes
  await page.getByRole('link', { name: /cucina e ricette ai/i }).click();
  await expect(page).toHaveURL('/cucina');
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();

  assertOfflineBackendClean(page);
});

test('actions remain reachable at 320px with 200% text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await installOfflineBackend(page);
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });

  // Chat input should be reachable
  const input = page.getByPlaceholder(/Chiedimi una ricetta/i);
  await input.scrollIntoViewIfNeeded();
  const uncovered = await input.evaluate((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return top === element || element.contains(top);
  });
  expect(uncovered).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  assertOfflineBackendClean(page);
});