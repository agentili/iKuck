import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

for (const theme of ['light', 'dark'] as const) {
  test(`lot editor and base ingredients fit 320px at 200% text (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 760 });
    await installOfflineBackend(page, { serviceWorkers: 'allow' });
    await page.goto('/pantry');
    await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
    if (await page.getByText('Inventario', { exact: true }).count() === 0) {
      test.skip(true, 'Sous-Chef build required');
    }
    await page.evaluate((selectedTheme) => {
      document.documentElement.style.fontSize = '200%';
      document.documentElement.dataset.theme = selectedTheme;
    }, theme);

    const fitsViewport = async () => page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(await fitsViewport()).toBe(true);

    await page.getByLabel('Ingredienti presenti').fill('pasta');
    await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
    await page.getByText('Personalizza la dispensa', { exact: true }).click();
    await page.getByText('Dettagli lotti', { exact: true }).click();
    await page.getByRole('button', { name: 'Aggiungi lotto' }).click();

    await page.getByLabel('Quantità del lotto').fill('320');
    await page.getByLabel('Unità di misura').selectOption('g');
    await page.getByLabel('Data di scadenza').fill('2099-09-20');
    const save = page.getByRole('button', { name: 'Salva dettagli' });
    await expect(save).toBeVisible();
    await save.click();
    await expect(page.getByText(/Totale: 320 g/)).toBeVisible();

    await page.getByText('Ingredienti di base', { exact: true }).click();
    const salt = page.getByRole('checkbox', { name: 'Sale' });
    await expect(salt).toBeVisible();
    const before = await salt.isChecked();
    await salt.click();
    await expect(salt).toBeChecked({ checked: !before });

    expect(await fitsViewport()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    assertOfflineBackendClean(page);
  });
}
