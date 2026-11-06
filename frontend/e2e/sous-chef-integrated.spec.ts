import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.skip(process.env.VITE_SOUS_CHEF !== 'true', 'Sous-Chef build required');

const chefDestinations = [
  { label: 'Ricette', path: '/recipes' },
  { label: 'Dispensa', path: '/pantry' },
  { label: 'Spesa', path: '/shopping-list' },
  { label: 'Casa', path: '/house' },
  { label: 'Cucina viva', path: '/cucina' },
] as const;

test('Chef keeps the local recipe card and real destinations while AI chat is deferred', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');

  await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chef', exact: true })).toBeVisible();
  await expect(page.getByText('Chat AI non disponibile. La chat AI è stata rinviata.', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/Chiedimi una ricetta/i)).toHaveCount(0);
  await expect(page.getByRole('log')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Invia messaggio' })).toHaveCount(0);

  const shortcuts = page.getByRole('group', { name: 'Risposte rapide' });
  for (const destination of chefDestinations) {
    const link = shortcuts.getByRole('link', { name: destination.label, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', destination.path);
  }
  await shortcuts.getByRole('link', { name: 'Cucina viva', exact: true }).click();
  await expect(page).toHaveURL('/cucina');
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();

  assertOfflineBackendClean(page);
});

test('Chef destinations remain reachable at 320px with 200% text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await installOfflineBackend(page);
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });

  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(geometry.content, `horizontal overflow at 320px with 200% text: ${JSON.stringify(geometry)}`)
    .toBeLessThanOrEqual(geometry.viewport);
  const shortcuts = page.getByRole('group', { name: 'Risposte rapide' });
  const pantryLink = shortcuts.getByRole('link', { name: 'Dispensa', exact: true });
  await expect(pantryLink).toBeVisible();
  await pantryLink.click();
  await expect(page).toHaveURL('/pantry');
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();

  assertOfflineBackendClean(page);
});