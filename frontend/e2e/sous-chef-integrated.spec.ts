import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.skip(process.env.VITE_SOUS_CHEF !== 'true', 'Sous-Chef build required');

const chefDestinations = [
  { label: 'Piano settimanale', path: '/plan' },
  { label: 'Ricettario', path: '/recipes' },
  { label: 'Dispensa', path: '/pantry' },
  { label: 'Lista della spesa Bring', path: '/shopping-list' },
] as const;

test('Chef shows the local recipe card and current cooking destinations', async ({ page }) => {
  await installOfflineBackend(page);
  await page.goto('/');

  await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cosa cuciniamo oggi?', exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/Chiedimi una ricetta/i)).toHaveCount(0);
  await expect(page.getByRole('log')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Invia messaggio' })).toHaveCount(0);

  const shortcuts = page.getByRole('group', { name: 'Prosegui in cucina' });
  for (const destination of chefDestinations) {
    const link = shortcuts.getByRole('link', { name: new RegExp(destination.label) });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', destination.path);
  }
  await shortcuts.getByRole('link', { name: /Ricettario/ }).click();
  await expect(page).toHaveURL('/recipes');
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();

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
  const shortcuts = page.getByRole('group', { name: 'Prosegui in cucina' });
  const pantryLink = shortcuts.getByRole('link', { name: /Dispensa/ });
  await expect(pantryLink).toBeVisible();
  await pantryLink.click();
  await expect(page).toHaveURL('/pantry');
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();

  assertOfflineBackendClean(page);
});
