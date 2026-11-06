import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';
import { goToKitchen, kitchenHeading } from './helpers/appMode';

const evidence = '../design/ux-ui-proposal/evidence/screenshots';

test.beforeEach(async ({ page }) => {
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

const settleAndScreenshot = async (page: Page, name: string) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
};

const inspectTextLayout = async (locator: Locator, label: string) => {
  await expect(locator, `${label} must remain visible`).toBeVisible();
  const layout = await locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const words: Array<{ text: string; rects: Array<{ x: number; y: number; right: number; bottom: number }> }> = [];
    let node = walker.nextNode();

    while (node !== null) {
      const text = node.textContent ?? '';
      const matcher = /\S+/g;
      let match = matcher.exec(text);
      while (match !== null) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        words.push({
          text: match[0],
          rects: Array.from(range.getClientRects()).map((rect) => ({
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
          })),
        });
        match = matcher.exec(text);
      }
      node = walker.nextNode();
    }

    const rect = element.getBoundingClientRect();
    return {
      box: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom },
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowX: getComputedStyle(element).overflowX,
      overflowY: getComputedStyle(element).overflowY,
      words,
    };
  });

  expect(layout.words.filter((word) => word.rects.length !== 1), `${label} must not split words: ${JSON.stringify(layout)}`)
    .toEqual([]);
  if (layout.clientWidth > 0 && ['hidden', 'clip'].includes(layout.overflowX)) {
    expect(layout.scrollWidth, `${label} must not clip horizontally: ${JSON.stringify(layout)}`)
      .toBeLessThanOrEqual(layout.clientWidth + 1);
  }
  if (layout.clientHeight > 0 && ['hidden', 'clip'].includes(layout.overflowY)) {
    expect(layout.scrollHeight, `${label} must not clip vertically: ${JSON.stringify(layout)}`)
      .toBeLessThanOrEqual(layout.clientHeight + 1);
  }
  return layout;
};

const assertNoNavigationOverlap = (
  layout: Awaited<ReturnType<typeof inspectTextLayout>>,
  navigation: { x: number; y: number; width: number; height: number },
  label: string,
  viewportHeight: number,
) => {
  const overlaps = layout.box.x < navigation.x + navigation.width
    && layout.box.right > navigation.x
    && layout.box.y < navigation.y + navigation.height
    && layout.box.bottom > navigation.y;
  if (layout.box.y < viewportHeight && layout.box.bottom > 0) {
    expect(overlaps, `${label} overlaps bottom navigation: ${JSON.stringify({ content: layout.box, navigation })}`)
      .toBe(false);
  }
};

test('Cucina viva responsive geometry and visual evidence at required widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goToKitchen(page);
  await expect(page.getByRole('heading', { name: kitchenHeading })).toBeVisible();
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
  const viewportGeometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(searchBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(viewportGeometry.content, `horizontal overflow at 390px: ${JSON.stringify(viewportGeometry)}`)
    .toBeLessThanOrEqual(viewportGeometry.viewport);
  expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(navigationBox!.y - 16);
  measurements.push({ width: 390, height: 844, ...viewportGeometry, searchBottom: searchBox!.y + searchBox!.height, navigationTop: navigationBox!.y, gap: navigationBox!.y - (searchBox!.y + searchBox!.height) });
  await settleAndScreenshot(page, 'cucina-viva-390-populated');

  for (const width of [320, 768, 1280, 1440]) {
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

    if (width === 320) {
      const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
      const navigationBox = await navigation.boundingBox();
      expect(navigationBox).not.toBeNull();

      const ingredientLabels = page.locator('.ik-home-pantry-items > li > span.font-semibold');
      await expect(ingredientLabels).toHaveCount(3);
      const ingredientNames = await ingredientLabels.allTextContents();
      expect(ingredientNames).toContain('Pasta');
      expect(ingredientNames).toContain('Tonno');

      const readableContent: Array<[Locator, string]> = [
        [page.getByRole('heading', { name: kitchenHeading, exact: true }), 'page title'],
        [page.getByText('Aggiungi quello che hai, poi scegli cosa cucinare. La ricerca parte solo quando la avvii.', { exact: true }), 'intro description'],
        [page.getByText('Banco ingredienti', { exact: true }), 'pantry label'],
        [page.getByRole('button', { name: 'Aggiungi ingredienti', exact: true }).first(), 'add ingredients CTA'],
        [page.getByRole('link', { name: 'Apri tutta la dispensa', exact: true }), 'pantry link'],
        [page.getByRole('button', { name: 'Trova ricette', exact: true }), 'recipe search CTA'],
      ];
      ingredientLabels.evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ''));
      for (const [index, name] of ingredientNames.entries()) {
        readableContent.push([ingredientLabels.nth(index), `${name} ingredient label`]);
      }

      for (const [locator, label] of readableContent) {
        const layout = await inspectTextLayout(locator, label);
        assertNoNavigationOverlap(layout, navigationBox!, label, 700);
      }
      for (const label of ingredientNames) {
        await expect(page.getByRole('button', { name: `Rimuovi ${label}`, exact: true }))
          .toHaveAccessibleName(`Rimuovi ${label}`);
      }

      const addIngredients = page.getByRole('button', { name: 'Aggiungi ingredienti', exact: true }).first();
      await addIngredients.scrollIntoViewIfNeeded();
      const addBox = await addIngredients.boundingBox();
      const visibleNavigationBox = await navigation.boundingBox();
      expect(addBox).not.toBeNull();
      expect(visibleNavigationBox).not.toBeNull();
      expect(addBox!.y + addBox!.height, `add CTA must be above nav: ${JSON.stringify({ addBox, visibleNavigationBox })}`)
        .toBeLessThanOrEqual(visibleNavigationBox!.y - 4);
      const hitTargetIsButton = await addIngredients.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit === element || (hit !== null && element.contains(hit));
      });
      expect(hitTargetIsButton, 'the add CTA must be pointer-reachable above the fixed navigation').toBe(true);
      await addIngredients.click();
      const addDialog = page.getByRole('dialog', { name: 'Aggiungi ingredienti' });
      await expect(addDialog).toBeVisible();
      await addDialog.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno, passata');
      await addDialog.getByRole('button', { name: 'Aggiungi ingredienti', exact: true }).click();
      await expect(page.getByText('Pasta', { exact: true })).toBeVisible();

      await addIngredients.focus();
      await addIngredients.press('Enter');
      await expect(addDialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(addDialog).toBeHidden();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await settleAndScreenshot(page, `cucina-viva-${width}${width === 320 ? '-zoom200' : ''}`);
  }
  await writeFile(`${evidence}/responsive-geometry.json`, `${JSON.stringify(measurements, null, 2)}\n`, 'utf8');
});

test('Cucina viva remains readable in dark mode with reduced motion at 320×700/200%', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await goToKitchen(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
    window.scrollTo(0, 0);
  });

  const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
  const navigationBox = await navigation.boundingBox();
  expect(navigationBox).not.toBeNull();
  const criticalContent = [
    [page.getByRole('heading', { name: kitchenHeading, exact: true }), 'dark page title'],
    [page.getByText('Aggiungi quello che hai, poi scegli cosa cucinare. La ricerca parte solo quando la avvii.', { exact: true }), 'dark intro description'],
    [page.getByText('Banco ingredienti', { exact: true }), 'dark pantry label'],
    [page.getByRole('button', { name: 'Aggiungi ingredienti', exact: true }).first(), 'dark add ingredients CTA'],
    [page.getByRole('button', { name: 'Trova ricette', exact: true }), 'dark recipe search CTA'],
  ] as const;

  for (const [locator, label] of criticalContent) {
    const layout = await inspectTextLayout(locator, label);
    assertNoNavigationOverlap(layout, navigationBox!, label, 700);
  }
  const motionDuration = await page.getByRole('button', { name: 'Aggiungi ingredienti', exact: true }).first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(motionDuration.split(',').every((duration) => Number.parseFloat(duration) === 0),
    `reduced-motion must disable CTA transitions; got ${motionDuration}`).toBe(true);
});

test('il prompt di installazione PWA sta sopra la nav inferiore e non copre l’azione primaria (390×844)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goToKitchen(page);
  await expect(page.getByRole('heading', { name: kitchenHeading })).toBeVisible();

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
  expect(
    searchBox!.y + searchBox!.height,
    `primary action box ${JSON.stringify(searchBox)} overlaps install prompt ${JSON.stringify(bannerBox)}`,
  ).toBeLessThanOrEqual(bannerBox!.y + 1);
});
