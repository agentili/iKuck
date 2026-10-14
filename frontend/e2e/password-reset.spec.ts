import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const resetToken = 'reset-token-12345678901234567890123456789012';

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('forgot-password page loads and submits email successfully', async ({ page }) => {
  let resetRequested = false;
  let requestBody: unknown = null;

  await page.route('**/v1/auth/request-password-reset', async (route) => {
    const body = route.request().postDataJSON() as { email: string };
    requestBody = body;
    resetRequested = true;
    await route.fulfill({ status: 202, json: {} });
  });

  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: 'Recupera la password' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();

  await page.getByLabel('Email').fill('test@example.com');
  await page.getByRole('button', { name: 'Invia link di recupero' }).click();

  await expect(page.getByRole('heading', { name: 'Controlla la tua email' })).toBeVisible();
  expect(resetRequested).toBe(true);
  expect(requestBody).toEqual({ email: 'test@example.com' });
});

test('forgot-password shows error on network failure', async ({ page }) => {
  await page.route('**/v1/auth/request-password-reset', async (route) => {
    await route.abort('failed');
  });

  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill('test@example.com');
  await page.getByRole('button', { name: 'Invia link di recupero' }).click();

  await expect(page.getByRole('alert')).toHaveText('Servizio non raggiungibile. Riprova quando torni online.');
});

test('forgot-password shows error on rate limit', async ({ page }) => {
  await page.route('**/v1/auth/request-password-reset', async (route) => {
    await route.fulfill({ status: 429, json: { code: 'rate_limited', message: 'Rate limited' } });
  });

  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill('test@example.com');
  await page.getByRole('button', { name: 'Invia link di recupero' }).click();

  await expect(page.getByRole('alert')).toHaveText('Troppi tentativi. Attendi qualche minuto prima di riprovare.');
});

test('reset-password page loads with token from URL', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto(`/reset-password?token=${resetToken}`);
  await expect(page.getByRole('heading', { name: 'Reimposta la password' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Nuova password', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Conferma nuova password', exact: true })).toBeVisible();
});

test('reset-password shows error when token is missing', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto('/reset-password');
  await expect(page.getByRole('alert')).toHaveText('Il link non è valido o è scaduto.');
});

test('reset-password shows error when token is too short', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto('/reset-password?token=short');
  await expect(page.getByRole('alert')).toHaveText('Il link non è valido o è scaduto.');
});

test('reset-password rejects mismatched passwords before calling API', async ({ page }) => {
  let resetCalled = false;
  await page.route('**/v1/auth/reset-password', async (route) => {
    resetCalled = true;
    await route.fulfill({ status: 200, json: {} });
  });

  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto(`/reset-password?token=${resetToken}`);
  await page.getByRole('textbox', { name: 'Nuova password', exact: true }).fill('newPassword123');
  await page.getByRole('textbox', { name: 'Conferma nuova password', exact: true }).fill('differentPassword456');
  await page.getByRole('button', { name: 'Salva nuova password' }).click();

  await expect(page.getByRole('alert')).toHaveText('Le password non coincidono.');
  expect(resetCalled).toBe(false);
});

test('reset-password submits successfully and redirects to login', async ({ page }) => {
  let resetCalled = false;
  let requestBody: unknown = null;

  await page.route('**/v1/auth/reset-password', async (route) => {
    const body = route.request().postDataJSON() as { token: string; password: string };
    requestBody = body;
    resetCalled = true;
    await route.fulfill({ status: 200, json: {} });
  });

  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto(`/reset-password?token=${resetToken}`);
  await page.getByRole('textbox', { name: 'Nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('textbox', { name: 'Conferma nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('button', { name: 'Salva nuova password' }).click();

  await expect(page.getByRole('heading', { name: 'Password aggiornata' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Torna all\u2019accesso' })).toBeVisible();
  expect(resetCalled).toBe(true);
  expect(requestBody).toEqual({ token: resetToken, password: 'newSecurePassword123' });
});

test('reset-password shows error on invalid token from API', async ({ page }) => {
  await page.route('**/v1/auth/reset-password', async (route) => {
    await route.fulfill({ status: 400, json: { code: 'invalid_token', message: 'Invalid token' } });
  });

  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto(`/reset-password?token=${resetToken}`);
  await page.getByRole('textbox', { name: 'Nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('textbox', { name: 'Conferma nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('button', { name: 'Salva nuova password' }).click();

  await expect(page.getByRole('alert')).toHaveText('Il link non è valido o è scaduto.');
});

test('reset-password shows error on network failure during reset', async ({ page }) => {
  await page.route('**/v1/auth/reset-password', async (route) => {
    await route.abort('failed');
  });

  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto(`/reset-password?token=${resetToken}`);
  await page.getByRole('textbox', { name: 'Nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('textbox', { name: 'Conferma nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('button', { name: 'Salva nuova password' }).click();

  await expect(page.getByRole('alert')).toHaveText('Servizio non raggiungibile. Riprova quando torni online.');
});

test('reset-password shows error on password too short from API', async ({ page }) => {
  await page.route('**/v1/auth/reset-password', async (route) => {
    await route.fulfill({ status: 400, json: { code: 'password_too_short', message: 'Password too short' } });
  });

  await page.route('**/v1/auth/session', (route) => route.fulfill({ status: 200, json: { authenticated: false } }));

  await page.goto(`/reset-password?token=${resetToken}`);
  await page.getByRole('textbox', { name: 'Nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('textbox', { name: 'Conferma nuova password', exact: true }).fill('newSecurePassword123');
  await page.getByRole('button', { name: 'Salva nuova password' }).click();

  await expect(page.getByRole('alert')).toHaveText('La password deve avere almeno 12 caratteri.');
});