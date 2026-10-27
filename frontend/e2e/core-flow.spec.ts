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

const waitForActivityPersistence = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => new Promise<boolean>((resolve) => {
    const request = indexedDB.open('ikuck-local-v2');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const database = request.result;
      try {
        const store = database.transaction('keyValue', 'readonly').objectStore('keyValue');
        const events = store.get('activity');
        const preferences = store.get('recipe-preferences');
        events.onerror = () => { database.close(); resolve(false); };
        preferences.onerror = () => { database.close(); resolve(false); };
        preferences.onsuccess = () => {
          const eventValue = events.result;
          const preferenceValue = preferences.result;
          database.close();
          if (typeof eventValue !== 'string' || typeof preferenceValue !== 'string') {
            resolve(false);
            return;
          }
          try {
            const eventItems = JSON.parse(eventValue) as { items?: Array<{ recipeId?: string }> };
            const preferenceItems = JSON.parse(preferenceValue) as { items?: Array<{ recipeId?: string; note?: string }> };
            resolve(eventItems.items?.some((item) => item.recipeId === 'pasta-tonno-pomodoro') === true
              && preferenceItems.items?.some((item) => item.recipeId === 'pasta-tonno-pomodoro' && item.note === 'Da rifare presto') === true);
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
  await page.route('**/v1/house', (route) => route.fulfill({ status: 200, json: null }));
});

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

const resetPantry = async (page: Page): Promise<void> => {
  await page.goto('/pantry');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
};

const openHomeRecipes = async (page: Page): Promise<void> => {
  await page.getByRole('link', { name: 'Vai alle ricette' }).click();
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
};

const openPantry = async (page: Page): Promise<void> => {
  await page.getByRole('link', { name: 'Dispensa', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
};

test('pantry autocomplete dismisses suggestions, accepts free text and survives reload', async ({ page }) => {
  await resetPantry(page);
  const input = page.getByRole('combobox', { name: 'Ingredienti presenti' });
  await input.fill('pom');
  await expect(page.getByRole('listbox', { name: 'Ingredienti suggeriti' })).toBeVisible();
  await input.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Ingredienti suggeriti' })).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.fill('pomodoro, ingrediente libero');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  const pantry = page.getByRole('list', { name: 'La tua dispensa' });
  await expect(pantry.getByText('Pomodoro', { exact: true })).toBeVisible();
  await expect(pantry.getByText('ingrediente libero', { exact: true })).toBeVisible();
  await page.reload();
  await expect(pantry.getByText('Pomodoro', { exact: true })).toBeVisible();
  await expect(pantry.getByText('ingrediente libero', { exact: true })).toBeVisible();
});

test('user adds pantry items, gets automatic ideas and opens one', async ({ page }) => {
  await resetPantry(page);

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  await expect(page.getByText('Hai tutto').first()).toBeVisible();
  await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  await expect(page.getByRole('heading', { name: 'Ingredienti', level: 2, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
});

test('verified local recipe imagery is labelled and remains available offline with an honest fallback', async ({ page, context }) => {
  await resetPantry(page);
  await page.getByLabel('Ingredienti presenti').fill('uova, passata, aglio');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByRole('link', { name: 'Vai alle ricette' }).click();
  const photoAlt = /foto illustrativa, non una riproduzione esatta/i;
  await page.getByRole('link', { name: 'Apri Uova al pomodoro' }).click();
  await expect(page.getByRole('heading', { name: 'Uova al pomodoro' })).toBeVisible();
  await expect(page.getByRole('img', { name: photoAlt })).toBeVisible();
  expect(await page.getByRole('img', { name: photoAlt }).getAttribute('src')).toBe('/recipe-images/uova-al-pomodoro.webp');
  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('img', { name: photoAlt })).toBeVisible();
  await context.setOffline(false);
});

test('pantry survives reload and automatic ideas add the missing ingredient to shopping once', async ({ page }) => {
  await resetPantry(page);

  await page.getByLabel('Ingredienti presenti').fill('pasta, uova, pancetta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.reload();
  await expect(page.getByText('Pancetta', { exact: true })).toBeVisible();
  await openHomeRecipes(page);
  const recipe = page.getByRole('article', { name: 'Carbonara semplice' });
  await expect(recipe).toContainText('Ti manca solo: Parmigiano');
  await recipe.getByRole('button', { name: 'Aggiungi Parmigiano alla lista della spesa' }).click();
  await expect(recipe.getByRole('button', { name: 'Aggiungi Parmigiano alla lista della spesa' })).toHaveCount(0);
  await recipe.getByRole('link', { name: 'Apri lista della spesa' }).click();
  const shopping = page.getByRole('region', { name: /Da acquistare/ });
  await expect(shopping.getByRole('button', { name: 'Segna Parmigiano come acquistato', exact: true })).toHaveCount(1);
  await page.reload();
  await expect(shopping.getByRole('button', { name: 'Segna Parmigiano come acquistato', exact: true })).toHaveCount(1);
  await openPantry(page);
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pancetta', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Parmigiano', { exact: true })).toHaveCount(0);
});

test('the core flow works at 320px using only the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await resetPantry(page);

  await expect(page.getByLabel('Ingredienti presenti')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Profilo' })).toBeVisible();
  for (let step = 0; step < 12; step += 1) {
    if (await page.getByLabel('Ingredienti presenti').evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(page.getByLabel('Ingredienti presenti')).toBeFocused();
  await page.keyboard.type('pasta, tonno, passata');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Passata di pomodoro', { exact: true })).toBeVisible();

  const recipesLink = page.getByRole('link', { name: 'Vai alle ricette' });
  for (let step = 0; step < 60; step += 1) {
    if (await recipesLink.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(recipesLink).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeVisible();
  const recipeLink = page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' });
  for (let step = 0; step < 60; step += 1) {
    if (await recipeLink.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(recipeLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Pasta tonno e pomodoro', level: 1 })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test('keeps the pantry action visible above mobile navigation on empty Home', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const action = page.getByRole('link', { name: 'Aggiungi un ingrediente' });
  const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
  const [actionBox, navigationBox] = await Promise.all([action.boundingBox(), navigation.boundingBox()]);
  expect(actionBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(navigationBox!.y - 16);
  await expect(page.getByRole('link', { name: 'Aggiungi un ingrediente' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trova ricette' })).toHaveCount(0);
});

test('automatically shows pantry ideas without covering mobile navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetPantry(page);
  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, pomodoro');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await openHomeRecipes(page);
  await expect(page.getByRole('heading', { name: 'L’idea di oggi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trova ricette' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('suggested ingredients can be added without typing', async ({ page }) => {
  await resetPantry(page);

  await page.getByText('Idee per ampliare la dispensa', { exact: true }).click();
  const suggestions = page.getByRole('region', { name: 'Potresti aggiungere' });
  await expect(suggestions.getByRole('button', { name: 'Aggiungi Cipolla' })).toBeVisible();
  await suggestions.getByRole('button', { name: 'Aggiungi Cipolla' }).click();

  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Cipolla')).toBeVisible();
  await expect(suggestions.getByRole('button', { name: 'Aggiungi Cipolla' })).toHaveCount(0);
});

test('local suggestions refresh after pantry and diet changes', async ({ page }) => {
  await resetPantry(page);

  await page.getByLabel('Ingredienti presenti').fill('pasta');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await openHomeRecipes(page);
  await expect(page.getByRole('heading', { name: 'L’idea di oggi' })).toBeVisible();
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);

  await openPantry(page);
  await page.getByLabel('Ingredienti presenti').fill('tonno, passata, ceci, aglio, melanzane, basilico, uova, zucchine, peperoni, patate, cipolla, pollo, fagioli, lenticchie');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  const pantry = page.getByRole('list', { name: 'La tua dispensa' });
  const pantryAfterUpdate = await pantry.innerText();

  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  const initialOrder = await page.getByRole('link', { name: /^Apri / }).evaluateAll(
    (links) => links.map((link) => link.getAttribute('href')),
  );
  await page.getByRole('button', { name: 'Altre idee' }).click();
  await expect.poll(async () => page.getByRole('link', { name: /^Apri / }).evaluateAll(
    (links) => links.map((link) => link.getAttribute('href')),
  )).not.toEqual(initialOrder);

  await openPantry(page);
  expect(await pantry.innerText()).toBe(pantryAfterUpdate);
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Filtri alimentari', { exact: true }).click();
  await page.getByLabel('Dieta').selectOption('vegan');

  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);

  await openPantry(page);
  await page.reload();
  await expect(page.getByRole('list', { name: 'La tua dispensa' }).getByText('Pasta', { exact: true })).toBeVisible();
  await expect(page.getByText('Tonno', { exact: true })).toBeVisible();
});

test('diet and allergen filters block recipes and explain nutrition estimates', async ({ page }) => {
  await resetPantry(page);

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  await openPantry(page);
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Filtri alimentari', { exact: true }).click();
  await page.getByLabel('Dieta').selectOption('vegetarian');
  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);

  await openPantry(page);
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Filtri alimentari', { exact: true }).click();
  await page.getByLabel('Dieta').selectOption('omnivore');
  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  await openPantry(page);
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Filtri alimentari', { exact: true }).click();
  await page.getByLabel('Escludi pesce').check();
  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);

  await openPantry(page);
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Filtri alimentari', { exact: true }).click();
  await page.getByLabel('Escludi pesce').uncheck();
  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();

  await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  await expect(page.getByRole('heading', { name: 'Nutrizione stimata per porzione' })).toBeVisible();
  await expect(page.getByText('Stima indicativa')).toBeVisible();
  await expect(page.getByText(/Allergeni dichiarati: glutine, pesce/)).toBeVisible();
});

test('nutrition filters persist and keep the narrow layout without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await resetPantry(page);

  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Filtri alimentari', { exact: true }).click();
  await page.getByLabel('Calorie massime per porzione').fill('400');
  await page.getByLabel('Escludi pesce').check();
  await expect(page.getByLabel('Escludi pesce')).toBeChecked();
  await waitForDietProfilePersistence(page);

  await openHomeRecipes(page);
  await expect(page.getByText('Pasta tonno e pomodoro')).toHaveCount(0);

  await openPantry(page);
  await page.reload();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Filtri alimentari', { exact: true }).click();
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

  // Wait for the route transition, then scope to the intended shopping row: every
  // recipe-derived row carries the recipe title, so a bare text filter also matches
  // the recipe detail page and its sibling rows.
  const shoppingListHeading = page.getByRole('heading', { name: 'Lista della spesa' });
  await expect(shoppingListHeading).toBeVisible();
  const pastaRow = page
    .getByRole('region', { name: /Da acquistare/ })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Segna Pasta come acquistato', exact: true }) });
  await expect(pastaRow).toHaveCount(1);
  await expect(pastaRow.getByText('Pasta', { exact: true })).toBeVisible();

  await page.reload();
  await expect(shoppingListHeading).toBeVisible();
  await expect(pastaRow).toHaveCount(1);
  await expect(pastaRow.getByText('Pasta', { exact: true })).toBeVisible();
});

test('activity records cooking, preferences and private notes offline', async ({ page }) => {
  await resetPantry(page);
  await page.getByLabel('Ingredienti presenti').fill('pasta, tonno, passata');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await expect(page.getByText('Pasta', { exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  await expect(page.getByText('Pasta tonno e pomodoro')).toBeVisible();
  await page.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' }).click();
  await expect(page.getByRole('heading', { name: 'Ingredienti', level: 2, exact: true })).toBeVisible();

  await page.getByLabel('Porzioni cucinate').fill('1');
  await page.getByLabel('Nessun ingrediente della dispensa utilizzato').check();
  const confirmBtn = page.getByRole('button', { name: 'Conferma cena' });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(page.getByRole('status').filter({ hasText: 'Cena registrata. Nessun ingrediente della dispensa è stato scalato.' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Ricetta aggiunta alla cronologia.' })).toBeVisible();
  await page.getByRole('button', { name: 'Aggiungi ai preferiti' }).click();
  await page.getByRole('button', { name: 'Valuta Pasta tonno e pomodoro: 5 stelle' }).click();
  await page.getByLabel('Nota privata sulla ricetta').fill('Da rifare presto');
  await page.getByRole('button', { name: 'Salva preferenza' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Preferenza salvata.' })).toHaveText('Preferenza salvata.');
  // The success message reflects in-memory state; a full navigation must wait for both IndexedDB writes.
  await waitForActivityPersistence(page);

  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'La tua attività' })).toBeVisible();
  const cookHistory = page.getByRole('region', { name: 'Ricette cucinate' });
  const recipePreferences = page.getByRole('region', { name: 'Preferiti e valutazioni' });
  await expect(cookHistory.getByText('Pasta tonno e pomodoro', { exact: true })).toHaveCount(1);
  await expect(recipePreferences.getByText('Pasta tonno e pomodoro', { exact: true })).toHaveCount(1);
  await expect(recipePreferences.getByText('Preferita')).toBeVisible();
  await expect(recipePreferences.getByText('5/5')).toBeVisible();
  await expect(recipePreferences.getByText('Nota privata: Da rifare presto')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'La tua attività' })).toBeVisible();
  await expect(cookHistory.getByText('Pasta tonno e pomodoro', { exact: true })).toHaveCount(1);
  await expect(recipePreferences.getByText('5/5')).toBeVisible();
  await expect(recipePreferences.getByText('Nota privata: Da rifare presto')).toBeVisible();
});

test('manifest is available and the application works offline after first load', async ({ page, context }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/A tavola/i);

  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('A tavola');
  expect(manifest.id).toBe('/');
  expect(manifest.start_url).toBe('/');
  expect(manifest.shortcuts.map((shortcut: { url: string }) => shortcut.url)).toEqual(
    expect.arrayContaining(['/pantry', '/shopping-list', '/activity']),
  );
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
  ]));
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/icon-192x192.png');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'A tavola');

  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Cosa portiamo a tavola?' })).toBeVisible();
  await context.setOffline(false);
});

test('verified users can consent to private AI recipes without changing pantry lots', async ({ page }) => {
  let consentEnabled = false;
  let consentHomeProvider: 'openai' | 'gemini' | null = null;
  const recipes: Array<Record<string, unknown>> = [];
  const generationBodies: unknown[] = [];
  const saveBodies: unknown[] = [];

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

  await page.route('**/v1/profile', async (route) => {
    await route.fulfill({ json: { profile: { displayName: null } } });
  });

  await page.route('**/v1/sync', async (route) => {
    await route.fulfill({ status: 200, json: { changes: [], nextCursor: 0 } });
  });

  await page.route('**/v1/ai-recipes**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/ai-recipes/consent' && request.method() === 'GET') {
      await route.fulfill({ json: { consent: { enabled: consentEnabled, updatedAt: '2026-09-13T12:00:00.000Z', ...(consentHomeProvider === null ? {} : { homeProvider: consentHomeProvider }) }, selectedProvider: 'openai' } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes/consent' && request.method() === 'PUT') {
      const body = request.postDataJSON() as { enabled: boolean; homeProvider?: 'openai' | 'gemini' };
      consentEnabled = body.enabled;
      consentHomeProvider = consentEnabled ? body.homeProvider ?? null : null;
      await route.fulfill({ json: { consent: { enabled: consentEnabled, updatedAt: '2026-09-13T12:01:00.000Z', ...(consentHomeProvider === null ? {} : { homeProvider: consentHomeProvider }) } } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes' && request.method() === 'GET') {
      await route.fulfill({ json: { recipes } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes' && request.method() === 'POST') {
      generationBodies.push(request.postDataJSON());
      const generationNumber = generationBodies.length;
      const recipe = generationNumber === 1 ? {
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
      } : {
        id: 'browser-ai-recipe-2',
        source: 'ai',
        title: 'Ceci e melanzane speziati',
        description: 'Una seconda idea privata.',
        ingredients: [{ name: 'Ceci', amount: '200 g' }, { name: 'Melanzane', amount: '1' }, { name: 'Cumino', amount: 'q.b.' }],
        steps: ['Taglia le melanzane.', 'Cuoci con ceci e spezie.'],
        diets: ['vegan'],
        allergens: [],
        createdAt: '2026-09-13T12:03:00.000Z',
        updatedAt: '2026-09-13T12:03:00.000Z',
      };
      await route.fulfill({ status: 201, json: { recipe, quota: { allowed: true, used: generationNumber, remaining: 5 - generationNumber } } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes/save' && request.method() === 'POST') {
      const body = request.postDataJSON() as { recipe: Record<string, unknown> };
      saveBodies.push(body);
      recipes.unshift(body.recipe);
      await route.fulfill({ json: { recipe: body.recipe } });
      return;
    }
    if (url.pathname === '/v1/ai-recipes/browser-ai-recipe' && request.method() === 'DELETE') {
      recipes.splice(0, recipes.length);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  await resetPantry(page);
  await page.getByLabel('Ingredienti presenti').fill('ceci, pomodoro');
  await page.getByRole('button', { name: 'Aggiungi ingredienti' }).click();
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  await page.getByRole('button', { name: 'Aggiungi lotto' }).first().click();
  await page.getByLabel('Quantità del lotto').fill('500');
  await page.getByLabel('Unità di misura').selectOption('g');
  await page.getByRole('button', { name: 'Salva dettagli' }).click();

  const pantry = page.getByRole('list', { name: 'La tua dispensa' });
  const lots = page.getByRole('list', { name: 'Lotti di Ceci' });
  const pantryBefore = await pantry.innerText();
  const lotsBefore = await lots.innerText();

  await page.getByRole('link', { name: 'Ricette', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ricette', exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: /^Crea con AI$/ }).click();
  const aiPanel = page.getByRole('region', { name: 'Ricette AI private' });
  const aiConsentDisclosure = aiPanel.locator('details[data-ai-consent]');
  const consent = aiPanel.getByRole('checkbox', { name: /acconsento all’invio a .*ingredienti della dispensa/i });
  await expect(aiConsentDisclosure).toBeVisible();
  await expect(aiConsentDisclosure).not.toHaveAttribute('open', '');
  await expect(consent).not.toBeVisible();
  await aiConsentDisclosure.locator('summary').press('Enter');
  await expect(consent).toBeVisible();
  await consent.check();
  await aiPanel.getByRole('button', { name: 'Salva consenso' }).click();
  await aiConsentDisclosure.locator('summary').click();
  await expect(consent).not.toBeVisible();
  await expect(aiPanel.getByRole('button', { name: 'Genera ricetta AI' })).toBeVisible();
  await aiPanel.getByRole('button', { name: 'Genera ricetta AI' }).click();
  await expect(aiPanel.getByRole('heading', { name: 'Ceci croccanti al pomodoro' })).toBeVisible();
  expect(generationBodies).toHaveLength(1);
  expect(generationBodies[0]).toMatchObject({ ingredients: ['Ceci', 'Pomodoro'], existingRecipes: [] });

  await expect(aiPanel.getByText(/non ancora salvata/i)).toBeVisible();
  await aiPanel.getByRole('button', { name: 'Salva ricetta' }).click();
  await expect(aiPanel.getByRole('button', { name: 'Salva ricetta' })).toHaveCount(0);
  await expect.poll(() => saveBodies.length).toBe(1);
  expect(saveBodies[0]).toMatchObject({ recipe: { id: 'browser-ai-recipe' } });

  await aiPanel.getByRole('button', { name: 'Genera ricetta AI' }).click();
  await expect(aiPanel.getByRole('heading', { name: 'Ceci e melanzane speziati' })).toBeVisible();
  expect(generationBodies).toHaveLength(2);
  expect(generationBodies[1]).toMatchObject({
    existingRecipes: [{ title: 'Ceci croccanti al pomodoro', ingredients: [{ name: 'Ceci', amount: '240 g' }, { name: 'Pomodoro', amount: '200 g' }] }],
  });

  await openPantry(page);
  await page.getByText('Personalizza la dispensa', { exact: true }).click();
  await page.getByText('Dettagli lotti', { exact: true }).click();
  expect(await page.getByRole('list', { name: 'La tua dispensa' }).innerText()).toBe(pantryBefore);
  expect(await page.getByRole('list', { name: 'Lotti di Ceci' }).innerText()).toBe(lotsBefore);

  await page.getByRole('link', { name: 'Ricette', exact: true }).click();
  await page.reload();
  await page.locator('summary').filter({ hasText: /^Crea con AI$/ }).click();
  await expect(page.getByRole('region', { name: 'Ricette AI private' }).getByRole('heading', { name: 'Ceci croccanti al pomodoro' })).toBeVisible();
  const reloadedAiPanel = page.getByRole('region', { name: 'Ricette AI private' });
  const reloadedConsent = reloadedAiPanel.locator('details[data-ai-consent]');
  await expect(reloadedConsent).not.toHaveAttribute('open', '');
  const revoke = reloadedAiPanel.getByRole('button', { name: 'Revoca consenso AI globale' });
  await expect(revoke).toBeVisible();
  await revoke.click();
  await expect(reloadedAiPanel.getByRole('button', { name: 'Genera ricetta AI' })).toHaveCount(0);
  await expect(reloadedAiPanel.getByRole('heading', { name: 'Ceci croccanti al pomodoro' })).toBeVisible();
  await expect(reloadedConsent).not.toHaveAttribute('open', '');
});
