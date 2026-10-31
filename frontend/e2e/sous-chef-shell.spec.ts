import { expect, test, type Page } from '@playwright/test';
import {
  assertOfflineBackendClean,
  installOfflineBackend,
  type OfflineApiResponse,
} from './helpers/backendMode';

/**
 * T02 · Shell e cinque destinazioni (Sous-Chef).
 *
 * Copre l'accettazione di T02 dal breakdown:
 *  - bottom nav Dispensa · Spesa · Chef (centrale) · Piano · Ricette, tutte con
 *    destinazioni effettive (nessuna route fantasma);
 *  - Casa raggiungibile dal profilo, Diario raggiungibile da Ricette;
 *  - chiusura/ritorno della dispensa anche a ingresso diretto;
 *  - tastiera/ARIA, 320px e zoom 200% senza clipping orizzontale;
 *  - flag OFF senza regressioni (la shell legacy resta identica, /plan resta 404).
 *
 * Il flag è a build time, quindi questa suite afferma la build che alimenta il
 * preview server:
 *   flag OFF (build di default): npm --prefix frontend run test:e2e -- e2e/sous-chef-shell.spec.ts
 *   flag ON:                    VITE_SOUS_CHEF=true npm --prefix frontend run test:e2e -- e2e/sous-chef-shell.spec.ts
 */

const SOUS_CHEF_ON = process.env.VITE_SOUS_CHEF === 'true';

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
  page.getByRole('heading', { name, exact: true });

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflowing: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 120))
      .slice(0, 5),
  }));

// ---------------------------------------------------------------------------
// Flag ON · shell Sous-Chef
// ---------------------------------------------------------------------------

test.describe('T02 · shell cinque voci (flag ON)', () => {
  test.skip(!SOUS_CHEF_ON, 'build senza VITE_SOUS_CHEF=true: la shell Sous-Chef non viene montata');

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
    await expect(page.getByRole('group', { name: 'Risposte rapide' })).toBeVisible();
  });

  test('«Piano» apre la schermata separata e mostra quattro date anche senza capability condivisa', async ({ page }) => {
    await page.goto('/');
    await bottomNav(page).getByRole('link', { name: 'Piano', exact: true }).click();
    await expect(page).toHaveURL('/plan');
    await expect(heading(page, 'Pagina non trovata')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Piano', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem')).toHaveCount(4);
    await expect(page.getByText('Condivisione non disponibile')).toBeVisible();
    await expect(page.getByText(/non supporta ancora il piano condiviso/i)).toBeVisible();
  });

  test('il server legacy non consente di leggere o modificare il piano condiviso', async ({ page }) => {
    await page.goto('/plan');
    await expect(page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem')).toHaveCount(4);
    await expect(page.getByRole('button', { name: /cambia ricetta/i })).toHaveCount(0);
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

  test('Menu espone lo stato del dialog e ripristina il focus dopo la chiusura', async ({ page }) => {
    await page.goto('/');

    const menuButton = page.getByRole('button', { name: 'Menu' });
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton).toHaveAttribute('aria-haspopup', 'dialog');
    await menuButton.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Profilo' });
    await expect(dialog).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'Chiudi' })).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(dialog).toHaveCount(0);
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton).toBeFocused();
  });

  test('la shell mantiene un solo h1 per la pagina Chef su desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Chef', exact: true })).toBeVisible();
  });

  test('la nav espone aria-current sulla destinazione attiva', async ({ page }) => {
    await page.goto('/pantry');
    const navigation = bottomNav(page);
    await expect(navigation.getByRole('link', { name: 'Dispensa', exact: true }))
      .toHaveAttribute('aria-current', 'page');
    await expect(navigation.getByRole('link', { name: 'Chef', exact: true }))
      .not.toHaveAttribute('aria-current');
  });

  test('Casa è raggiungibile dal profilo (profilo e modale della shell)', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('link', { name: 'La mia casa', exact: true }).click();
    await expect(page).toHaveURL('/house');
    await expect(heading(page, 'La mia casa')).toBeVisible();

    // Anche dal menu profilo della shell Sous-Chef.
    await page.goto('/');
    await page.getByRole('button', { name: 'Menu' }).click();
    const dialog = page.getByRole('dialog', { name: 'Profilo' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('link', { name: /casa/i }).click();
    await expect(page).toHaveURL('/house');
    await expect(heading(page, 'La mia casa')).toBeVisible();
  });

  test('il Diario è raggiungibile da Ricette con un link reale', async ({ page }) => {
    await page.goto('/recipes');
    const diaryLink = page.locator('a[href="/dinner-diary"]');
    await expect(diaryLink.first()).toBeVisible();
    await diaryLink.first().click();
    await expect(page).toHaveURL('/dinner-diary');
    await expect(heading(page, 'Diario delle cene')).toBeVisible();
  });

  test('la dispensa torna indietro anche con ingresso diretto', async ({ page }) => {
    // Ingresso diretto: nessuna navigazione precedente nella cronologia del documento.
    await page.goto('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
    await page.getByRole('button', { name: /indietro/i }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('group', { name: 'Risposte rapide' })).toBeVisible();
  });

  test('320px: cinque voci visibili e nessun clipping orizzontale', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const path of ['/', '/plan', '/pantry']) {
      await page.goto(path);
      const overflow = await horizontalOverflow(page);
      expect(overflow.overflowing, `elementi che escono dal viewport a 320px su ${path}`).toEqual([]);
      expect(overflow.scrollWidth, `scroll orizzontale a 320px su ${path}`)
        .toBeLessThanOrEqual(overflow.innerWidth + 1);
      for (const label of ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette']) {
        await expect(bottomNav(page).getByRole('link', { name: label, exact: true }),
          `voce «${label}» a 320px su ${path}`).toBeVisible();
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
  });

  test('viewport 640×512: nessun clipping orizzontale', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 512 });
    for (const path of ['/', '/plan', '/recipes']) {
      await page.goto(path);
      const overflow = await horizontalOverflow(page);
      expect(overflow.overflowing, `elementi che escono dal viewport allo zoom 200% su ${path}`).toEqual([]);
      expect(overflow.scrollWidth, `scroll orizzontale allo zoom 200% su ${path}`)
        .toBeLessThanOrEqual(overflow.innerWidth + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Flag OFF · nessuna regressione della shell legacy
// ---------------------------------------------------------------------------

test.describe('T02 · flag OFF senza regressioni', () => {
  test.skip(SOUS_CHEF_ON, 'build con VITE_SOUS_CHEF=true: la shell legacy non viene montata');

  test('/plan resta una destinazione assente con flag OFF (nessuna route fantasma)', async ({ page }) => {
    await page.goto('/plan');
    await expect(heading(page, 'Pagina non trovata')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Torna alla home' })).toBeVisible();
  });

  test('la bottom nav cinque voci non compare con flag OFF', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Navigazione principale' })
      .getByRole('link', { name: 'Chef', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Cucina', exact: true })).toBeVisible();
  });

  test('la dispensa torna indietro anche con ingresso diretto (flag OFF)', async ({ page }) => {
    await page.goto('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
    await page.getByRole('button', { name: /indietro/i }).click();
    await expect(page).toHaveURL('/');
    await expect(heading(page, 'Cucina viva')).toBeVisible();
  });
});