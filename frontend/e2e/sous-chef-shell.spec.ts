import { expect, test, type Page } from '@playwright/test';
import {
  assertOfflineBackendClean,
  installOfflineBackend,
  type OfflineApiResponse,
} from './helpers/backendMode';

/** Contratti della shell Sous Chef e navigazione a cinque destinazioni. */

const verifiedSession = {
  authenticated: true,
  user: {
    id: 'shell-user',
    email: 'shell@example.com',
    emailVerifiedAt: '2026-10-01T08:00:00.000Z',
  },
  csrfToken: 'shell-csrf',
  expiresAt: '2026-12-31T08:00:00.000Z',
};

const offlineResponses: Record<string, OfflineApiResponse> = {
  'GET /v1/auth/session': { json: verifiedSession },
  'GET /v1/profile': { json: { profile: { displayName: 'Shell' } } },
  'GET /v1/house': { json: null },
  'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
  'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
  'GET /v1/meal-plan/capabilities': { status: 404, json: { code: 'not_found' } },
  'GET /v1/ai-recipes/consent': {
    json: { consent: { enabled: false, updatedAt: '2026-10-01T08:00:00.000Z' }, selectedProvider: 'openai' },
  },
  'GET /v1/ai-recipes': { json: { recipes: [] } },
  'GET /v1/pantry/candidates': { json: { candidates: [] } },
  'GET /v1/integrations/bring': { json: { enabled: true, connected: false, connectionId: null } },
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page, { responses: offlineResponses });
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

const bottomNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Navigazione principale' });

const heading = (page: Page, name: string) =>
  page.getByRole('heading', { name, exact: true, ...(name === 'Ricette' ? { level: 1 } : {}) });

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflowing: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1
        && element.closest('svg') === null)
      .map((element) => `${element.tagName.toLowerCase()}.${typeof element.className === 'string' ? element.className : ''}`.slice(0, 120))
      .slice(0, 5),
  }));

// ---------------------------------------------------------------------------
// Shell Sous Chef
// ---------------------------------------------------------------------------

test.describe('T02 · shell cinque voci', () => {
  test('mantiene la shell e recupera dopo un errore di verifica della Casa', async ({ page }) => {
    let houseUnavailable = true;
    await page.route('**/v1/house', (route) => route.fulfill(houseUnavailable
      ? { status: 503, json: { code: 'temporary_unavailable' } }
      : { json: null }));
    await page.goto('/');

    await expect(page.getByRole('alert')).toContainText('verificare l’ambito della Casa');
    await expect(page.getByRole('status')).toHaveText('Ambito da verificare');
    await expect(bottomNav(page).getByRole('link')).toHaveCount(5);
    await expect(page.getByRole('combobox', { name: 'Ingredienti presenti' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Profilo', exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Vai al contenuto principale' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    houseUnavailable = false;
    await page.getByRole('button', { name: 'Riprova', exact: true }).click();
    await expect(heading(page, 'Oggi lo chef propone...')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(bottomNav(page).getByRole('link')).toHaveCount(5);
  });

  test('la bottom nav offre esattamente le cinque voci T02', async ({ page }) => {
    await page.goto('/');
    const navigation = bottomNav(page);
    // toHaveCount auto-waits for the shell to mount before reading the labels.
    await expect(navigation.getByRole('link')).toHaveCount(5);
    const labels = await navigation.getByRole('link').allInnerTexts();
    expect(labels.map((label) => label.trim())).toEqual([
      'Dispensa',
      'Spesa',
      'Chef',
      'Piano',
      'Ricette',
    ]);
  });

  test('«Dispensa» apre la dispensa reale', async ({ page }) => {
    await page.goto('/');
    await bottomNav(page).getByRole('link', { name: 'Dispensa', exact: true }).click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Navigazione principale' })
      .getByRole('link', { name: 'Dispensa', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('«Spesa» apre la lista della spesa reale', async ({ page }) => {
    await page.goto('/');
    await bottomNav(page).getByRole('link', { name: 'Spesa', exact: true }).click();
    await expect(page).toHaveURL('/shopping-list');
    await expect(heading(page, 'Lista della spesa')).toBeVisible();
  });

  test('«Chef» è la casa centrale: riporta alla chat da altre destinazioni', async ({ page }) => {
    await page.goto('/recipes');
    await bottomNav(page).getByRole('link', { name: 'Chef', exact: true }).click();
    await expect(page).toHaveURL('/');
    await expect(heading(page, 'Oggi lo chef propone...')).toBeVisible();
  });

  test('«Piano» apre la schermata separata e mostra sette date anche senza capability condivisa', async ({ page }) => {
    await page.goto('/');
    await bottomNav(page).getByRole('link', { name: 'Piano', exact: true }).click();
    await expect(page).toHaveURL('/plan');
    await expect(heading(page, 'Pagina non trovata')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Piano settimanale', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem')).toHaveCount(7);
    await expect(page.getByText('Condivisione non disponibile')).toBeVisible();
    await expect(page.getByText(/non supporta ancora il piano condiviso/i)).toBeVisible();
  });

  test('il Piano usa la bottom nav per aprire Spesa e Chef', async ({ page }) => {
    await page.goto('/plan');
    await expect(page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem')).toHaveCount(7);

    await expect(page.getByRole('link', { name: 'Apri la lista della spesa' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Torna al Chef' })).toHaveCount(0);
    await bottomNav(page).getByRole('link', { name: 'Spesa', exact: true }).click();
    await expect(page).toHaveURL('/shopping-list');
    await expect(heading(page, 'Lista della spesa')).toBeVisible();
    await expect(bottomNav(page).getByRole('link', { name: 'Spesa', exact: true }))
      .toHaveAttribute('aria-current', 'page');

    await bottomNav(page).getByRole('link', { name: 'Piano', exact: true }).click();
    await expect(page).toHaveURL('/plan');
    await bottomNav(page).getByRole('link', { name: 'Chef', exact: true }).click();
    await expect(page).toHaveURL('/');
    await expect(heading(page, 'Oggi lo chef propone...')).toBeVisible();
  });

  test('il server legacy non consente di leggere o modificare il piano condiviso', async ({ page }) => {
    await page.goto('/plan');
    await expect(page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem')).toHaveCount(7);
    await expect(page.getByRole('button', { name: /modifica ricetta/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /aggiorna fuso/i })).toHaveCount(0);
    await expect(page.getByText(/non supporta ancora il piano condiviso/i)).toBeVisible();
  });

  test('«Ricette» apre il catalogo con ricerca e sezioni esistenti', async ({ page }) => {
    await page.goto('/');
    await bottomNav(page).getByRole('link', { name: 'Ricette', exact: true }).click();
    await expect(page).toHaveURL('/recipes');
    await expect(heading(page, 'Ricette')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Cerca ricette' })).toBeVisible();
  });

  test('Ricette non mostra più gli accessi secondari e il Diario è rimosso', async ({ page }) => {
    await page.goto('/recipes');
    await expect(page.getByRole('navigation', { name: 'Altre sezioni di Ricette' })).toHaveCount(0);
    await expect(page.locator('a[href="/dinner-diary"]')).toHaveCount(0);
    await page.goto('/dinner-diary');
    await expect(heading(page, 'Pagina non trovata')).toBeVisible();
  });

  for (const [path, pageHeading] of [
    ['/discover', 'Cerca ricette'],
    ['/saved', 'Le tue ricette'],
  ] as const) {
    test(`la route ${path} resta accessibile tramite deep link`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(path);
      await expect(heading(page, pageHeading)).toBeVisible();
      await expect(bottomNav(page).getByRole('link', { name: 'Ricette', exact: true }))
        .toHaveAttribute('aria-current', 'page');
    });
  }

  test('la ricetta del giorno di Chef si espande e si richiude anche da tastiera', async ({ page }) => {
    await page.goto('/');
    const dailyRecipe = page.getByRole('region', { name: 'Ricetta del giorno' });
    const summary = dailyRecipe.locator('summary');
    await expect(summary).toBeVisible();
    await expect(dailyRecipe.getByRole('link', { name: 'Apri la ricetta' })).toHaveCount(0);
    await expect(dailyRecipe.getByRole('heading', { name: 'Procedimento' })).toBeHidden();
    await summary.click();
    await expect(dailyRecipe.getByRole('heading', { name: 'Ingredienti' })).toBeVisible();
    await expect(dailyRecipe.getByRole('heading', { name: 'Procedimento' })).toBeVisible();
    await expect(page).toHaveURL('/');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(dailyRecipe.getByRole('heading', { name: 'Procedimento' })).toBeHidden();
  });

  test('le voci della nav sono raggiungibili da tastiera (ARIA e focus)', async ({ page }) => {
    await page.goto('/');
    const spesaLink = bottomNav(page).getByRole('link', { name: 'Spesa', exact: true });
    await spesaLink.focus();
    await expect(spesaLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/shopping-list');
  });

  test('il link salta al contenuto e porta il focus al target stabile', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Oggi lo chef propone...', exact: true })).toBeVisible();

    const skipLink = page.getByRole('link', { name: 'Vai al contenuto principale' });
    await expect(skipLink).toHaveAttribute('href', '#sous-chef-main-content');
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    await page.keyboard.press('Enter');

    const contentTarget = page.locator('#sous-chef-main-content');
    await expect(contentTarget).toBeFocused();
    await expect(contentTarget.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
  });

  test('Profilo raccoglie le azioni senza menu duplicato o toggle tema nell’intestazione', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Tema (chiaro|scuro)/ })).toHaveCount(0);
    const profileButton = page.getByRole('button', { name: 'Profilo', exact: true });
    await profileButton.click();
    await expect(profileButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: /^Profilo$/ })).toHaveAttribute('href', '/profile');
    await expect(page.getByRole('link', { name: /Casa/ })).toHaveAttribute('href', '/house');
    await expect(page.getByRole('button', { name: /Tema (chiaro|scuro)/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expect(profileButton).toHaveAttribute('aria-expanded', 'false');
    await expect(profileButton).toBeFocused();
  });

  test('la shell mantiene un solo h1 per la pagina Chef su desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Oggi lo chef propone...', exact: true })).toBeVisible();
  });

  test('la nav espone aria-current sulla destinazione attiva', async ({ page }) => {
    await page.goto('/pantry');
    const navigation = bottomNav(page);
    await expect(navigation.getByRole('link', { name: 'Dispensa', exact: true }))
      .toHaveAttribute('aria-current', 'page');
    await expect(navigation.getByRole('link', { name: 'Chef', exact: true }))
      .not.toHaveAttribute('aria-current');
  });

  test('Casa è raggiungibile dalla pagina Profilo', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('link', { name: 'La mia casa', exact: true }).click();
    await expect(page).toHaveURL('/house');
    await expect(heading(page, 'La mia casa')).toBeVisible();
  });

  test('Casa è raggiungibile dal menu account della shell Sous Chef', async ({ page }) => {
    await page.goto('/');
    const profileButton = page.getByRole('button', { name: 'Profilo', exact: true });
    await profileButton.click();
    await expect(profileButton).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('link', { name: /Casa/ }).click();
    await expect(page).toHaveURL('/house');
    await expect(heading(page, 'La mia casa')).toBeVisible();
  });


  test('la dispensa non mostra il bottone indietro', async ({ page }) => {
    await page.goto('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
    await expect(page.getByRole('button', { name: /indietro/i })).toHaveCount(0);
  });

  test('320px: cinque voci visibili e nessun clipping orizzontale', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    await expect(bottomNav(page).getByRole('link')).toHaveCount(5);

    for (const [path, label] of [['/', 'Chef'], ['/plan', 'Piano'], ['/pantry', 'Dispensa']] as const) {
      if (path !== '/') {
        await bottomNav(page).getByRole('link', { name: label, exact: true }).click();
        await expect(page).toHaveURL(path);
      }
      const overflow = await horizontalOverflow(page);
      expect(overflow.overflowing, `elementi che escono dal viewport a 320px su ${path}`).toEqual([]);
      expect(overflow.scrollWidth, `scroll orizzontale a 320px su ${path}`)
        .toBeLessThanOrEqual(overflow.innerWidth + 1);
      for (const navLabel of ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette']) {
        await expect(bottomNav(page).getByRole('link', { name: navLabel, exact: true }),
          `voce «${navLabel}» a 320px su ${path}`).toBeVisible();
      }
    }
  });

  test('320px con testo al 200%: etichette leggibili e target accessibili', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/plan');
    const navigation = bottomNav(page);
    await expect(navigation.getByRole('link')).toHaveCount(5);
    const initialFont = await navigation.locator('a span').first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const enlargedFont = await navigation.locator('a span').first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(enlargedFont).toBeGreaterThanOrEqual(initialFont * 1.9);
    const metrics = await navigation.locator('a').evaluateAll((links) => links.map((link) => {
      const label = link.querySelector('span')!;
      const bounds = link.getBoundingClientRect();
      return { label: link.getAttribute('aria-label'), clipped: label.scrollWidth > label.clientWidth, lines: label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight), height: bounds.height, width: bounds.width };
    }));
    for (const metric of metrics) {
      expect(metric.clipped, `etichetta ${metric.label} tagliata`).toBe(false);
      expect(metric.lines, `etichetta ${metric.label} su più righe`).toBeLessThan(1.2);
      expect(metric.width).toBeGreaterThanOrEqual(44);
      expect(metric.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await horizontalOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const bottomGeometry = await page.evaluate(() => {
      const navigation = document.querySelector<HTMLElement>('nav[aria-label="Navigazione principale"]')!;
      const main = document.querySelector<HTMLElement>('main')!;
      const lastTextLeaf = Array.from(main.querySelectorAll<HTMLElement>('*'))
        .filter((element) => element.children.length === 0
          && Boolean(element.textContent?.trim())
          && element.getClientRects().length > 0)
        .map((element) => ({
          text: element.textContent?.trim() ?? '',
          bottom: element.getBoundingClientRect().bottom,
        }))
        .reduce((last, current) => current.bottom > last.bottom ? current : last, { text: '', bottom: -Infinity });
      const navBounds = navigation.getBoundingClientRect();
      return {
        navPosition: getComputedStyle(navigation).position,
        navTop: navBounds.top,
        navBottom: navBounds.bottom,
        viewportHeight: window.innerHeight,
        lastTextLeaf,
      };
    });
    expect(bottomGeometry.navPosition).toBe('fixed');
    expect(bottomGeometry.navBottom).toBeCloseTo(bottomGeometry.viewportHeight, 0);
    expect(bottomGeometry.lastTextLeaf.text).not.toBe('');
    expect(bottomGeometry.lastTextLeaf.bottom).toBeLessThanOrEqual(bottomGeometry.navTop - 8);
  });

  test('viewport 640×512: nessun clipping orizzontale', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 512 });
    await page.goto('/');
    await expect(bottomNav(page).getByRole('link')).toHaveCount(5);
    for (const [path, label] of [['/', 'Chef'], ['/plan', 'Piano'], ['/recipes', 'Ricette']] as const) {
      if (path !== '/') {
        await bottomNav(page).getByRole('link', { name: label, exact: true }).click();
        await expect(page).toHaveURL(path);
      }
      const overflow = await horizontalOverflow(page);
      expect(overflow.overflowing, `elementi che escono dal viewport allo zoom 200% su ${path}`).toEqual([]);
      expect(overflow.scrollWidth, `scroll orizzontale allo zoom 200% su ${path}`)
        .toBeLessThanOrEqual(overflow.innerWidth + 1);
    }
  });

  test('la bottom nav resta compatta e le etichette non vanno a capo a 320/390px con testo al 200%', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto('/profile');
    const navigation = bottomNav(page);
    await expect(navigation.getByRole('link')).toHaveCount(5);

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 740 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });

      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        const geometry = await navigation.evaluate((nav) => {
          const navBounds = nav.getBoundingClientRect();
          const links = Array.from(nav.querySelectorAll('a')).map((link) => {
            const bounds = link.getBoundingClientRect();
            const label = link.querySelector<HTMLElement>('span[aria-hidden="true"]')!;
            const visibleLabel = Array.from(label.children)
              .find((child) => child.getClientRects().length > 0)!;
            const textRange = document.createRange();
            textRange.selectNodeContents(visibleLabel);
            const textRects = Array.from(textRange.getClientRects()).map((rect) => ({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            }));
            return {
              name: link.getAttribute('aria-label'),
              bounds: { left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height },
              text: visibleLabel.textContent?.trim() ?? '',
              textRects,
            };
          });
          return {
            height: navBounds.height,
            position: getComputedStyle(nav).position,
            links,
          };
        });

        expect(geometry.position).toBe('fixed');
        expect(geometry.height, `${width}px/${theme}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(80);
        expect(geometry.links.map(({ name }) => name)).toEqual(['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette']);
        expect(geometry.links.map(({ text }) => text)).toEqual(width === 320
          ? ['Disp.', 'Sp.', 'Chef', 'Pi.', 'Ric.']
          : ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette']);
        for (const link of geometry.links) {
          expect(link.bounds.width, link.name ?? '').toBeGreaterThanOrEqual(44);
          expect(link.bounds.height, link.name ?? '').toBeGreaterThanOrEqual(44);
          expect(link.textRects, `${link.name} va a capo a ${width}px/${theme}`).toHaveLength(1);
          expect(link.textRects[0]?.left, `${link.name} esce a sinistra a ${width}px/${theme}`)
            .toBeGreaterThanOrEqual(link.bounds.left - 1);
          expect(link.textRects[0]?.right, `${link.name} esce a destra a ${width}px/${theme}`)
            .toBeLessThanOrEqual(link.bounds.right + 1);
        }
      }
    }
  });

  test('Chef keeps bottom navigation destinations reachable without mounting AI chat', async ({ page }) => {
    const aiRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/v1/chef-chat' || path === '/v1/ai-recipes/consent') aiRequests.push(path);
    });

    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    await expect(heading(page, 'Oggi lo chef propone...')).toBeVisible();
    await expect(page.getByText('Chat AI non disponibile. La chat AI è stata rinviata.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invia messaggio' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Idea per cena' })).toHaveCount(0);

    const shortcuts = page.getByRole('navigation', { name: 'Navigazione principale' });
    const destinations = [
      ['Ricette', '/recipes'],
      ['Dispensa', '/pantry'],
      ['Spesa', '/shopping-list'],
      ['Piano', '/plan'],
    ] as const;
    for (const [label, destination] of destinations) {
      const link = shortcuts.getByRole('link', { name: new RegExp(label) });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', destination);
    }

    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(geometry.content, `overflow at 320px/200% text: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.viewport);
    await shortcuts.getByRole('link', { name: /Dispensa/ }).click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
    expect(aiRequests).toEqual([]);
  });

  test('Chef bottom navigation links activate from the keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    const shortcuts = page.getByRole('navigation', { name: 'Navigazione principale' });
    const pantryLink = shortcuts.getByRole('link', { name: /Dispensa/ });
    await expect(pantryLink).toBeVisible();
    await pantryLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
  });

  test('Home: aggiunta ingredienti, ricerca locale esplicita e link alla ricetta funzionano', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/cucina');
    await expect(heading(page, 'Cucina viva')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trova ricette' })).toBeDisabled();

    await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
    const dialog = page.getByRole('dialog', { name: 'Aggiungi ingredienti' });
    await dialog.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno, passata');
    await dialog.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
    await expect(page.getByRole('list', { name: 'Ingredienti disponibili' })).toContainText('Pasta');
    await expect(page.getByRole('button', { name: 'Trova ricette' })).toBeEnabled();
    await expect(heading(page, 'Ricette per te')).toHaveCount(0);

    await page.getByRole('link', { name: 'Apri tutta la dispensa' }).click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL('/cucina');
    await expect(heading(page, 'Cucina viva')).toBeVisible();
    await expect(heading(page, 'Ricette per te')).toHaveCount(0);

    await page.getByRole('button', { name: 'Trova ricette' }).click();
    const resultsHeading = heading(page, 'Ricette per te');
    await expect(resultsHeading).toBeVisible();
    await expect(resultsHeading).toBeFocused();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    const bottomGeometry = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('.sous-chef-main-content main')!;
      const navigation = document.querySelector<HTMLElement>('nav[aria-label="Navigazione principale"]')!;
      const navigationBounds = navigation.getBoundingClientRect();
      const lastTextLeaf = Array.from(main.querySelectorAll<HTMLElement>('*'))
        .filter((element) => element.children.length === 0
          && Boolean(element.textContent?.trim())
          && element.getClientRects().length > 0)
        .map((element) => ({
          text: element.textContent?.trim() ?? '',
          bottom: element.getBoundingClientRect().bottom,
        }))
        .reduce((last, current) => current.bottom > last.bottom ? current : last, { text: '', bottom: -Infinity });
      return {
        lastTextLeaf,
        navigationTop: navigationBounds.top,
        navigationPosition: getComputedStyle(navigation).position,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    expect(bottomGeometry.lastTextLeaf.text).not.toBe('');
    expect(bottomGeometry.lastTextLeaf.bottom).toBeLessThanOrEqual(bottomGeometry.navigationTop - 8);
    expect(bottomGeometry.navigationPosition).toBe('fixed');
    expect(bottomGeometry.scrollWidth).toBeLessThanOrEqual(bottomGeometry.clientWidth + 1);
    const recipeLink = page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' });
    await expect(recipeLink).toBeVisible();
    await recipeLink.click();
    await expect(page).toHaveURL(/\/recipes\/pasta-tonno-pomodoro/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('Home resta operabile in chiaro e scuro su mobile ingrandito e desktop', async ({ page }) => {
    const viewports = [{ width: 320, height: 800 }, { width: 1280, height: 900 }];
    await page.setViewportSize(viewports[0]);
    await page.goto('/cucina');
    for (const [index, viewport] of viewports.entries()) {
      if (index > 0) {
        await page.evaluate(() => { document.documentElement.style.removeProperty('font-size'); });
        await page.setViewportSize(viewport);
      }
      await expect(heading(page, 'Cucina viva')).toBeVisible();
      const addIngredients = page.getByRole('button', { name: 'Aggiungi ingredienti' });
      const searchRecipes = page.getByRole('button', { name: 'Trova ricette' });
      await expect(addIngredients).toBeVisible();
      await expect(searchRecipes).toBeVisible();

      if (viewport.width === 320) {
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      }
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        const palette = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          page: getComputedStyle(document.body).backgroundColor,
          surface: getComputedStyle(document.querySelector<HTMLElement>('.ik-pantry-workbench')!).backgroundColor,
          ink: getComputedStyle(document.querySelector<HTMLElement>('.ik-page-intro h1')!).color,
        }));
        expect(palette.theme).toBe(theme);
        expect(palette.page).not.toBe(palette.surface);
        expect(palette.ink).not.toBe(palette.page);

        await searchRecipes.scrollIntoViewIfNeeded();
        const [searchBounds, navigationBounds] = await Promise.all([
          searchRecipes.boundingBox(),
          bottomNav(page).boundingBox(),
        ]);
        expect(searchBounds).not.toBeNull();
        expect(navigationBounds).not.toBeNull();
        expect(searchBounds!.y + searchBounds!.height).toBeLessThanOrEqual(navigationBounds!.y - 8);
        const overflow = await horizontalOverflow(page);
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
      }
    }
  });
});
