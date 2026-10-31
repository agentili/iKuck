import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.skip(process.env.VITE_SOUS_CHEF !== 'true', 'Sous-Chef build required');

test('guest pantry entry, inventory and lot survive offline reload', async ({ page, context }) => {
  await installOfflineBackend(page, { serviceWorkers: 'allow' });
  await page.goto('/pantry');
  await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
  await expect(page.locator('details').filter({ hasText: 'Inventario' }).first()).not.toHaveAttribute('open');
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByText('Inventario', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  await page.getByRole('button', { name: 'Aggiungi lotto' }).click();
  await page.getByLabel('Quantità del lotto').fill('320');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByLabel('Data di scadenza').fill('2099-09-20');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();
  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await expect.poll(async () => page.evaluate(() => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('ikuck-local-v2');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('keyValue').objectStore('keyValue').get('pantry');
      request.onsuccess = () => { const value = String(request.result ?? ''); db.close(); resolve(value); };
      request.onerror = () => reject(request.error);
    };
  }))).toContain('320');
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Inventario', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await context.setOffline(false);
  assertOfflineBackendClean(page);
});
