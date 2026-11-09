import { expect, test, type Page } from '@playwright/test';
import {
  assertOfflineBackendClean,
  installOfflineBackend,
  type OfflineApiResponse,
} from './helpers/backendMode';

/**
 * T01 · Test sentinella flag ON/OFF (Sous-Chef).
 *
 * Il feature flag è definito a build time (vite `define` → import.meta.env.VITE_SOUS_CHEF),
 * quindi questa suite afferma il comportamento della build che alimenta il preview server:
 *
 *   flag OFF (build di default):
 *     npm --prefix frontend run test:e2e -- e2e/sous-chef-sentinel.spec.ts
 *   flag ON:
 *     VITE_SOUS_CHEF=true npm --prefix frontend run test:e2e -- e2e/sous-chef-sentinel.spec.ts
 *
 * La suite afferma le route e i flussi attualmente accettati per entrambe le build.
 * La chat AI è differita; le scorciatoie Chef restano link di navigazione reali.
 * Nessun test è considerato superato se saltato: gli skip vengono riportati come tali.
 */

const SOUS_CHEF_ON = process.env.VITE_SOUS_CHEF === 'true';

const verifiedSession = {
  authenticated: true,
  user: {
    id: 'sentinel-user',
    email: 'sentinel@example.com',
    emailVerifiedAt: '2026-10-01T08:00:00.000Z',
  },
  csrfToken: 'sentinel-csrf',
  expiresAt: '2026-12-31T08:00:00.000Z',
};

const offlineResponses: Record<string, OfflineApiResponse> = {
  'GET /v1/auth/session': { json: verifiedSession },
  'GET /v1/profile': { json: { profile: { displayName: 'Sentinel' } } },
  'GET /v1/house': { json: null },
  'GET /v1/meal-plan/capabilities': { json: { version: 2, syncReadVersion: 2 } },
  'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
  'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
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

// ---------------------------------------------------------------------------
// Stato attuale · route condivise (valgono con flag ON e OFF)
// ---------------------------------------------------------------------------

const sharedRoutes = [
  { path: '/recipes', heading: 'Ricette' },
  { path: '/pantry', heading: 'La tua dispensa' },
  { path: '/shopping-list', heading: 'Lista della spesa' },
  { path: '/activity', heading: 'La tua attività' },
  { path: '/profile', heading: 'Il tuo profilo' },
  { path: '/house', heading: 'La mia casa' },
  { path: '/dinner-diary', heading: 'Diario delle cene' },
  { path: '/recipes/pasta-tonno-pomodoro', heading: 'Pasta tonno e pomodoro' },
] as const;

test.describe('stato attuale · route condivise (flag ON e OFF)', () => {
  for (const route of sharedRoutes) {
    test(`${route.path} rende «${route.heading}»`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page).toHaveURL(route.path);
      await expect(heading(page, route.heading)).toBeVisible();
    });
  }

  test('percorso sconosciuto mostra la 404 con link di ritorno', async ({ page }) => {
    await page.goto('/percorso-inesistente');
    await expect(heading(page, 'Pagina non trovata')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Torna alla home' })).toBeVisible();
  });

  test('la shell renderizzata corrisponde al flag della build', async ({ page }) => {
    await page.goto('/');
    if (SOUS_CHEF_ON) {
      // Shell Sous-Chef: header semplificato + bottom nav, nessun header legacy.
      await expect(page.getByRole('button', { name: 'Profilo' })).toBeVisible();
      await expect(bottomNav(page).getByRole('link', { name: 'Chef' })).toBeVisible();
      await expect(heading(page, 'Cosa cuciniamo oggi?')).toBeVisible();
      await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Cucina', exact: true })).toHaveCount(0);
    } else {
      // Shell legacy: AppHeader con le cinque voci, nessuna bottom nav.
      await expect(page.getByRole('link', { name: 'Cucina', exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Navigazione principale' })).toBeVisible();
      await expect(heading(page, 'Cucina viva')).toBeVisible();
      await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toHaveCount(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Stato attuale · flag OFF (shell legacy)
// ---------------------------------------------------------------------------

const legacyLinks = [
  { label: 'Cucina', path: '/', heading: 'Cucina viva' },
  { label: 'Ricette', path: '/recipes', heading: 'Ricette' },
  { label: 'Dispensa', path: '/pantry', heading: 'La tua dispensa' },
  { label: 'Spesa', path: '/shopping-list', heading: 'Lista della spesa' },
  { label: 'Diario', path: '/dinner-diary', heading: 'Diario delle cene' },
] as const;

test.describe('stato attuale · flag OFF (shell legacy)', () => {
  test.skip(SOUS_CHEF_ON, 'build con VITE_SOUS_CHEF=true: la shell legacy non viene montata');

  test('header legacy visibile e nessuna bottom nav', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Cucina', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Profilo' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Casa' }).first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toHaveCount(0);
  });

  for (const link of legacyLinks) {
    test(`voce «${link.label}» dell'header apre ${link.path}`, async ({ page }) => {
      await page.goto('/');
      await page
        .getByRole('navigation', { name: 'Navigazione principale' })
        .getByRole('link', { name: link.label, exact: true })
        .click();
      await expect(page).toHaveURL(link.path);
      await expect(heading(page, link.heading)).toBeVisible();
    });
  }

  test('/discover non esiste con flag OFF (404)', async ({ page }) => {
    await page.goto('/discover');
    await expect(heading(page, 'Pagina non trovata')).toBeVisible();
  });

  test('/saved non esiste con flag OFF (404)', async ({ page }) => {
    await page.goto('/saved');
    await expect(heading(page, 'Pagina non trovata')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Stato attuale · flag ON (shell Sous-Chef)
// ---------------------------------------------------------------------------

test.describe('stato attuale · flag ON (shell Sous-Chef)', () => {
  test.skip(!SOUS_CHEF_ON, 'build senza VITE_SOUS_CHEF=true: la shell Sous-Chef non viene montata');

  test('shell: header semplificato e bottom nav, nessun header legacy', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Profilo' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toBeVisible();
    await expect(bottomNav(page).getByRole('link', { name: 'Chef' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cucina', exact: true })).toHaveCount(0);
  });

  // Aggiornato da T02: la bottom nav ora offre le cinque voci
  // Dispensa · Spesa · Chef · Piano · Ricette. «Cerca» e «Salvate» escono dalla
  // shell e restano raggiungibili per ingresso diretto (coperto qui sotto); le
  // loro funzioni vivono in /recipes (ricerca live + sezioni salvate/AI).
  test('la bottom nav non contiene più «Cerca» né «Salvate» (cinque voci T02)', async ({ page }) => {
    await page.goto('/');
    const navigation = bottomNav(page);
    await expect(navigation.getByRole('link', { name: 'Cerca', exact: true })).toHaveCount(0);
    await expect(navigation.getByRole('link', { name: 'Salvate', exact: true })).toHaveCount(0);
    await expect(navigation.getByRole('link')).toHaveCount(5);
  });

  test('/saved resta raggiungibile con ingresso diretto e mostra le ricette salvate', async ({ page }) => {
    await page.goto('/saved');
    await expect(page).toHaveURL('/saved');
    await expect(heading(page, 'Le tue ricette')).toBeVisible();
  });

  test('bottom nav «Chef» riporta alla schermata Chef dalla schermata Cerca', async ({ page }) => {
    await page.goto('/discover');
    await bottomNav(page).getByRole('link', { name: 'Chef' }).click();
    await expect(page).toHaveURL('/');
    await expect(heading(page, 'Cosa cuciniamo oggi?')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toBeVisible();
  });

  test('scorciatoia «Lista della spesa Bring» apre la lista spesa reale', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('group', { name: 'Prosegui in cucina' }).getByRole('link', { name: /Lista della spesa Bring/ }).click();
    await expect(page).toHaveURL('/shopping-list');
    await expect(heading(page, 'Lista della spesa')).toBeVisible();
  });

  test('scorciatoia «Ricettario» apre il catalogo ricette', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('group', { name: 'Prosegui in cucina' }).getByRole('link', { name: /Ricettario/ }).click();
    await expect(page).toHaveURL('/recipes');
    await expect(heading(page, 'Ricette')).toBeVisible();
  });

  test('scorciatoia Chef «Dispensa» apre la dispensa reale (/pantry)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('group', { name: 'Prosegui in cucina' }).getByRole('link', { name: /Dispensa/ }).click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
  });

  test('/discover e /profile restano raggiungibili anche con ingresso diretto', async ({ page }) => {
    await page.goto('/discover');
    await expect(heading(page, 'Cerca ricette')).toBeVisible();
    await page.goto('/profile');
    await expect(heading(page, 'Il tuo profilo')).toBeVisible();
  });

  test('Chef shows a local recipe and cooking destinations without mounting a chat composer', async ({ page }) => {
    await page.goto('/');
    await expect(heading(page, 'Cosa cuciniamo oggi?')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toBeVisible();
    await expect(page.getByPlaceholder(/Chiedimi una ricetta/i)).toHaveCount(0);
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invia messaggio' })).toHaveCount(0);
  });

  test('Chef destination cards open the current cooking routes', async ({ page }) => {
    await page.goto('/');
    const shortcuts = page.getByRole('group', { name: 'Prosegui in cucina' });
    for (const [label, path] of [
      ['Piano settimanale', '/plan'],
      ['Ricettario', '/recipes'],
      ['Dispensa', '/pantry'],
      ['Lista della spesa Bring', '/shopping-list'],
    ]) {
      await expect(shortcuts.getByRole('link', { name: new RegExp(label) })).toHaveAttribute('href', path);
    }
  });
});

// ---------------------------------------------------------------------------
// Verifica funzionale della shell Sous-Chef sul candidato corrente
// ---------------------------------------------------------------------------

test.describe('verifica funzionale · T02/T03/T05', () => {
  test.skip(!SOUS_CHEF_ON, 'build senza VITE_SOUS_CHEF=true: la shell Sous-Chef non viene montata');

  test('[T02] la bottom nav offre Dispensa · Spesa · Chef · Piano · Ricette', async ({ page }) => {
    await page.goto('/');
    const nav = bottomNav(page);
    for (const label of ['Dispensa', 'Spesa', 'Chef', 'Piano', 'Ricette']) {
      await expect(nav.getByRole('link', { name: label, exact: true }), `voce «${label}»`).toBeVisible();
    }
  });

  test('[T02] la voce «Piano» apre una destinazione effettiva, non la 404', async ({ page }) => {
    await page.goto('/');
    await bottomNav(page).getByRole('link', { name: 'Piano', exact: true }).click();
    await expect(heading(page, 'Pagina non trovata')).toHaveCount(0);
    await expect(page.locator('#main-content')).toBeVisible();
  });

  // Voce d'ingresso aggiornata da T02: il piano impone «Diario da Ricette»,
  // quindi l'accesso reale viene verificato dalla destinazione /recipes
  // (il click completo è coperto da e2e/sous-chef-shell.spec.ts).
  test('[T02] il Diario è raggiungibile dalla shell con flag ON', async ({ page }) => {
    await page.goto('/recipes');
    await expect(page.locator('a[href="/dinner-diary"]').first()).toBeVisible();
  });

  test('[T03] la scorciatoia «Dispensa» porta alla dispensa reale', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('group', { name: 'Prosegui in cucina' }).getByRole('link', { name: /Dispensa/ }).click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
  });

  test('[T05] le scorciatoie Chef sono raggiungibili col puntatore senza overlay', async ({ page }) => {
    await page.goto('/');
    const pantryLink = page.getByRole('group', { name: 'Prosegui in cucina' }).getByRole('link', { name: /Dispensa/ });
    await expect(pantryLink).toBeVisible();
    await pantryLink.click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
  });
});
