import { expect, test } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('user adds pantry items, requests recipes and opens one', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  await expect(page.getByText('Hai tutto').first()).toBeVisible();
  await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  await expect(page.getByRole('heading', { name: 'Ingredienti' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
});

test('pantry survives reload and extended mode names one missing ingredient', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta, uova, pancetta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.reload();
  await expect(page.getByText('Pancetta', { exact: true })).toBeVisible();
  await page.getByLabel('Anche con 1 ingrediente in più').check();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText('Ti manca solo: Parmigiano')).toBeVisible();
});

test('manifest is available and the application works offline after first load', async ({ page, context }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/iRicetto/);

  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('iRicetto');
  expect(manifest.start_url).toBe('/');

  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
  await context.setOffline(false);
});
