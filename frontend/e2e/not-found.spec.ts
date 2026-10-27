import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('pagina 404 per percorso inesistente mostra messaggio e link alla home', async ({ page }) => {
  await page.goto('/percorso-inesistente');

  await expect(page.getByRole('heading', { name: 'Pagina non trovata' })).toBeVisible();
  await expect(
    page.getByText('L’indirizzo richiesto non corrisponde a una pagina disponibile.')
  ).toBeVisible();

  const link = page.getByRole('link', { name: 'Torna alla home' });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
});
