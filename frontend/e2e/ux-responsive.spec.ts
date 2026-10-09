import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const evidence = '../design/ux-ui-proposal/evidence/screenshots';

const settleAndScreenshot = async (page: Page, name: string) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
};

test('Cucina viva responsive geometry and visual evidence at required widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
  await settleAndScreenshot(page, 'cucina-viva-390-empty');

  const quickAdd = page.getByRole('button', { name: 'Aggiungi ingredienti' });
  await quickAdd.click();
  const dialog = page.getByRole('dialog', { name: 'Aggiungi ingredienti' });
  await expect(dialog).toBeVisible();
  await settleAndScreenshot(page, 'cucina-viva-390-dialog');
  await dialog.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno, passata');
  await dialog.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

  const search = page.getByRole('button', { name: 'Trova ricette' });
  const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
  const measurements: object[] = [];
  const [searchBox, navigationBox] = await Promise.all([search.boundingBox(), navigation.boundingBox()]);
  expect(searchBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(navigationBox!.y - 16);
  measurements.push({ width: 390, height: 844, searchBottom: searchBox!.y + searchBox!.height, navigationTop: navigationBox!.y, gap: navigationBox!.y - (searchBox!.y + searchBox!.height) });
  await settleAndScreenshot(page, 'cucina-viva-390-populated');

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 700 : 900 });
    await page.evaluate((zoom) => { document.documentElement.style.fontSize = zoom ? '200%' : ''; }, width === 320);
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      nav: document.querySelector('nav[aria-label="Navigazione principale"]')?.getBoundingClientRect().toJSON() ?? null,
      main: document.querySelector('main#main-content')?.getBoundingClientRect().toJSON() ?? null,
    }));
    measurements.push({ width, height: width === 320 ? 700 : 900, rootFontSize: width === 320 ? '200%' : '100%', ...geometry });
    expect(geometry.content, `horizontal overflow at ${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.nav).not.toBeNull();
    expect(geometry.main).not.toBeNull();
    await settleAndScreenshot(page, `cucina-viva-${width}${width === 320 ? '-zoom200' : ''}`);
  }
  await writeFile(`${evidence}/responsive-geometry.json`, `${JSON.stringify(measurements, null, 2)}\n`, 'utf8');
});
