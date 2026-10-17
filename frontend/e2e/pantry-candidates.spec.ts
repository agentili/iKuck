import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('l’inbox «Da confermare» non è disponibile per gli ospiti e non chiama l’API', async ({ page }) => {
  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Da confermare' })).toHaveCount(0);
});

test('un utente verificato con una Casa recupera i candidati con una sola chiamata API', async ({ page }) => {
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': {
        status: 200,
        json: {
          authenticated: true,
          user: { id: 'user-1', email: 'ale@example.com', emailVerifiedAt: '2026-09-12T10:00:00.000Z' },
          csrfToken: 'csrf-1',
          expiresAt: '2026-10-12T12:00:00.000Z',
        },
      },
      'GET /v1/house': {
        status: 200,
        json: {
          house: { id: 'house-a', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
          membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' },
          members: [],
        },
      },
      'GET /v1/pantry/candidates': {
        status: 200,
        json: {
          candidates: [
            {
              id: 'c-1',
              label: 'Latte',
              rawLabel: 'Latte',
              normalizedLabel: 'latte',
              specification: '1 l',
              listName: 'Spesa',
              checkedOffAt: '2026-01-15T10:00:00.000Z',
              detectedAt: '2026-01-15T10:00:00.000Z',
              expiresAt: '2026-02-14T10:00:00.000Z',
              status: 'pending',
            },
          ],
        },
      },
      'POST /v1/sync': {
        status: 200,
        json: { uploaded: 0, downloaded: 0, pending: 0, complete: true },
      },
    },
  });

  await page.goto('/pantry');
  // Attende che il bootstrap della Casa sia completato e l'inbox sia renderizzata.
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Da confermare' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Seleziona Latte' })).toBeVisible();
  await expect(page.getByText('1 l')).toBeVisible();
});
