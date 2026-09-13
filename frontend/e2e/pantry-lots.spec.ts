import { expect, test } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('adds and retains optional lot quantity and expiry details', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => indexedDB.deleteDatabase('ikuck-local-v2'));
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('button', { name: 'Aggiungi lotto' }).click();
  await page.getByLabel('Quantità del lotto').fill('320');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByLabel('Data di scadenza').fill('2026-09-20');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();

  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await expect(page.getByText(/Scade il|Scade presto/).first()).toBeVisible();

  await page.reload();
  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await expect(page.getByText(/2026|20 set/).first()).toBeVisible();
});
