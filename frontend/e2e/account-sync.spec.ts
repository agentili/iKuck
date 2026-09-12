import { expect, test, type Page } from '@playwright/test';

const verifiedUser = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

const clearLocalDatabase = async (page: Page) => {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('ikuck-local-v2');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  }));
};

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('guest pantry survives reload while the API is offline', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) => route.fulfill({
    status: 200,
    json: { authenticated: false },
  }));
  await page.goto('/');
  await clearLocalDatabase(page);
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

  await page.unroute('**/v1/auth/session');
  await page.route('**/v1/auth/session', (route) => route.abort());
  await page.reload();
  await expect(page.getByText('Tonno', { exact: true })).toBeVisible();
});

test('verified users explicitly import the local pantry into the account', async ({ page }) => {
  const syncRequests: Array<{ mutations: unknown[] }> = [];
  await page.route('**/v1/auth/session', (route) => route.fulfill({
    status: 200,
    json: {
      authenticated: true,
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    },
  }));
  await page.route('**/v1/profile', (route) => route.fulfill({
    status: 200,
    json: { profile: { displayName: null } },
  }));
  await page.route('**/v1/sync', async (route) => {
    const body = route.request().postDataJSON() as { mutations: unknown[] };
    syncRequests.push(body);
    await route.fulfill({ status: 200, json: { changes: [], nextCursor: 1 } });
  });

  await page.goto('/');
  await clearLocalDatabase(page);
  await page.reload();
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('link', { name: 'Apri il profilo' }).click();
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();

  await page.getByRole('button', { name: 'Importa la dispensa' }).click();
  await expect(page.getByText('La tua dispensa è stata sincronizzata.')).toBeVisible();
  expect(syncRequests.some(({ mutations }) => mutations.some((mutation) => (
    typeof mutation === 'object' && mutation !== null && 'entityId' in mutation && mutation.entityId === 'pasta'
  )))).toBe(true);
});

test('unverified login remains blocked with clear guidance', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) => route.fulfill({
    status: 200,
    json: { authenticated: false },
  }));
  await page.route('**/v1/auth/login', (route) => route.fulfill({
    status: 403,
    json: { code: 'email_not_verified', message: 'Email verification is required' },
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Accedi o registrati' }).click();
  await page.getByLabel('Email').fill('ale@example.com');
  await page.getByLabel('Password').fill('a long enough password');
  await page.getByRole('button', { name: 'Accedi al profilo' }).click();

  await expect(page.getByText('Devi verificare la tua email prima di accedere.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accedi o registrati' })).not.toBeVisible();
});
