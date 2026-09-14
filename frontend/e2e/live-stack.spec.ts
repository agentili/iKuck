import { expect, test } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('registers, verifies, logs in, synchronizes and logs out against the live stack', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = process.env.E2E_TEST_PASSWORD?.trim() || 'e2e-password-2026';
  const verificationToken = process.env.E2E_VERIFICATION_TOKEN?.trim();

  await page.goto('/');
  await page.getByRole('button', { name: 'Accedi o registrati' }).click();
  await page.getByRole('button', { name: 'Registrati' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Crea account' }).click();

  const registrationStatus = page.getByRole('status');
  await expect(registrationStatus).toBeVisible();
  if (verificationToken !== undefined) {
    await expect(registrationStatus).toHaveText('Controlla la tua email per verificare l’account.');
    await page.goto(`/verify-email?token=${encodeURIComponent(verificationToken)}`);
    await page.getByRole('button', { name: 'Conferma email' }).click();
    await expect(page.getByRole('heading', { name: 'Email verificata' })).toBeVisible();
    await page.getByRole('link', { name: 'Vai al tuo profilo' }).click();
  } else {
    await expect(registrationStatus).toHaveText('Account creato. Ora puoi accedere.');
    await page.getByRole('button', { name: 'Accedi' }).click();
  }

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al profilo' }).click();
  await expect(page.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();

  await page.goto('/');
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('link', { name: 'Apri il profilo' }).click();
  await page.getByRole('button', { name: 'Importa i dati locali' }).click();
  await page.getByRole('button', { name: 'Conferma importazione' }).click();
  await expect(page.getByText(/Sincronizzazione completata/)).toBeVisible();

  await page.getByRole('button', { name: 'Esci' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Accedi o registrati' })).toBeVisible();
});
