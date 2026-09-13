import { expect, test } from '@playwright/test';

const isProductionTarget = process.env.E2E_PRODUCTION === 'true' && Boolean(process.env.E2E_BASE_URL?.trim());
const testEmail = process.env.E2E_TEST_EMAIL?.trim();
const testPassword = process.env.E2E_TEST_PASSWORD;

test.describe('production target smoke checks', () => {
  test.skip(!isProductionTarget, 'Skipped: set E2E_PRODUCTION=true and E2E_BASE_URL=https://... to run production smoke checks.');

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('serves the guest flow and keeps primary navigation reachable', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accedi o registrati' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accedi con Google' })).toBeVisible();

    await page.getByLabel('Ingredienti presenti').fill('pasta');
    await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
    await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Lista della spesa' }).click();
    await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    await page.getByRole('link', { name: 'Torna alla dispensa' }).click();

    await page.getByRole('link', { name: 'Attività' }).click();
    await expect(page.getByRole('heading', { name: 'La tua attività' })).toBeVisible();

    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Accedi per vedere il profilo' })).toBeVisible();
  });

  test('loads the disposable verified account boundary when credentials are supplied', async ({ page }) => {
    test.skip(testEmail === undefined || testPassword === undefined, 'Skipped: set E2E_TEST_EMAIL and E2E_TEST_PASSWORD for the disposable verified account check.');

    await page.goto('/');
    await page.getByRole('button', { name: 'Accedi o registrati' }).click();
    await page.getByLabel('Email').fill(testEmail!);
    await page.getByLabel('Password').fill(testPassword!);
    await page.getByRole('button', { name: 'Accedi al profilo' }).click();
    await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();

    await page.goto('/');
    await page.getByLabel('Ingredienti presenti').fill('pasta');
    await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
    await page.getByRole('link', { name: 'Apri il profilo' }).click();
    await page.getByRole('button', { name: 'Importa la dispensa' }).click();
    await expect(page.getByText('La tua dispensa è stata sincronizzata.')).toBeVisible();

    await page.goto('/');
    await page.getByLabel('Dieta').selectOption('vegetarian');
    await page.reload();
    await expect(page.getByLabel('Dieta')).toHaveValue('vegetarian');

    const aiPanel = page.getByRole('region', { name: 'Ricette AI private' });
    await expect(aiPanel.getByRole('checkbox', { name: /acconsento all’uso degli ingredienti/i })).toBeVisible();
    await expect(aiPanel.getByRole('button', { name: 'Genera ricetta AI' })).toHaveCount(0);
  });
});
