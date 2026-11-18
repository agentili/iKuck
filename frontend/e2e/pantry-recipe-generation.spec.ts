import { expect, test } from '@playwright/test';
import type { AiConsent, DietProfilePayload, GeneratedRecipe, GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';
import { DEFAULT_DIET_PROFILE } from '../src/domain/dietary';

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

const dietProfile: DietProfilePayload = DEFAULT_DIET_PROFILE;

const consent: AiConsent = {
  enabled: true,
  homeProvider: 'openai',
  updatedAt: '2026-09-12T10:00:00.000Z',
};

const draft: GeneratedRecipeDraft = {
  title: 'Pasta al tonno',
  description: 'Una ricetta semplice con quello che hai in dispensa.',
  ingredients: [
    { name: 'Pasta', amount: '160 g' },
    { name: 'Tonno', amount: '1 scatoletta' },
  ],
  steps: ['Cuoci la pasta.', 'Aggiungi il tonno e mescola.'],
  diets: ['pescatarian'],
  allergens: ['fish'],
};

const savedRecipe: GeneratedRecipe = {
  ...draft,
  id: 'saved-pasta-tonno',
  source: 'ai',
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
};

const longDraft: GeneratedRecipeDraft = {
  ...draft,
  title: 'Pasta al tonno in più passaggi',
  steps: Array.from({ length: 36 }, (_, index) => `Passaggio ${index + 1}: prepara gli ingredienti e mescola con cura.`),
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('genera da dispensa, mostra l’anteprima e salva solo dopo conferma', async ({ page }) => {
  const submissions: Array<{ path: string; body: Record<string, unknown> }> = [];
  const savedRecipes: GeneratedRecipe[] = [];
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
        json: { consent, selectedProvider: 'openai' },
      },
      'GET /v1/ai-recipes': { status: 200, json: () => ({ recipes: savedRecipes }) },
      'POST /v1/recipes/generate': { status: 200, json: { kind: 'candidate', recipe: draft } },
      'POST /v1/ai-recipes/save': {
        status: 201,
        json: () => {
          savedRecipes.splice(0, savedRecipes.length, savedRecipe);
          return { recipe: savedRecipe };
        },
      },
    },
  });

  const initialCollectionResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/v1/ai-recipes'
  ));
  await page.goto('/cucina');
  await initialCollectionResponse;
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
  const aiPanel = page.getByRole('region', { name: 'Ricette AI private' });
  await expect(aiPanel.locator('[data-ai-recipe]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).first().click();
  const addDialog = page.getByRole('dialog', { name: 'Aggiungi ingredienti' });
  await addDialog.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno');
  await addDialog.getByRole('button', { name: 'Aggiungi ingredienti' }).click();

  const generateButton = page.getByRole('button', { name: 'Genera ricetta da dispensa' });
  await expect(generateButton).toBeEnabled();
  await generateButton.click();
  const preview = page.getByRole('dialog', { name: 'Anteprima ricetta' });
  await expect(preview.getByRole('heading', { name: draft.title })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Anteprima ricetta' })).toBeFocused();
  await expect(preview.getByText('Una ricetta semplice con quello che hai in dispensa.')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    path: '/v1/recipes/generate',
    body: {
      ingredients: ['Pasta', 'Tonno'],
      dietProfile,
    },
  });

  await preview.getByRole('button', { name: 'Salva nel ricettario' }).click();
  await expect(preview).toHaveCount(0);
  await expect(generateButton).toBeFocused();
  const savedCard = aiPanel.locator('[data-ai-recipe]');
  await expect(savedCard).toHaveCount(1);
  await expect(savedCard.getByRole('heading', { name: savedRecipe.title })).toBeVisible();
  await expect(savedCard.getByText(savedRecipe.description)).toBeVisible();
  await expect(page).toHaveURL(/\/cucina$/);
  expect(submissions).toHaveLength(2);
  expect(submissions.map(({ path }) => path)).toEqual([
    '/v1/recipes/generate',
    '/v1/ai-recipes/save',
  ]);
  expect(submissions[1].body).toMatchObject({
    recipe: { title: draft.title, source: 'ai' },
  });
});

test('mantiene raggiungibili i comandi con una ricetta lunga su schermo piccolo', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': { status: 200, json: verifiedSession },
      'GET /v1/house': { status: 200, json: { house: null } },
      'GET /v1/sync': { status: 200, json: { changes: [], nextCursor: 0 } },
      'POST /v1/sync': { status: 200, json: { uploaded: 0, downloaded: 0, pending: 0, complete: true } },
      'GET /v1/ai-recipes/consent': { status: 200, json: { consent, selectedProvider: 'openai' } },
      'GET /v1/ai-recipes': { status: 200, json: { recipes: [] } },
      'POST /v1/recipes/generate': { status: 200, json: { kind: 'candidate', recipe: longDraft } },
    },
  });

  await page.goto('/cucina');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).first().click();
  const addDialog = page.getByRole('dialog', { name: 'Aggiungi ingredienti' });
  await addDialog.getByRole('combobox', { name: 'Ingredienti presenti' }).fill('pasta, tonno');
  await addDialog.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('button', { name: 'Genera ricetta da dispensa' }).click();

  const preview = page.getByRole('dialog', { name: 'Anteprima ricetta' });
  await expect(preview.getByRole('heading', { name: longDraft.title })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Anteprima ricetta' })).toBeFocused();
  const discardButton = preview.getByRole('button', { name: 'Scarta', exact: true });
  const closeButton = preview.getByRole('button', { name: 'Scarta anteprima' });
  await page.keyboard.press('Shift+Tab');
  await expect(discardButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();

  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const dialogBounds = await preview.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds!.height).toBeLessThanOrEqual(viewportHeight);
  expect(dialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(viewportHeight);

  const recipeContent = preview.locator('.overflow-y-auto').first();
  await expect(recipeContent).toHaveCount(1);
  const contentSize = await recipeContent.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(contentSize.scrollHeight).toBeGreaterThan(contentSize.clientHeight);
  await expect(preview.getByRole('button', { name: 'Salva nel ricettario' })).toBeInViewport();
});
