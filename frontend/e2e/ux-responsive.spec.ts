import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const settleAndScreenshot = async (page: Page, testInfo: TestInfo, name: string, fullPage = true) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage });
  await testInfo.attach(name, { path, contentType: 'image/png' });
};

const populateHome = async (page: Page) => {
  await page.getByRole('link', { name: 'Aggiungi un ingrediente' }).click();
  await page.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Cucina', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'L’idea di oggi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trova ricette' })).toHaveCount(0);
};

test.beforeEach(async ({ page }) => { await installOfflineBackend(page); });
test.afterEach(async ({ page }) => { assertOfflineBackendClean(page); });

test('automatic Home ideas remain usable at required widths and 200% text', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  await expect(page.locator('.hero-art')).toBeHidden();
  await settleAndScreenshot(page, testInfo, 'a-tavola-390-empty');
  await populateHome(page);
  const [recipeBox, navigationBox, headerBox] = await Promise.all([
    page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).boundingBox(),
    page.getByRole('navigation', { name: 'Navigazione principale' }).boundingBox(),
    page.getByRole('banner').boundingBox(),
  ]);
  const initialGeometry = { recipe: recipeBox, navigation: navigationBox, header: headerBox, scrollY: await page.evaluate(() => window.scrollY) };
  await testInfo.attach('initial-home-geometry', { body: JSON.stringify(initialGeometry, null, 2), contentType: 'application/json' });
  await settleAndScreenshot(page, testInfo, 'a-tavola-390-first-viewport', false);
  expect(recipeBox, JSON.stringify(initialGeometry)).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(initialGeometry.scrollY).toBe(0);
  expect(recipeBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  expect(recipeBox!.y + recipeBox!.height, JSON.stringify(initialGeometry)).toBeLessThanOrEqual(navigationBox!.y);
  await settleAndScreenshot(page, testInfo, 'a-tavola-390-populated');

  const measurements: object[] = [];
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 700 : 900 });
    await page.evaluate((zoom) => { document.documentElement.style.fontSize = zoom ? '200%' : ''; }, width === 320);
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      nav: document.querySelector('nav[aria-label="Navigazione principale"]')?.getBoundingClientRect().toJSON() ?? null,
      main: document.querySelector('main#main-content')?.getBoundingClientRect().toJSON() ?? null,
    }));
    measurements.push({ width, rootFontSize: width === 320 ? '200%' : '100%', ...geometry });
    expect(geometry.content, `horizontal overflow at ${width}px: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.nav).not.toBeNull();
    expect(geometry.main).not.toBeNull();
    await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();
    if (width < 768) await expect(page.locator('.hero-art')).toBeHidden();
    if (width === 320) {
      const wordGeometry = await page.getByRole('heading', { name: 'Cosa portiamo a tavola?' }).evaluate((heading) => {
        const word = 'portiamo';
        const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node !== null) {
          const start = node.textContent?.indexOf(word) ?? -1;
          if (start >= 0) {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + word.length);
            return { word, rects: Array.from(range.getClientRects(), (rect) => rect.toJSON()) };
          }
          node = walker.nextNode();
        }
        return { word, rects: [] };
      });
      await testInfo.attach('home-title-word-320-zoom200', { body: JSON.stringify(wordGeometry, null, 2), contentType: 'application/json' });
      expect(wordGeometry.rects, `Home title splits the word portiamo: ${JSON.stringify(wordGeometry)}`).toHaveLength(1);
      const metadata = await page.getByRole('article', { name: 'Pasta tonno e pomodoro' }).locator('dl').evaluate((list) => ({
        bounds: list.getBoundingClientRect().toJSON(),
        items: Array.from(list.querySelectorAll('dd')).map((item) => ({ label: item.textContent?.trim() ?? '', bounds: item.getBoundingClientRect().toJSON() })),
      }));
      await testInfo.attach('recipe-metadata-320-zoom200', { body: JSON.stringify(metadata, null, 2), contentType: 'application/json' });
      expect(metadata.items).toHaveLength(3);
      for (const [index, item] of metadata.items.entries()) {
        expect(item.bounds.left, JSON.stringify(metadata)).toBeGreaterThanOrEqual(metadata.bounds.left);
        expect(item.bounds.right, JSON.stringify(metadata)).toBeLessThanOrEqual(metadata.bounds.right + 1);
        for (const other of metadata.items.slice(index + 1)) {
          const overlapWidth = Math.min(item.bounds.right, other.bounds.right) - Math.max(item.bounds.left, other.bounds.left);
          const overlapHeight = Math.min(item.bounds.bottom, other.bounds.bottom) - Math.max(item.bounds.top, other.bounds.top);
          expect(overlapWidth <= 0 || overlapHeight <= 0, `metadata overlaps: ${JSON.stringify({ item, other })}`).toBe(true);
        }
      }
    }
    await settleAndScreenshot(page, testInfo, `a-tavola-${width}${width === 320 ? '-zoom200' : ''}`);
  }
  await testInfo.attach('responsive-geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('PWA install prompt stays above mobile navigation and leaves the pantry action reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  await populateHome(page);

  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true, bubbles: true });
    Object.defineProperty(event, 'prompt', { value: () => Promise.resolve(), configurable: true });
    Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: 'dismissed' }), configurable: true });
    window.dispatchEvent(event);
  });

  const banner = page.getByRole('complementary', { name: 'Installa l’applicazione A tavola' });
  await expect(banner).toBeVisible();
  const bannerBox = await banner.boundingBox();
  const navBox = await page.getByRole('navigation', { name: 'Navigazione principale' }).boundingBox();
  expect(bannerBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
  expect(bannerBox!.x).toBeGreaterThanOrEqual(14);
  expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(390 - 14);
  const action = page.getByRole('region', { name: 'L’idea di oggi' }).getByRole('link', { name: '3 ingredienti in dispensa' });
  await action.scrollIntoViewIfNeeded();
  await action.click();
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
});
