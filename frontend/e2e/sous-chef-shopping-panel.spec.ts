import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

async function expectShoppingFits(page: Page) {
  const geometry = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  for (const control of await page.locator('main form input, main form select, main form button, main form summary, main li button, main section[aria-labelledby="shopping-purchased-title"] > button').all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(box?.height, await control.getAttribute('aria-label') ?? await control.textContent() ?? '').toBeGreaterThanOrEqual(44);
  }
}

async function readGuestShoppingItems(page: Page): Promise<Array<{ id: string; label: string; purchased: boolean }>> {
  const raw = await page.evaluate(() => new Promise<string | null>((resolve, reject) => {
    const opening = indexedDB.open('ikuck-local-v2');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const request = database.transaction('keyValue').objectStore('keyValue').get('shopping-list');
      request.onerror = () => { database.close(); reject(request.error); };
      request.onsuccess = () => {
        database.close();
        resolve(typeof request.result === 'string' ? request.result : null);
      };
    };
  }));
  if (raw === null) return [];
  return (JSON.parse(raw) as { items: Array<{ id: string; label: string; purchased: boolean }> }).items;
}

test('keyboard undo restores a purchased item while its section stays collapsed (guest offline)', async ({ page }) => {
  await installOfflineBackend(page, { serviceWorkers: 'allow' });
  await page.goto('/shopping-list');
  await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
  const entry = page.getByRole('form', { name: 'Aggiungi un prodotto' });
  await entry.getByLabel('Cosa ti serve?').fill('Uova');
  await entry.getByRole('button', { name: 'Aggiungi alla lista' }).click();
  const toggle = page.getByRole('button', { name: 'Segna Uova come acquistato' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Segna Uova come da acquistare' })).toBeFocused();
  await expect.poll(async () => (await readGuestShoppingItems(page)).find((item) => item.label === 'Uova')?.purchased).toBe(true);
  const original = (await readGuestShoppingItems(page)).find((item) => item.label === 'Uova');
  expect(original?.id).toBeTruthy();

  await page.getByRole('button', { name: 'Nascondi acquistati' }).click();
  const clear = page.getByRole('button', { name: 'Rimuovi gli acquistati' });
  await clear.focus();
  await page.keyboard.press('Enter');
  const undo = page.getByRole('button', { name: 'Annulla', exact: true });
  await expect(undo).toBeFocused();
  await expect.poll(async () => (await readGuestShoppingItems(page)).some((item) => item.id === original?.id)).toBe(false);
  await page.keyboard.press('Enter');

  const disclosure = page.getByRole('button', { name: 'Mostra acquistati' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(disclosure).toBeFocused();
  await expect(page.getByRole('button', { name: 'Segna Uova come da acquistare' })).toHaveCount(0);
  await expect.poll(async () => (await readGuestShoppingItems(page)).find((item) => item.label === 'Uova')).toEqual(original);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Segna Uova come da acquistare' })).toBeVisible();
  assertOfflineBackendClean(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`shopping entry, edit, purchased and undo fit 320px at 200% (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 760 });
    await installOfflineBackend(page, { serviceWorkers: 'allow' });
    await page.goto('/shopping-list');
    await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    await page.evaluate((selectedTheme) => {
      document.documentElement.style.fontSize = '200%';
      document.documentElement.dataset.theme = selectedTheme;
    }, theme);

    const entry = page.getByRole('form', { name: 'Aggiungi un prodotto' });
    await expect(entry).toBeVisible();
    await entry.getByLabel('Cosa ti serve?').fill('Caffè macinato extra lungo per colazione');
    await entry.getByText('Aggiungi dettagli (facoltativi)').click();
    await entry.getByLabel('Quantità da acquistare').fill('2');
    await entry.getByLabel('Unità di misura della spesa').selectOption('pack');
    await entry.getByLabel('Nota (facoltativa)').fill('Senza caffeina');
    await expectShoppingFits(page);
    await entry.getByRole('button', { name: 'Aggiungi alla lista' }).click();
    await expect(page.getByRole('status', { name: 'Stato della lista' })).toContainText('Aggiunto alla lista.');

    const row = page.locator('li[data-state="pending"]').filter({ hasText: 'Caffè macinato extra lungo per colazione' });
    await expect(row).toContainText('2 confezioni');
    await expect(row).toContainText('Senza caffeina');
    await row.getByRole('button', { name: /Modifica/ }).click();
    await expect(row.getByRole('textbox', { name: 'Nome' })).toBeFocused();
    await row.getByRole('button', { name: 'Annulla modifiche' }).click();
    await expect(row.getByRole('button', { name: /Modifica/ })).toBeFocused();
    await expectShoppingFits(page);

    await row.getByRole('button', { name: /Segna .* come acquistato/ }).click();
    const purchased = page.locator('li[data-state="purchased"]').filter({ hasText: 'Caffè macinato extra lungo per colazione' });
    await expect(purchased).toBeVisible();
    await expectShoppingFits(page);
    await purchased.getByRole('button', { name: /Rimuovi/ }).click();
    const undo = page.getByRole('button', { name: 'Annulla', exact: true });
    await expect(undo).toBeVisible();
    await expect(undo).toBeFocused();
    expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const [toastBounds, navBounds] = await Promise.all([
      undo.locator('..').boundingBox(),
      page.getByRole('navigation', { name: 'Navigazione principale' }).boundingBox(),
    ]);
    expect(toastBounds).not.toBeNull();
    expect(navBounds).not.toBeNull();
    expect(toastBounds!.y + toastBounds!.height).toBeLessThanOrEqual(navBounds!.y);
    await undo.click();
    await expect(page.locator('li[data-state="purchased"]').filter({ hasText: 'Caffè macinato extra lungo per colazione' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Segna Caffè macinato.*come da acquistare/ })).toBeFocused();

    await entry.getByLabel('Cosa ti serve?').fill('Uova');
    await entry.getByRole('button', { name: 'Aggiungi alla lista' }).click();
    await page.getByRole('button', { name: 'Nascondi acquistati' }).click();
    const pendingToggle = page.getByRole('button', { name: 'Segna Uova come acquistato' });
    await pendingToggle.focus();
    await pendingToggle.press('Enter');
    await expect(page.getByRole('button', { name: 'Mostra acquistati' })).toBeFocused();
    await expectShoppingFits(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Mostra acquistati' }).click();
    await page.getByRole('button', { name: 'Modifica Uova' }).click();
    await expectShoppingFits(page);
    assertOfflineBackendClean(page);
  });
}
