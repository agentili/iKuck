import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const verifiedSession = {
  authenticated: true,
  user: { id: 'dinner-user', email: 'dinner@example.com', emailVerifiedAt: '2026-09-15T08:00:00.000Z' },
  csrfToken: 'dinner-csrf',
  expiresAt: '2026-10-15T08:00:00.000Z',
};

const clearLocalDatabase = async (page: Page): Promise<void> => {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('ikuck-local-v2');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  }));
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page, {
    responses: {
      'GET /v1/auth/session': { json: verifiedSession },
      'GET /v1/profile': { json: { profile: { displayName: null } } },
      'GET /v1/house': { json: null },
      'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
      'POST /v1/sync': { json: { accepted: [], changes: [], nextCursor: 0 } },
      'GET /v1/ai-recipes': { json: { recipes: [] } },
    },
  });
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('keeps the diary usable at 320px with 200% text zoom', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route('**/v1/ai-recipes/consent', (route) => route.fulfill({
    json: { consent: { enabled: false, updatedAt: '2026-09-29T18:00:00.000Z' }, selectedProvider: 'openai' },
  }));
  await page.goto('/dinner-diary');
  await expect(page.getByRole('heading', { name: 'Diario delle cene' })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
  const consentDisclosure = page.getByRole('region', { name: 'Consenso per ricostruire ricette' }).locator('details');
  await expect(consentDisclosure).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Salva cena' })).toBeVisible();
  await expect(navigation).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await consentDisclosure.locator('summary').click();
  await expect(consentDisclosure).toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await consentDisclosure.locator('summary').press('Enter');
  await expect(consentDisclosure).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Salva cena' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  expect(await navigation.evaluate((element) => window.getComputedStyle(element).position)).toBe('fixed');
});

test('records a dinner, edits and confirms an AI draft, then finds it in recipe suggestions', async ({ page }) => {
  let consentEnabled = false;
  const homeConsentProvider = 'openai' as const;
  let dinnerConsentProvider: 'openai' | 'gemini' | null = null;
  let confirmationBody: unknown;
  const draft = {
    draftId: 'draft-from-openai-fixture',
    title: 'Pasta con zucchine',
    description: 'Una ricetta ricostruita dalla cena.',
    ingredients: [
      { name: 'pasta', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' },
      { name: 'zucchine', amount: '2', ingredientId: null, optional: false, provenance: 'provided' },
    ],
    steps: ['Cuoci la pasta.', 'Salta le zucchine e unisci tutto.'],
    servings: 2,
    durationMinutes: 20,
    diets: null,
    allergens: null,
    suggestedFields: ['title', 'description', 'ingredients', 'amounts', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens'],
  };

  await page.route('**/v1/ai-recipes/consent', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ json: {
        consent: { enabled: consentEnabled, updatedAt: '2026-09-29T18:00:00.000Z', ...(consentEnabled ? { homeProvider: homeConsentProvider } : {}), ...(dinnerConsentProvider === null ? {} : { dinnerProvider: dinnerConsentProvider }) },
        selectedProvider: 'openai',
      } });
      return;
    }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { enabled?: boolean; homeProvider?: 'openai' | 'gemini'; dinnerProvider?: 'openai' | 'gemini' | null; expectedRevision?: string };
      if (body.enabled === true || (body.dinnerProvider !== undefined && body.dinnerProvider !== null)) {
        expect(body.expectedRevision).toBeDefined();
      }
      if (body.enabled !== undefined) {
        if (body.enabled) expect(body.homeProvider).toBe(homeConsentProvider);
        consentEnabled = body.enabled;
        if (!consentEnabled) dinnerConsentProvider = null;
      }
      if (body.dinnerProvider !== undefined) {
        if (body.dinnerProvider !== null) expect(body.dinnerProvider).toBe(homeConsentProvider);
        dinnerConsentProvider = body.dinnerProvider;
      }
      await route.fulfill({ json: {
        consent: { enabled: consentEnabled, updatedAt: '2026-09-29T18:01:00.000Z', ...(consentEnabled ? { homeProvider: homeConsentProvider } : {}), ...(dinnerConsentProvider === null ? {} : { dinnerProvider: dinnerConsentProvider }) },
        selectedProvider: 'openai',
      } });
      return;
    }
    await route.fallback();
  });
  await page.route('**/v1/ai-dinner-reconstruction', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, json: { drafts: [draft] } });
  });
  await page.route('**/v1/dinner-entries/*/confirm-recipe', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { draft: typeof draft };
    confirmationBody = body;
    const entryId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    const savedRecipe = {
      id: 'saved-pasta-zucchine',
      title: body.draft.title,
      description: body.draft.description,
      ingredients: body.draft.ingredients,
      steps: body.draft.steps,
      servings: body.draft.servings,
      durationMinutes: body.draft.durationMinutes,
      diets: body.draft.diets,
      allergens: body.draft.allergens,
      suggestedFields: body.draft.suggestedFields,
      source: 'diary' as const,
      authorId: verifiedSession.user.id,
      createdAt: '2026-09-29T18:02:00.000Z',
      updatedAt: '2026-09-29T18:02:00.000Z',
    };
    const entry = {
      id: entryId,
      date: '2026-09-29',
      text: 'Pasta con zucchine saltate in padella.',
      servings: 2,
      note: null,
      recipes: [{ recipeId: savedRecipe.id, title: body.draft.title, source: 'diary' as const }],
      authorId: verifiedSession.user.id,
      createdAt: '2026-09-29T18:00:00.000Z',
      updatedAt: '2026-09-29T18:02:00.000Z',
    };
    await route.fulfill({ status: 200, json: { entry, recipe: savedRecipe } });
  });

  await page.goto('/pantry');
  await clearLocalDatabase(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
  await expect.poll(() => page.getByText('Account verificato').evaluateAll((items) => items.some((item) => item.getClientRects().length > 0))).toBe(true);
  await page.getByLabel('Ingredienti presenti').fill('pasta, zucchine');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();

  await page.getByRole('link', { name: 'Diario', exact: true }).click();
  await page.getByRole('link', { name: 'Cene', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Diario delle cene' })).toBeVisible();
  const consentDisclosure = page.getByRole('region', { name: 'Consenso per ricostruire ricette' }).locator('details');
  const globalConsent = page.getByRole('checkbox', { name: /OpenAI.*ingredienti della dispensa.*profilo alimentare/i });
  await expect(consentDisclosure).not.toHaveAttribute('open', '');
  await expect(globalConsent).not.toBeVisible();
  await consentDisclosure.locator('summary').click();
  await globalConsent.check();
  await page.getByRole('button', { name: 'Salva consenso AI globale' }).click();
  const dinnerConsent = page.getByRole('checkbox', { name: 'Acconsento all’invio a OpenAI del testo della cena e delle porzioni' });
  await dinnerConsent.check();
  await page.getByRole('button', { name: 'Salva consenso Dinner' }).click();
  await consentDisclosure.locator('summary').click();
  await expect(dinnerConsent).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Salva cena' })).toBeVisible();

  await page.getByLabel('Data della cena').fill('2026-09-29');
  await page.getByLabel('Porzioni (facoltative)').fill('2');
  await page.getByLabel('Com’è andata la cena?').fill('Pasta con zucchine saltate in padella.');
  await page.getByRole('button', { name: 'Salva cena' }).click();
  await page.getByRole('button', { name: 'Prepara bozze ricetta' }).click();
  await expect(page.getByText('Bozza 1 — non ancora salvata come ricetta')).toBeVisible();
  await page.getByRole('textbox', { name: 'Titolo ricetta' }).fill('Pasta e zucchine della cena');
  await expect(page.getByRole('button', { name: 'Conferma questa ricetta' })).toBeVisible();
  await page.getByRole('button', { name: 'Conferma questa ricetta' }).click();
  await expect(page.getByText('1 ricetta collegata')).toBeVisible();
  expect(confirmationBody).toMatchObject({ draft: { title: 'Pasta e zucchine della cena' } });

  await page.getByRole('link', { name: 'Cucina', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByRole('article', { name: 'Pasta e zucchine della cena' })).toHaveAttribute('data-availability', 'ready');
  await page.getByRole('link', { name: 'Apri Pasta e zucchine della cena' }).click();
  await expect(page.getByRole('heading', { name: 'Pasta e zucchine della cena' })).toBeVisible();
  await expect(page.getByText('zucchine', { exact: true })).toBeVisible();

  await page.goto('/dinner-diary');
  const closedConsent = page.getByRole('region', { name: 'Consenso per ricostruire ricette' }).locator('details');
  await expect(closedConsent).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Revoca consenso Dinner' })).toBeVisible();
  await page.getByRole('button', { name: 'Revoca consenso Dinner' }).click();
  await expect.poll(() => dinnerConsentProvider).toBeNull();
  await expect(page.getByRole('button', { name: 'Revoca consenso Dinner' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoca consenso AI globale' })).toBeVisible();
  await page.getByRole('button', { name: 'Revoca consenso AI globale' }).click();
  await expect.poll(() => consentEnabled).toBe(false);
  await expect(page.getByRole('button', { name: 'Revoca consenso AI globale' })).toHaveCount(0);
  await expect(closedConsent).not.toHaveAttribute('open', '');
});
