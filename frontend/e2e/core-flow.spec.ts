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

test('the core flow works at 320px using only the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Ingredienti presenti')).toBeFocused();
  await page.keyboard.type('pasta, tonno, passata');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Passata di pomodoro', { exact: true })).toBeVisible();

  const searchButton = page.getByRole('button', { name: 'Trova ricette' });
  for (let step = 0; step < 60; step += 1) {
    if (await searchButton.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(searchButton).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test('suggested ingredients can be added without typing', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  const suggestions = page.getByRole('region', { name: 'Potresti aggiungere' });
  await expect(suggestions.getByRole('button', { name: 'Aggiungi Cipolla' })).toBeVisible();
  await suggestions.getByRole('button', { name: 'Aggiungi Cipolla' }).click();

  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Cipolla')).toBeVisible();
  await expect(suggestions.getByRole('button', { name: 'Aggiungi Cipolla' })).toHaveCount(0);
});

test('manifest is available and the application works offline after first load', async ({ page, context }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/iKuck/);

  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('iKuck');
  expect(manifest.start_url).toBe('/');

  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
  await context.setOffline(false);
});
