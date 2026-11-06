import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const viewports = [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
] as const;

for (const viewport of viewports) {
  test(`dettaglio ricetta senza overflow e CTA raggiungibile a ${viewport.width}px / testo 200%`, async ({
    context,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'Regressione responsive mobile, esclusa dal gate desktop.');

    await context.clearCookies();
    await page.setViewportSize(viewport);
    await installOfflineBackend(page);

    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== 'string') throw new Error('Preview locale obbligatoria per questo test offline');
    const previewOrigin = new URL(baseURL).origin;
    const externalRequests: string[] = [];
    await context.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== previewOrigin) {
        externalRequests.push(`${route.request().method()} ${requestUrl.origin}${requestUrl.pathname}`);
        await route.abort();
        return;
      }
      await route.fallback();
    });
    page.on('request', (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.origin !== previewOrigin) {
        externalRequests.push(`${request.method()} ${requestUrl.origin}${requestUrl.pathname}`);
      }
    });

    await page.goto('/recipes/pasta-tonno-pomodoro');
    await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro', exact: true })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect(page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).resolves.toBe('32px');

    const addMissingButton = page.getByRole('button', { name: 'Aggiungi mancanti alla spesa', exact: true });
    await expect(addMissingButton).toBeVisible();
    await expect(addMissingButton).toBeEnabled();
    await addMissingButton.scrollIntoViewIfNeeded();

    const geometry = await addMissingButton.evaluate((button, viewportHeight: number) => {
      const actionBounds = button.getBoundingClientRect();
      const actionX = actionBounds.left + actionBounds.width / 2;
      const actionY = actionBounds.top + actionBounds.height / 2;
      const topmost = document.elementFromPoint(actionX, actionY);
      const navigation = document.querySelector<HTMLElement>('nav[aria-label="Navigazione principale"]');
      if (navigation === null) return null;
      const navigationBounds = navigation.getBoundingClientRect();
      const layoutAncestors: Array<Record<string, string | number>> = [];
      for (let current: HTMLElement | null = navigation; current !== null && current !== document.body; current = current.parentElement) {
        const bounds = current.getBoundingClientRect();
        const style = getComputedStyle(current);
        layoutAncestors.push({
          element: `${current.tagName.toLowerCase()}.${Array.from(current.classList).join('.')}`,
          width: bounds.width,
          right: bounds.right,
          position: style.position,
          transform: style.transform,
          contain: style.contain,
        });
      }
      return {
        viewportWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        fontSize: getComputedStyle(document.documentElement).fontSize,
        action: {
          left: actionBounds.left,
          right: actionBounds.right,
          top: actionBounds.top,
          bottom: actionBounds.bottom,
          x: actionX,
          y: actionY,
          topmostIsAction: topmost === button || (topmost !== null && button.contains(topmost)),
          centerInViewport: actionX >= 0 && actionX < document.documentElement.clientWidth
            && actionY >= 0 && actionY < viewportHeight,
        },
        navigation: {
          left: navigationBounds.left,
          right: navigationBounds.right,
          top: navigationBounds.top,
          bottom: navigationBounds.bottom,
          width: getComputedStyle(navigation).width,
          position: getComputedStyle(navigation).position,
          leftInset: getComputedStyle(navigation).left,
          rightInset: getComputedStyle(navigation).right,
          ancestors: layoutAncestors,
        },
      };
    }, viewport.height);

    expect(geometry, 'La navigazione principale deve essere montata').not.toBeNull();
    expect(geometry!.viewportWidth).toBe(viewport.width);
    expect(geometry!.innerWidth).toBe(viewport.width);
    expect(geometry!.fontSize).toBe('32px');
    expect(
      geometry!.scrollWidth,
      `overflow orizzontale su /recipes/pasta-tonno-pomodoro: ${JSON.stringify(geometry)}`,
    ).toBeLessThanOrEqual(geometry!.viewportWidth);
    expect(geometry!.navigation.position).toBe('fixed');
    expect(geometry!.navigation.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
    expect(geometry!.navigation.right, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry!.viewportWidth);
    expect(geometry!.navigation.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
    expect(geometry!.navigation.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(viewport.height);
    expect(geometry!.navigation.bottom, JSON.stringify(geometry)).toBeCloseTo(viewport.height, 0);
    expect(geometry!.action.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
    expect(geometry!.action.right, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry!.viewportWidth);
    expect(geometry!.action.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
    expect(geometry!.action.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(viewport.height);
    expect(geometry!.action.centerInViewport, JSON.stringify(geometry)).toBe(true);
    expect(geometry!.action.topmostIsAction, JSON.stringify(geometry)).toBe(true);

    await page.mouse.click(geometry!.action.x, geometry!.action.y);
    await expect(page.getByRole('status')).toContainText(/alla lista|mancanti da aggiungere/);
    expect(externalRequests, 'La verifica offline non deve contattare origini esterne').toEqual([]);
  });
}

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});
