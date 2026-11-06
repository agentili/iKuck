import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const registrationError = 'Non è stato possibile controllare gli aggiornamenti. Riprova più tardi.';

for (const viewport of [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
]) {
  for (const theme of ['light', 'dark'] as const) {
  test(`errore aggiornamento: link e azioni restano nel viewport a ${viewport.width}px in tema ${theme}`, async ({
    context,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'Regressione responsive mobile, esclusa dal gate desktop.');

    await context.clearCookies();
    await page.setViewportSize(viewport);
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('ikuck-color-theme', selectedTheme);
    }, theme);
    await installOfflineBackend(page, { serviceWorkers: 'allow' });
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
    await page.addInitScript(() => {
      const serviceWorker = navigator.serviceWorker;
      if (serviceWorker === undefined) throw new Error('Service worker API non disponibile nel test');
      Object.defineProperty(Object.getPrototypeOf(serviceWorker), 'register', {
        configurable: true,
        value: () => Promise.reject(new Error('Errore di registrazione controllato dal test')),
      });
    });

    await page.goto('/recipes');
    await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect(page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).resolves.toBe('32px');
    const prompt = page.getByRole('complementary', { name: 'Aggiornamento applicazione' });
    await expect(page.getByText(registrationError, { exact: true })).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Riprova aggiornamento' })).toBeVisible();
    const laterButton = prompt.getByRole('button', { name: 'Più tardi' });
    await expect(laterButton).toBeVisible();
    const promptGeometry = await page.evaluate(() => {
      const promptElement = document.querySelector<HTMLElement>('[aria-label="Aggiornamento applicazione"]');
      if (!promptElement) throw new Error('Prompt aggiornamento non trovato');
      const buttons = [...promptElement.querySelectorAll('button')].map((button) => {
        const bounds = button.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right };
      });
      const bounds = promptElement.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        prompt: { left: bounds.left, right: bounds.right },
        buttons,
      };
    });
    expect(promptGeometry.documentWidth, JSON.stringify(promptGeometry)).toBe(promptGeometry.viewportWidth);
    expect(promptGeometry.prompt.left, JSON.stringify(promptGeometry)).toBeGreaterThanOrEqual(0);
    expect(promptGeometry.prompt.right, JSON.stringify(promptGeometry)).toBeLessThanOrEqual(promptGeometry.viewportWidth);
    for (const button of promptGeometry.buttons) {
      expect(button.left, JSON.stringify(promptGeometry)).toBeGreaterThanOrEqual(0);
      expect(button.right, JSON.stringify(promptGeometry)).toBeLessThanOrEqual(promptGeometry.viewportWidth);
    }

    const finalAction = page.getByRole('link', { name: 'Apri Zuppa rustica di verdure' });
    await expect(finalAction).toBeVisible();
    await finalAction.evaluate((element) => element.scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: 'instant',
    }));
    const hitTest = await finalAction.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const topmost = document.elementFromPoint(x, y);
      return {
        x,
        y,
        innerHeight: window.innerHeight,
        clientHeight: document.documentElement.clientHeight,
        visualViewportHeight: window.visualViewport?.height ?? null,
        visualViewportOffsetLeft: window.visualViewport?.offsetLeft ?? null,
        visualViewportOffsetTop: window.visualViewport?.offsetTop ?? null,
        visualViewportPageTop: window.visualViewport?.pageTop ?? null,
        scrollY: window.scrollY,
        topmost: topmost instanceof HTMLElement ? {
          tag: topmost.tagName,
          id: topmost.id,
          className: topmost.className,
          ariaLabel: topmost.getAttribute('aria-label'),
          bounds: topmost.getBoundingClientRect().toJSON(),
        } : null,
        inViewport: x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
        reachesAction: topmost === element || (topmost !== null && element.contains(topmost)),
      };
    });
    expect(hitTest.inViewport, `Il punto centrale deve essere nel viewport ${viewport.width}×${viewport.height}`).toBe(true);
    expect(hitTest.reachesAction, `Il centro del link deve avere il link stesso come hit topmost: ${JSON.stringify(hitTest)}`).toBe(true);

    await page.evaluate(() => {
      document.addEventListener('pointerdown', (event) => {
        const topmost = document.elementFromPoint(event.clientX, event.clientY);
        const topmostLink = topmost instanceof Element ? topmost.closest('a[href]') : null;
        document.documentElement.dataset.lastPointer = `${event.clientX},${event.clientY}`;
        document.documentElement.dataset.lastPointerTopmostHref = topmostLink?.getAttribute('href') ?? 'no-link';
      }, { capture: true, once: true });
      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
        document.documentElement.dataset.lastClickedHref = target?.getAttribute('href') ?? 'no-link';
        document.documentElement.dataset.lastClick = `${event.clientX},${event.clientY}`;
      }, { capture: true, once: true });
    });
    const clickPoint = {
      x: hitTest.x - (hitTest.visualViewportOffsetLeft ?? 0),
      y: hitTest.y - (hitTest.visualViewportOffsetTop ?? 0),
    };
    expect(clickPoint.x).toBeGreaterThanOrEqual(0);
    expect(clickPoint.x).toBeLessThan(viewport.width);
    expect(clickPoint.y).toBeGreaterThanOrEqual(0);
    expect(clickPoint.y).toBeLessThan(viewport.height);
    await page.mouse.click(clickPoint.x, clickPoint.y);
    const clickResult = {
      href: await page.locator('html').getAttribute('data-last-clicked-href'),
      pointer: await page.locator('html').getAttribute('data-last-pointer'),
      pointerTopmostHref: await page.locator('html').getAttribute('data-last-pointer-topmost-href'),
      click: await page.locator('html').getAttribute('data-last-click'),
      point: `${clickPoint.x},${clickPoint.y}`,
    };
    expect(clickResult.pointerTopmostHref, JSON.stringify(clickResult)).toBe('/recipes/zuppa-rustica-verdure');
    expect(clickResult.href, JSON.stringify(clickResult)).toBe('/recipes/zuppa-rustica-verdure');
    await expect(page).toHaveURL('/recipes/zuppa-rustica-verdure');
    await expect(page.getByText(registrationError, { exact: true })).toBeVisible();

    const retryButton = prompt.getByRole('button', { name: 'Riprova aggiornamento' });
    await retryButton.focus();
    await page.keyboard.press('Tab');
    await expect(laterButton).toBeFocused();
    await page.keyboard.press('Tab');
    const focusStaysInsidePrompt = await prompt.evaluate((element) => element.contains(document.activeElement));
    expect(focusStaysInsidePrompt, 'La tastiera deve poter uscire dall’avviso senza chiuderlo').toBe(false);
    await expect(prompt).toBeVisible();
    await laterButton.focus();
    await page.keyboard.press('Enter');
    await expect(prompt).toHaveCount(0);
    expect(externalRequests, 'La verifica offline non deve contattare origini esterne').toEqual([]);
  });
  }
}

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});
