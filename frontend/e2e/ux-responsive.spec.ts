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

test('il prompt di installazione PWA sta sopra la nav inferiore e non copre l’azione primaria (390×844)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();

  const quickAdd = page.getByRole('button', { name: 'Aggiungi ingredienti' });
  await quickAdd.click();
  const dialog = page.getByRole('dialog', { name: 'Aggiungi ingredienti' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, pomodoro');
  await dialog.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

  const search = page.getByRole('button', { name: 'Trova ricette' });
  await search.click();
  await expect(page.getByRole('heading', { name: 'Ricette per te' })).toBeVisible();

  // beforeinstallprompt non viene inviato in headless: lo si simula per rendere il banner.
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true, bubbles: true });
    Object.defineProperty(event, 'prompt', { value: () => Promise.resolve(), configurable: true });
    Object.defineProperty(event, 'userChoice', {
      value: Promise.resolve({ outcome: 'dismissed' }),
      configurable: true,
    });
    window.dispatchEvent(event);
  });

  const banner = page.getByRole('complementary', {
    name: 'Installa l’applicazione iKuck',
  });
  await expect(banner).toBeVisible();

  const bannerBox = await banner.boundingBox();
  const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
  const navBox = await navigation.boundingBox();
  const searchBox = await search.boundingBox();
  expect(bannerBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(searchBox).not.toBeNull();

  // Ancorato sopra la barra di navigazione inferiore: bottom = nav-height + safe-area-inset-bottom.
  expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  // Larghezza piena con margini laterali sul viewport da 390px.
  expect(bannerBox!.x).toBeGreaterThanOrEqual(14);
  expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(390 - 14);
  // Non copre il bottone primario dell’action panel.
  expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(bannerBox!.y + 1);
});
