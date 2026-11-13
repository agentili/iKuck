import { expect, test } from '@playwright/test';
import {
  assertOfflineBackendClean,
  installOfflineBackend,
} from './helpers/backendMode';

const mobileNavigationLabel = 'Navigazione principale';

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('tastiera: ricerca locale e filtro Pesce mostrano risultati e stato selezionato', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 727 });
  await page.goto('/discover');

  await expect(page.getByRole('heading', { name: 'Cerca ricette', exact: true })).toBeVisible();
  const catalog = page.getByRole('region', { name: 'Ricette', exact: true });
  const search = page.getByRole('searchbox', { name: 'Cerca ricette' });
  await search.focus();
  await search.pressSequentially('limone');

  await expect(catalog.getByRole('heading', { name: 'Pollo al limone' })).toBeVisible();
  await expect(catalog.getByRole('heading', { name: 'Polpette al pomodoro' })).toHaveCount(0);

  await search.press('Control+A');
  await search.press('Backspace');
  const fishFilter = page.getByRole('button', { name: 'Pesce', exact: true });
  await fishFilter.focus();
  await fishFilter.press('Space');

  await expect(fishFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Tutte', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(catalog.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  await expect(catalog.getByRole('heading', { name: 'Pollo al limone' })).toHaveCount(0);
});

test('puntatore: ricerca locale e filtro Pesce mostrano risultati e stato selezionato', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 727 });
  await page.goto('/discover');

  await expect(page.getByRole('heading', { name: 'Cerca ricette', exact: true })).toBeVisible();
  const catalog = page.getByRole('region', { name: 'Ricette', exact: true });
  const search = page.getByRole('searchbox', { name: 'Cerca ricette' });
  await search.click();
  await search.fill('tonno');

  await expect(catalog.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  await expect(catalog.getByRole('heading', { name: 'Pollo al limone' })).toHaveCount(0);

  const fishFilter = page.getByRole('button', { name: 'Pesce', exact: true });
  await fishFilter.click();
  await expect(fishFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(catalog.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  await expect(catalog.getByRole('heading', { name: 'Pollo al limone' })).toHaveCount(0);
});

for (const viewport of [
  { name: '320px con testo al 200%', width: 320, height: 700, zoomText: true },
  { name: 'Pixel 5 a 393px', width: 393, height: 727, zoomText: false },
]) {
  test(`layout Discover: contenuto finale non coperto e nessun overflow a ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/discover');
    await expect(page.getByRole('heading', { name: 'Cerca ricette', exact: true })).toBeVisible();
    const catalog = page.getByRole('region', { name: 'Ricette', exact: true });
    const finalRecipeLink = catalog.getByRole('link').last();
    await expect(finalRecipeLink).toBeVisible();

    if (viewport.zoomText) {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
    }

    const navigation = page.getByRole('navigation', { name: mobileNavigationLabel });
    await expect(navigation).toBeVisible();
    await finalRecipeLink.scrollIntoViewIfNeeded();

    const geometry = await finalRecipeLink.evaluate((link) => {
      const navigationElement = document.querySelector<HTMLElement>(
        'nav[aria-label="Navigazione principale"]',
      );
      if (navigationElement === null) return null;

      const navigationBox = navigationElement.getBoundingClientRect();
      const linkBox = link.getBoundingClientRect();
      const centerX = Math.min(window.innerWidth - 1, Math.max(0, linkBox.left + linkBox.width / 2));
      const centerY = Math.min(window.innerHeight - 1, Math.max(0, linkBox.top + linkBox.height / 2));
      const elementAtCenter = document.elementFromPoint(centerX, centerY);

      return {
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        viewportHeight: window.innerHeight,
        navigationPosition: window.getComputedStyle(navigationElement).position,
        navigationTop: navigationBox.top,
        navigationBottom: navigationBox.bottom,
        linkTop: linkBox.top,
        linkBottom: linkBox.bottom,
        linkCenterCoveredByNavigation: elementAtCenter !== null && elementAtCenter.closest(
          'nav[aria-label="Navigazione principale"]',
        ) !== null,
      };
    });

    expect(geometry, 'geometria della navigazione e del contenuto finale disponibile').not.toBeNull();
    expect(geometry!.viewportWidth).toBe(viewport.width);
    expect(geometry!.contentWidth, `overflow orizzontale: ${JSON.stringify(geometry)}`)
      .toBeLessThanOrEqual(geometry!.viewportWidth);
    expect(geometry!.navigationPosition).toBe('fixed');
    expect(geometry!.navigationTop).toBeGreaterThanOrEqual(0);
    expect(geometry!.navigationBottom).toBeLessThanOrEqual(geometry!.viewportHeight);
    expect(geometry!.linkBottom, `contenuto finale troppo vicino alla nav: ${JSON.stringify(geometry)}`)
      .toBeLessThanOrEqual(geometry!.navigationTop - 16);
    expect(geometry!.linkCenterCoveredByNavigation).toBe(false);
  });
}
