import { expect, test, type Page } from '@playwright/test';
import {
  assertOfflineBackendClean,
  installOfflineBackend,
  type OfflineApiResponse,
} from './helpers/backendMode';

/** Route e flussi della PWA con interfaccia Sous Chef. */

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
// Stato attuale · route condivise
// ---------------------------------------------------------------------------

const sharedRoutes = [
  { path: '/recipes', heading: 'Ricette' },
  { path: '/pantry', heading: 'La tua dispensa' },
  { path: '/shopping-list', heading: 'Lista della spesa' },
  { path: '/activity', heading: 'La tua attività' },
  { path: '/profile', heading: 'Il tuo profilo' },
  { path: '/house', heading: 'La mia casa' },
  { path: '/recipes/pasta-tonno-pomodoro', heading: 'Pasta tonno e pomodoro' },
] as const;

test.describe('stato attuale · route condivise', () => {
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

  test('la shell Sous Chef è sempre presente', async ({ page }) => {
    await page.goto('/');

    // Shell Sous-Chef: header semplificato + bottom nav, nessun header legacy.
    await expect(page.getByRole('button', { name: 'Profilo' })).toBeVisible();
    await expect(bottomNav(page).getByRole('link', { name: 'Chef' })).toBeVisible();
    await expect(heading(page, 'Oggi lo chef propone...')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Cucina', exact: true })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Shell Sous Chef
// ---------------------------------------------------------------------------

test.describe('shell Sous Chef', () => {
  test('shell: header semplificato e bottom nav, nessun header legacy', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Profilo' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toHaveCount(0);
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
    await expect(heading(page, 'Oggi lo chef propone...')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toHaveCount(0);
  });

  test('voce «Spesa» apre la lista spesa reale', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: /^Spesa$/ }).click();
    await expect(page).toHaveURL('/shopping-list');
    await expect(heading(page, 'Lista della spesa')).toBeVisible();
  });

  test('voce «Ricette» apre il catalogo ricette', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: /^Ricette$/ }).click();
    await expect(page).toHaveURL('/recipes');
    await expect(heading(page, 'Ricette')).toBeVisible();
  });

  test('voce «Dispensa» apre la dispensa reale (/pantry)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: /Dispensa/ }).click();
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
    await expect(heading(page, 'Oggi lo chef propone...')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ricetta del giorno' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Prosegui in cucina' })).toHaveCount(0);
    await expect(page.getByPlaceholder(/Chiedimi una ricetta/i)).toHaveCount(0);
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invia messaggio' })).toHaveCount(0);
  });

  test('Chef bottom navigation links open the current cooking routes', async ({ page }) => {
    await page.goto('/');
    const shortcuts = page.getByRole('navigation', { name: 'Navigazione principale' });
    for (const [label, path] of [
      ['Piano', '/plan'],
      ['Ricette', '/recipes'],
      ['Dispensa', '/pantry'],
      ['Spesa', '/shopping-list'],
    ]) {
      await expect(shortcuts.getByRole('link', { name: new RegExp(label) })).toHaveAttribute('href', path);
    }
  });
});

// ---------------------------------------------------------------------------
// Verifica funzionale della shell Sous-Chef sul candidato corrente
// ---------------------------------------------------------------------------

test.describe('verifica funzionale · T02/T03/T05', () => {
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


  test('[T03] la voce «Dispensa» porta alla dispensa reale', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: /Dispensa/ }).click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
  });

  test('[T05] le voci della bottom nav sono raggiungibili col puntatore senza overlay', async ({ page }) => {
    await page.goto('/');
    const pantryLink = page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: /Dispensa/ });
    await expect(pantryLink).toBeVisible();
    await pantryLink.click();
    await expect(page).toHaveURL('/pantry');
    await expect(heading(page, 'La tua dispensa')).toBeVisible();
  });
});
