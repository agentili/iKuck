import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const validToken = 'secret-verification-token-1234567890';
const shortToken = 'short-token';

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('verifica email con token valido: conferma, successo e link al profilo', async ({ page }) => {
  let verifyCalled = false;

  await page.route('**/v1/auth/verify-email', async (route) => {
    const body = route.request().postDataJSON() as { token: string };
    expect(body.token).toBe(validToken);
    verifyCalled = true;
    await route.fulfill({ status: 200, json: { verified: true } });
  });

  await page.goto(`/verify-email?token=${validToken}`);

  await expect(page.getByRole('heading', { name: 'Conferma la tua email' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conferma email' })).toBeVisible();
  expect(verifyCalled).toBe(false);

  await page.getByRole('button', { name: 'Conferma email' }).click();

  await expect(page.getByRole('heading', { name: 'Email verificata' })).toBeVisible();
  await expect(page.getByText('Il tuo account A tavola è pronto per la sincronizzazione.')).toBeVisible();
  expect(verifyCalled).toBe(true);

  const link = page.getByRole('link', { name: 'Vai al tuo profilo' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/profile/);
});

test('verifica email con token scaduto o invalido: errore senza esporre il token', async ({ page }) => {
  let verifyCalled = false;

  await page.route('**/v1/auth/verify-email', async (route) => {
    verifyCalled = true;
    await route.fulfill({
      status: 400,
      json: { code: 'invalid_token', message: 'Invalid token' },
    });
  });

  await page.goto(`/verify-email?token=${validToken}`);

  await expect(page.getByRole('heading', { name: 'Conferma la tua email' })).toBeVisible();
  await page.getByRole('button', { name: 'Conferma email' }).click();

  await expect(page.getByRole('heading', { name: 'Link non valido' })).toBeVisible();
  await expect(page.getByText('Il link non è valido o è scaduto.')).toBeVisible();
  expect(verifyCalled).toBe(true);

  // Il token grezzo non deve mai apparire nel DOM
  await expect(page.locator(`text=${validToken}`)).toHaveCount(0);
});

test('verifica email con token troppo corto: errore immediato senza chiamare l API', async ({ page }) => {
  let verifyCalled = false;

  await page.route('**/v1/auth/verify-email', async (route) => {
    verifyCalled = true;
    await route.fulfill({ status: 400, json: { code: 'invalid_token' } });
  });

  await page.goto(`/verify-email?token=${shortToken}`);

  await expect(page.getByRole('heading', { name: 'Link non valido' })).toBeVisible();
  await expect(page.getByText('Il link non è valido o è scaduto.')).toBeVisible();
  expect(verifyCalled).toBe(false);

  await expect(page.locator(`text=${shortToken}`)).toHaveCount(0);
});
