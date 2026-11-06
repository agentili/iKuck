import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.skip(process.env.VITE_SOUS_CHEF !== 'true', 'Sous-Chef build required');

test('pantry entry and keyboard inventory fit at 320px and 390px with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await installOfflineBackend(page, { serviceWorkers: 'allow' });
  await page.goto('/pantry');
  await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });

  const fitsViewport = async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await fitsViewport()).toBe(true);
  const add = page.getByRole('button', { name: 'Aggiungi ingredienti' });
  const [inputBox, addBox] = await Promise.all([
    page.getByLabel('Ingredienti presenti').boundingBox(), add.boundingBox(),
  ]);
  expect(inputBox).not.toBeNull();
  expect(addBox).not.toBeNull();
  expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(320);
  expect(addBox!.x + addBox!.width).toBeLessThanOrEqual(320);

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno');
  await add.click();
  const summary = page.locator('details').filter({ has: page.getByText('Inventario', { exact: true }) }).locator('summary');
  await expect(summary).toContainText('2 ingredienti');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).toHaveAttribute('open');
  await page.getByRole('list', { name: 'La tua dispensa' }).getByRole('button', { name: 'Rimuovi Tonno' }).click();
  await expect(summary).toContainText('1 ingrediente');
  expect(await fitsViewport()).toBe(true);
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(summary.locator('..')).not.toHaveAttribute('open');
  expect(await fitsViewport()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const entry = page.getByRole('region', { name: 'Aggiungi ingredienti' });
  expect(await entry.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const [wideInput, wideAdd] = await Promise.all([
    page.getByLabel('Ingredienti presenti').boundingBox(), add.boundingBox(),
  ]);
  expect(wideInput).not.toBeNull();
  expect(wideAdd).not.toBeNull();
  expect(wideInput!.x + wideInput!.width).toBeLessThanOrEqual(390);
  expect(wideAdd!.x + wideAdd!.width).toBeLessThanOrEqual(390);
  const optionalLines = await page.getByText('Facoltativo', { exact: true }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getClientRects().length;
  });
  expect(optionalLines).toBe(1);
  assertOfflineBackendClean(page);
});

test('long pantry ingredient labels remain readable beside removal at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await installOfflineBackend(page, { serviceWorkers: 'allow' });
  await page.goto('/pantry');
  await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const label = 'ingredientelunghissimosenzaspazi';
  await page.getByLabel('Ingredienti presenti').fill(label);
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByText('Inventario', { exact: true }).click();
  const list = page.getByRole('list', { name: 'La tua dispensa' });
  await expect(list.getByText(label, { exact: true })).toBeVisible();
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const [labelBox, removeBox] = await Promise.all([
    list.getByText(label, { exact: true }).boundingBox(),
    list.getByRole('button', { name: `Rimuovi ${label}` }).boundingBox(),
  ]);
  expect(labelBox).not.toBeNull();
  expect(removeBox).not.toBeNull();
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(removeBox!.x - 8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await list.getByRole('button', { name: `Rimuovi ${label}` }).click();
  await expect(list).toHaveCount(0);
  assertOfflineBackendClean(page);
});

test('guest pantry entry, inventory and lot survive offline reload', async ({ page, context }) => {
  await installOfflineBackend(page, { serviceWorkers: 'allow' });
  await page.goto('/pantry');
  await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
  await expect(page.locator('details').filter({ hasText: 'Inventario' }).first()).not.toHaveAttribute('open');
  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByText('Inventario', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  await page.getByRole('button', { name: 'Aggiungi lotto' }).click();
  await page.getByLabel('Quantità del lotto').fill('320');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByLabel('Data di scadenza').fill('2099-09-20');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();
  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await expect.poll(async () => page.evaluate(() => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('ikuck-local-v2');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('keyValue').objectStore('keyValue').get('pantry');
      request.onsuccess = () => { const value = String(request.result ?? ''); db.close(); resolve(value); };
      request.onerror = () => reject(request.error);
    };
  }))).toContain('320');
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Inventario', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  await expect(page.getByText(/Totale: 320 g/)).toBeVisible();
  await context.setOffline(false);
  assertOfflineBackendClean(page);
});

for (const { width, theme } of [
  { width: 320, theme: 'dark' },
  { width: 390, theme: 'light' },
] as const) {
  test(`pantry entry and inventory remain keyboard and pointer reachable at ${width}px/200% (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    // Registration is blocked for geometry checks; the separate guest test proves Workbox offline reload.
    await installOfflineBackend(page, { serviceWorkers: 'block' });
    await page.goto('/pantry');
    const input = page.getByLabel('Ingredienti presenti');
    await expect(input).toBeVisible();
    await page.evaluate((selectedTheme) => {
      document.documentElement.style.fontSize = '200%';
      document.documentElement.dataset.theme = selectedTheme;
    }, theme);
    await input.focus();
    await expect(input).toBeFocused();
    await input.fill('pasta');
    const add = page.getByRole('button', { name: 'Aggiungi ingredienti' });
    await add.click();
    const summary = page.locator('details > summary').filter({ hasText: 'Inventario' }).first();
    await expect(summary).toContainText('1 ingrediente');
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(summary.locator('..')).toHaveAttribute('open');
    await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
    for (const target of [add, summary]) {
      const geometry = await target.evaluate((element) => {
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          left: rect.left, right: rect.right, height: rect.height,
          hit: top === element || element.contains(top),
          width: document.documentElement.clientWidth,
          content: document.documentElement.scrollWidth,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      expect(geometry.hit).toBe(true);
      expect(geometry.content).toBeLessThanOrEqual(geometry.width);
    }
    assertOfflineBackendClean(page);
  });
}
