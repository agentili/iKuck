import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const verifiedSession = {
  authenticated: true,
  user: {
    id: 'pantry-recipe-user',
    email: 'recipes@example.test',
    emailVerifiedAt: '2026-09-12T10:00:00.000Z',
  },
  csrfToken: 'pantry-recipe-csrf',
  expiresAt: '2026-10-12T12:00:00.000Z',
} as const;

const draft = {
  title: 'Pasta al tonno',
  description: 'Una ricetta semplice con quello che hai in dispensa.',
  ingredients: [
    { name: 'Pasta', amount: '160 g' },
    { name: 'Tonno', amount: '1 scatoletta' },
  ],
  steps: ['Cuoci la pasta.', 'Aggiungi il tonno e mescola.'],
  diets: [],
  allergens: [],
} as const;

const savedRecipe = {
  ...draft,
  id: 'saved-pasta-tonno',
  source: 'ai',
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
} as const;

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('genera da dispensa, mostra l’anteprima e salva solo dopo conferma', async ({ page }) => {
  const submissions: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && ['/v1/recipes/generate', '/v1/ai-recipes/save'].includes(path)) {
      submissions.push({ path, body: request.postDataJSON() as Record<string, unknown> });
    }
  });

  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': { status: 200, json: verifiedSession },
      'GET /v1/house': { status: 200, json: { house: null } },
      'GET /v1/sync': { status: 200, json: { changes: [], nextCursor: 0 } },
      'POST /v1/sync': {
        status: 200,
        json: { uploaded: 0, downloaded: 0, pending: 0, complete: true },
      },
      'GET /v1/ai-recipes/consent': {
        status: 200,
        json: { consent: { enabled: false, updatedAt: '2026-09-12T10:00:00.000Z' }, selectedProvider: 'openai' },
      },
      'GET /v1/ai-recipes': { status: 200, json: { recipes: [] } },
      'POST /v1/recipes/generate': { status: 200, json: { kind: 'candidate', recipe: draft } },
      'POST /v1/ai-recipes/save': { status: 201, json: { recipe: savedRecipe } },
    },
  });

  await page.goto('/cucina');
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).first().click();
  const addDialog = page.getByRole('dialog', { name: 'Aggiungi ingredienti' });
  await addDialog.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno');
  await addDialog.getByRole('button', { name: 'Aggiungi ingredienti' }).click();

  const generateButton = page.getByRole('button', { name: 'Genera ricetta da dispensa' });
  await expect(generateButton).toBeEnabled();
  await generateButton.click();
  const preview = page.getByRole('dialog', { name: 'Anteprima ricetta' });
  await expect(preview.getByRole('heading', { name: draft.title })).toBeVisible();
  await expect(preview.getByText('Una ricetta semplice con quello che hai in dispensa.')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    path: '/v1/recipes/generate',
    body: { ingredients: ['Pasta', 'Tonno'] },
  });

  await preview.getByRole('button', { name: 'Salva nel ricettario' }).click();
  await expect(preview).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions.map(({ path }) => path)).toEqual([
    '/v1/recipes/generate',
    '/v1/ai-recipes/save',
  ]);
  expect(submissions[1].body).toMatchObject({
    recipe: { title: draft.title, source: 'ai' },
  });
});
