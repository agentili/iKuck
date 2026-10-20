import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  assertOfflineBackendClean,
  installOfflineBackend,
  type OfflineApiResponse,
} from './helpers/backendMode';

const themePreferenceKey = 'ikuck-color-theme';

const verifiedSession = {
  authenticated: true,
  user: {
    id: 'recipes-user-1',
    email: 'ale@example.com',
    emailVerifiedAt: '2026-09-12T10:00:00.000Z',
  },
  csrfToken: 'recipes-csrf-1',
  expiresAt: '2026-10-12T12:00:00.000Z',
} as const;

const savedRecipes = [
  {
    id: 'saved-orata-al-forno',
    source: 'ai',
    title: 'Orata al forno',
    description: 'Orata al forno con patate e rosmarino.',
    ingredients: [
      { name: 'orata', amount: '1 intera' },
      { name: 'patate', amount: '400 g' },
      { name: 'rosmarino', amount: 'q.b.' },
    ],
    steps: [
      'Pulisci l’orata, salala e disponila in una teglia.',
      'Aggiungi patate a spicchi, olio e rosmarino.',
      'Cuoci in forno statico a 200 °C per 25 minuti.',
    ],
    diets: [],
    allergens: [],
    createdAt: '2026-09-20T18:00:00.000Z',
    updatedAt: '2026-09-20T18:00:00.000Z',
  },
  {
    id: 'saved-pollo-al-forno',
    source: 'ai',
    title: 'Pollo al forno',
    description: 'Bocconcini di pollo rosolati al forno.',
    ingredients: [
      { name: 'pollo', amount: '400 g' },
      { name: 'limone', amount: '1' },
    ],
    steps: ['Rosola il pollo in padella.', 'Completa in forno con il succo di limone.'],
    diets: [],
    allergens: [],
    createdAt: '2026-09-19T18:00:00.000Z',
    updatedAt: '2026-09-19T18:00:00.000Z',
  },
];

const installVerifiedBackend = async (
  page: Page,
  extraResponses: Record<string, OfflineApiResponse> = {},
): Promise<void> => {
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': { status: 200, json: verifiedSession },
      'GET /v1/house': { status: 200, json: { house: null } },
      'GET /v1/sync': { status: 200, json: { changes: [], nextCursor: 0 } },
      'POST /v1/sync': {
        status: 200,
        json: { uploaded: 0, downloaded: 0, pending: 0, complete: true },
      },
      'GET /v1/ai-recipes': { status: 200, json: { recipes: savedRecipes } },
      ...extraResponses,
    },
  });
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('ricerca «orata»: restano solo le ricette con orata in titolo o ingredienti', async ({
  page,
}) => {
  await installVerifiedBackend(page);
  await page.goto('/recipes');
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();

  // Query vuota: elenco completo di salvate e catalogo.
  await expect(page.getByRole('heading', { name: 'Orata al forno' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pollo al forno' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Cerca ricette' }).fill('orata');

  await expect(page.getByRole('heading', { name: 'Orata al forno' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pollo al forno' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Apri / })).toHaveCount(0);

  // Query vuota: torna l'elenco completo.
  await page.getByRole('searchbox', { name: 'Cerca ricette' }).fill('');
  await expect(page.getByRole('heading', { name: 'Pollo al forno' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();
});

test('ricerca senza match: stato vuoto con CTA «Trova ricette»', async ({ page }) => {
  await installVerifiedBackend(page);
  await page.goto('/recipes');
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Cerca ricette' }).fill('nessuna-corrispondenza');
  await expect(
    page.getByText(
      'Nessuna ricetta trovata per «nessuna-corrispondenza». Prova un altro titolo o ingrediente.',
    ),
  ).toBeVisible();
  const cta = page.getByRole('link', { name: 'Trova ricette' });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute('href', '/');
});

test('gruppo salvate: la card espandibile mostra ingredienti e procedimento', async ({
  page,
}) => {
  await installVerifiedBackend(page);
  await page.goto('/recipes');
  const orataCard = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Orata al forno' }) });
  await expect(orataCard).toBeVisible();
  await expect(orataCard.getByRole('button', { name: 'Mostra dettagli' })).toBeVisible();
  await orataCard.getByRole('button', { name: 'Mostra dettagli' }).click();
  await expect(orataCard.getByRole('button', { name: 'Nascondi dettagli' })).toBeVisible();
  await expect(orataCard.getByText('orata', { exact: true })).toBeVisible();
  await expect(
    orataCard.getByText('Cuoci in forno statico a 200 °C per 25 minuti.'),
  ).toBeVisible();
});

test('gruppo suggerite: la card apre /recipes/:recipeId', async ({ page }) => {
  await installVerifiedBackend(page);
  await page.goto('/recipes');
  await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  await expect(page).toHaveURL('/recipes/pasta-tonno-pomodoro');
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
});

test('ospite: catalogo visibile, gruppo salvate con CTA accesso', async ({ page }) => {
  // Nessuna sessione verificata: il backend offline di base risponde authenticated: false
  // e la pagina non chiama fetchAiRecipes.
  await page.goto('/recipes');
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ricette suggerite' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ricette AI riservate agli account verificati' })).toBeVisible();
  const accessLink = page.getByRole('link', { name: 'Accedi al tuo account' });
  await expect(accessLink).toBeVisible();
  await expect(accessLink).toHaveAttribute('href', '/profile');
  await expect(page.getByRole('button', { name: /Mostra dettagli/ })).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe: zero violazioni su /recipes in modalità ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(
      ({ key, preference }: { key: string; preference: 'light' | 'dark' }) => {
        localStorage.setItem(key, preference);
      },
      { key: themePreferenceKey, preference: theme },
    );
    await installVerifiedBackend(page);
    await page.goto('/recipes');
    await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `${theme} axe violations on /recipes`).toEqual([]);
  });
}

test('nav: «Ricette» raggiungibile, nome accessibile completo, nessun overflow a 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await page.route('**/v1/house', (route) => route.fulfill({ status: 200, json: { house: null } }));
  await page.goto('/');

  const ricette = page.getByRole('link', { name: 'Ricette' });
  await expect(ricette).toBeVisible();

  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    nav: document
      .querySelector('nav[aria-label="Navigazione principale"]')
      ?.getBoundingClientRect()
      .toJSON() ?? null,
    main: document.querySelector('main#main-content')?.getBoundingClientRect()?.toJSON() ?? null,
  }));
  expect(
    geometry.content,
    `overflow orizzontale a 320px: ${JSON.stringify(geometry)}`,
  ).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.nav).not.toBeNull();
  expect(geometry.main).not.toBeNull();
});

test('offline: catalogo consultabile, gruppo salvate in errore non bloccante', async ({
  page,
  context,
}) => {
  // Tutto il bootstrap è mockato tranne GET /v1/ai-recipes: deve fallire offline.
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': { status: 200, json: verifiedSession },
      'GET /v1/house': { status: 200, json: { house: null } },
      'GET /v1/sync': { status: 200, json: { changes: [], nextCursor: 0 } },
      'POST /v1/sync': {
        status: 200,
        json: { uploaded: 0, downloaded: 0, pending: 0, complete: true },
      },
    },
  });
  await page.route('**/v1/ai-recipes', (route) => route.abort());
  await page.goto('/recipes');
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();

  // Il catalogo statico resta consultabile offline.
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();

  // Il gruppo salvate è in stato d'errore ma non blocca la pagina.
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByText(
      'Servizio non raggiungibile: le ricette AI restano disponibili solo online.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Orata al forno' })).toHaveCount(0);

  await context.setOffline(true);
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
});
