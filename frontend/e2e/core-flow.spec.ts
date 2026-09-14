import { expect, test, type Page } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const waitForDietProfilePersistence = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => new Promise<boolean>((resolve) => {
    const request = indexedDB.open('ikuck-local-v2');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const database = request.result;
      try {
        const read = database.transaction('keyValue', 'readonly').objectStore('keyValue').get('diet-profile');
        read.onerror = () => {
          database.close();
          resolve(false);
        };
        read.onsuccess = () => {
          const value = read.result;
          database.close();
          if (typeof value !== 'string') {
            resolve(false);
            return;
          }
          try {
            const profile = JSON.parse(value) as { profile?: { excludedAllergens?: unknown } };
            resolve(Array.isArray(profile.profile?.excludedAllergens) && profile.profile.excludedAllergens.includes('fish'));
          } catch {
            resolve(false);
          }
        };
      } catch {
        database.close();
        resolve(false);
      }
    };
  }));
};

test.beforeEach(async ({ context, page }) => {
  await context.clearCookies();
  await installOfflineBackend(page);
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

test('user adds pantry items, requests recipes and opens one', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  await expect(page.getByText('Hai tutto').first()).toBeVisible();
  await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  await expect(page.getByRole('heading', { name: 'Ingredienti' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
});

test('pantry survives reload and extended mode names one missing ingredient', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta, uova, pancetta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.reload();
  await expect(page.getByText('Pancetta', { exact: true })).toBeVisible();
  await page.getByLabel('Anche con 1 ingrediente in più').check();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText('Ti manca solo: Parmigiano')).toBeVisible();
});

test('the core flow works at 320px using only the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accedi o registrati' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accedi con Google' })).toBeVisible();
  for (let step = 0; step < 12; step += 1) {
    if (await page.getByLabel('Ingredienti presenti').evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(page.getByLabel('Ingredienti presenti')).toBeFocused();
  await page.keyboard.type('pasta, tonno, passata');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Passata di pomodoro', { exact: true })).toBeVisible();

  const searchButton = page.getByRole('button', { name: 'Trova ricette' });
  for (let step = 0; step < 60; step += 1) {
    if (await searchButton.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(searchButton).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test('suggested ingredients can be added without typing', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  const suggestions = page.getByRole('region', { name: 'Potresti aggiungere' });
  await expect(suggestions.getByRole('button', { name: 'Aggiungi Cipolla' })).toBeVisible();
  await suggestions.getByRole('button', { name: 'Aggiungi Cipolla' }).click();

  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Cipolla')).toBeVisible();
  await expect(suggestions.getByRole('button', { name: 'Aggiungi Cipolla' })).toHaveCount(0);
});

test('local suggestions refresh after pantry and diet changes', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  const pantry = page.getByRole('list', { name: 'La tua dispensa' });
  const ingredientInput = page.getByLabel('Ingredienti presenti');
  await ingredientInput.fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByRole('heading', { name: 'Ricette per te' })).toBeVisible();
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);

  await ingredientInput.fill('tonno, passata, ceci, aglio, melanzane, basilico, uova');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  const pantryAfterUpdate = await pantry.innerText();
  const initialOrder = await page.getByRole('link', { name: /^Apri / }).evaluateAll(
    (links) => links.map((link) => link.getAttribute('href')),
  );
  await page.getByRole('button', { name: 'Altre idee' }).click();
  await expect.poll(async () => page.getByRole('link', { name: /^Apri / }).evaluateAll(
    (links) => links.map((link) => link.getAttribute('href')),
  )).not.toEqual(initialOrder);
  expect(await pantry.innerText()).toBe(pantryAfterUpdate);

  await page.getByLabel('Dieta').selectOption('vegan');
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ricette per te' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await expect(page.getByText('Tonno', { exact: true })).toBeVisible();
});

test('diet and allergen filters block recipes and explain nutrition estimates', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  await page.getByLabel('Dieta').selectOption('vegetarian');
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);
  await page.getByLabel('Dieta').selectOption('omnivore');
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  const fishExclusion = page.getByLabel('Escludi pesce');
  await fishExclusion.check();
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);
  await fishExclusion.uncheck();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  await expect(page.getByRole('heading', { name: 'Nutrizione stimata per porzione' })).toBeVisible();
  await expect(page.getByText('Stima indicativa')).toBeVisible();
  await expect(page.getByText(/Allergeni dichiarati: glutine, pesce/)).toBeVisible();
});

test('nutrition filters persist and keep the narrow layout without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('button', { name: 'Trova ricette' }).click();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  await page.getByLabel('Calorie massime per porzione').fill('400');
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);
  await page.getByLabel('Escludi pesce').check();
  await expect(page.getByLabel('Escludi pesce')).toBeChecked();
  await waitForDietProfilePersistence(page);
  await page.reload();
  await expect(page.getByLabel('Calorie massime per porzione')).toHaveValue('400');
  await expect(page.getByLabel('Escludi pesce')).toBeChecked();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test('shopping list accepts manual and recipe-derived items offline', async ({ page }) => {
  await page.goto('/shopping-list');
  await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
  await page.getByLabel('Cosa ti serve?').fill('latte');
  await page.getByText('Aggiungi dettagli (facoltativi)').click();
  await page.getByLabel('Quantità da acquistare').fill('1');
  await page.getByLabel('Unità di misura della spesa').selectOption('l');
  await page.getByRole('button', { name: 'Aggiungi alla lista' }).click();
  await expect(page.getByText('Latte', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Segna Latte come acquistato' }).click();
  await expect(page.getByRole('heading', { name: /Acquistati/ })).toBeVisible();

  await page.goto('/recipes/pasta-tonno-pomodoro');
  await page.getByRole('button', { name: 'Aggiungi mancanti alla spesa' }).click();
  await expect(page.getByRole('link', { name: 'Apri la lista della spesa' })).toBeVisible();
  await page.getByRole('link', { name: 'Apri la lista della spesa' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
});

test('activity records cooking, preferences and private notes offline', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.goto('/recipes/pasta-tonno-pomodoro');

  await page.getByRole('button', { name: 'Segna come cucinata' }).click();
  await expect(page.getByRole('status')).toHaveText('Ricetta aggiunta alla cronologia.');
  await page.getByRole('button', { name: 'Aggiungi ai preferiti' }).click();
  await page.getByRole('button', { name: 'Valuta Pasta tonno e pomodoro: 5 stelle' }).click();
  await page.getByLabel('Nota privata sulla ricetta').fill('Da rifare presto');
  await page.getByRole('button', { name: 'Salva preferenza' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Preferenza salvata.' })).toHaveText('Preferenza salvata.');

  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'La tua attività' })).toBeVisible();
  await expect(page.getByText('Pasta tonno e pomodoro', { exact: true })).toHaveCount(2);
  await expect(page.getByText(/Da rifare presto/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Da rifare presto/)).toBeVisible();
});

test('manifest is available and the application works offline after first load', async ({ page, context }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/iKuck/);

  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('iKuck');
  expect(manifest.start_url).toBe('/');

  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Cosa c’è in dispensa/i })).toBeVisible();
  await context.setOffline(false);
});

test('verified users can consent to private AI recipes without changing pantry lots', async ({ page }) => {
  let consentEnabled = false;
  const recipes: Array<Record<string, unknown>> = [];
  const generationBodies: unknown[] = [];

  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'browser-user', email: 'browser@example.com', emailVerifiedAt: '2026-09-13T12:00:00.000Z' },
        csrfToken: 'csrf-token',
        expiresAt: '2026-10-13T12:00:00.000Z',
      }),
    });
  });

  await page.route('**/v1/sync', async (route) => {
    await route.fulfill({ status: 200, json: { changes: [], nextCursor: 0 } });
  });

  await page.route('**/v1/ai-recipes**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/ai-recipes/consent' && request.method() === 'GET') {
      await route.fulfill({ json: { consent: { enabled: consentEnabled, updatedAt: '2026-09-13T12:00:00.000Z' } } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes/consent' && request.method() === 'PUT') {
      const body = request.postDataJSON() as { enabled: boolean };
      consentEnabled = body.enabled;
      await route.fulfill({ json: { consent: { enabled: consentEnabled, updatedAt: '2026-09-13T12:01:00.000Z' } } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes' && request.method() === 'GET') {
      await route.fulfill({ json: { recipes } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes' && request.method() === 'POST') {
      generationBodies.push(request.postDataJSON());
      const recipe = {
        id: 'browser-ai-recipe',
        source: 'ai',
        title: 'Ceci croccanti al pomodoro',
        description: 'Una ricetta privata di prova.',
        ingredients: [{ name: 'Ceci', amount: '240 g' }, { name: 'Pomodoro', amount: '200 g' }],
        steps: ['Scola i ceci.', 'Cuoci tutto in padella.'],
        diets: ['vegan'],
        allergens: [],
        createdAt: '2026-09-13T12:02:00.000Z',
        updatedAt: '2026-09-13T12:02:00.000Z',
      };
      recipes.unshift(recipe);
      await route.fulfill({ status: 201, json: { recipe, quota: { allowed: true, used: 1, remaining: 4 } } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes/browser-ai-recipe' && request.method() === 'DELETE') {
      recipes.splice(0, recipes.length);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.getByLabel('Ingredienti presenti').fill('ceci, pomodoro');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('button', { name: 'Aggiungi lotto' }).first().click();
  await page.getByLabel('Quantità del lotto').fill('500');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();

  const pantry = page.getByRole('list', { name: 'La tua dispensa' });
  const pantryBefore = await pantry.innerText();
  const lots = page.getByRole('list', { name: 'Lotti di Ceci' });
  const lotsBefore = await lots.innerText();
  const aiPanel = page.getByRole('region', { name: 'Ricette AI private' });
  const consent = aiPanel.getByRole('checkbox', { name: /acconsento all’uso degli ingredienti/i });
  await expect(consent).toBeVisible();
  await consent.check();
  await aiPanel.getByRole('button', { name: 'Salva consenso' }).click();
  await aiPanel.getByRole('button', { name: 'Genera ricetta AI' }).click();
  await expect(aiPanel.getByRole('heading', { name: 'Ceci croccanti al pomodoro' })).toBeVisible();
  expect(generationBodies).toHaveLength(1);
  expect(generationBodies[0]).toMatchObject({ ingredients: ['Ceci', 'Pomodoro'] });
  expect(await pantry.innerText()).toBe(pantryBefore);
  expect(await lots.innerText()).toBe(lotsBefore);

  await page.reload();
  await expect(page.getByRole('region', { name: 'Ricette AI private' }).getByRole('heading', { name: 'Ceci croccanti al pomodoro' })).toBeVisible();
  const reloadedAiPanel = page.getByRole('region', { name: 'Ricette AI private' });
  await reloadedAiPanel.getByRole('checkbox', { name: /acconsento all’uso degli ingredienti/i }).uncheck();
  await reloadedAiPanel.getByRole('button', { name: 'Salva consenso' }).click();
  await expect(reloadedAiPanel.getByRole('button', { name: 'Genera ricetta AI' })).toHaveCount(0);
  await expect(reloadedAiPanel.getByRole('heading', { name: 'Ceci croccanti al pomodoro' })).toBeVisible();
});
