import { expect, test } from '@playwright/test';
import { installOfflineBackend, assertOfflineBackendClean } from './helpers/backendMode';
import { seedPlanPantry } from './helpers/planWizard';

test('la matita resta compatta e a destra della ricetta anche su uno schermo stretto', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await installOfflineBackend(page);
  await seedPlanPantry(page);
  await page.goto('/plan');
  const row = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
  const title = row.locator('p').first();
  const edit = row.getByRole('button', { name: /cambia ricetta per/i });
  await expect(edit).toBeEnabled();
  await expect(title).toBeVisible();

  for (const fontSize of ['100%', '200%']) {
    await page.locator('html').evaluate((root, size) => { root.style.fontSize = size; }, fontSize);
    const [card, recipe, button] = await Promise.all([row.boundingBox(), title.boundingBox(), edit.boundingBox()]);
    expect(button!.x).toBeGreaterThanOrEqual(recipe!.x + recipe!.width);
    expect(button!.y).toBeLessThan(recipe!.y + recipe!.height);
    expect(button!.x + button!.width).toBeLessThan(card!.x + card!.width);
    expect(button!.width).toBeGreaterThanOrEqual(44);
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.width).toBeCloseTo(button!.height, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  }

  await page.locator('html').evaluate(root => { root.style.fontSize = '100%'; });
  await row.screenshot({ path: testInfo.outputPath('plan-compact-edit.png'), animations: 'disabled' });
  await edit.click();
  await expect(page.getByRole('dialog', { name: 'Definisci la ricetta del giorno' })).toBeVisible();
  assertOfflineBackendClean(page);
});

test('annulla da tastiera senza cambiare il piano e restituisce il focus al pulsante', async ({ page }) => {
  await installOfflineBackend(page);
  await seedPlanPantry(page);
  await page.goto('/plan');
  const row = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
  const title = row.locator('div p').first();
  const original = await title.textContent();
  const action = row.getByRole('button', { name: /cambia ricetta/i });
  await action.click();
  const wizard = page.getByRole('dialog', { name: 'Definisci la ricetta del giorno' });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: /scegli dalla dispensa/i }).click();
  await wizard.getByRole('region', { name: 'Alternative dalla dispensa' }).getByRole('button').first().click();
  await expect(title).toHaveText(original!);
  await expect(wizard.getByRole('button', { name: 'Usa per questo giorno' })).toBeVisible();
  await wizard.getByRole('button', { name: 'Indietro' }).click();
  await expect(wizard.getByRole('region', { name: 'Alternative dalla dispensa' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(wizard).toHaveCount(0);
  await expect(action).toBeFocused();
  await expect(title).toHaveText(original!);
  await page.reload();
  await expect(title).toHaveText(original!);
  assertOfflineBackendClean(page);
});

test('crea con AI da descrizione e porzioni e conserva la ricetta nel ricettario e nel piano', async ({ page }, testInfo) => {
  const states = new Map<string, Record<string, unknown>>();
  const generated = { id: 'wizard-ai-rice', source: 'ai', title: 'Riso al limone', description: 'Un piatto semplice.', ingredients: [{ name: 'Riso', amount: '160 g' }, { name: 'Limone', amount: '1' }], steps: ['Cuoci il riso.', 'Aggiungi il limone.'], diets: ['omnivore', 'vegan'], allergens: [], createdAt: '2026-11-12T12:00:00.000Z', updatedAt: '2026-11-12T12:00:00.000Z' };
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: 'wizard-user', email: 'wizard@example.test', emailVerifiedAt: '2026-10-01T00:00:00Z' }, csrfToken: 'wizard-csrf', expiresAt: '2027-12-01T00:00:00Z' } },
    'GET /v1/profile': { json: { profile: { displayName: null } } },
    'GET /v1/house': { json: null },
    'GET /v1/meal-plan/capabilities': { json: { version: 2, syncReadVersion: 2 } },
    'GET /v1/ai-recipes': { json: { recipes: [] } },
    'GET /v1/ai-recipes/consent': { json: { consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-11-12T10:00:00Z' }, selectedProvider: 'openai' } },
    'POST /v1/ai-recipes': { json: { recipe: generated } },
  } });
  await page.route('**/v1/sync', route => route.fulfill({ json: { changes: [], nextCursor: 0 } }));
  await page.route('**/v1/meal-plan/read', route => {
    const { dates } = route.request().postDataJSON() as { dates: string[] };
    return route.fulfill({ json: { version: 2, states: dates.map(date => ({ date, state: states.get(date) ?? null })) } });
  });
  await page.route('**/v1/meal-plan/commands', route => {
    const command = route.request().postDataJSON() as { date: string; recipeId: string; operationId: string; action: string };
    const current = { date: command.date, recipeId: command.recipeId, revision: crypto.randomUUID(), serverSequence: states.size + 1, kind: command.action === 'manual_set' ? 'manual' : 'automatic' };
    states.set(command.date, current);
    return route.fulfill({ json: { version: 2, operationId: command.operationId, outcome: 'applied', current } });
  });
  await page.goto('/plan');
  const row = page.getByRole('list', { name: 'Pasti da domani' }).getByRole('listitem').first();
  await row.getByRole('button', { name: /cambia ricetta/i }).click();
  const wizard = page.getByRole('dialog');
  await wizard.getByRole('button', { name: /crea con ai/i }).click();
  await wizard.getByLabel('Descrizione del piatto', { exact: true }).fill('Un risotto cremoso al limone');
  await wizard.getByLabel('Numero di porzioni').fill('4');
  const generationRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/v1/ai-recipes' && request.method() === 'POST');
  await wizard.getByRole('button', { name: 'Genera ricetta AI' }).click();
  expect((await generationRequest).postDataJSON()).toMatchObject({ dishDescription: 'Un risotto cremoso al limone', ingredients: [], constraints: ['Prepara ingredienti e dosi per 4 porzioni.'] });
  await expect(wizard.getByText('4 porzioni', { exact: true })).toBeVisible();
  await expect(wizard.getByRole('heading', { name: generated.title })).toBeVisible();
  await expect(wizard.getByRole('textbox')).toHaveCount(0);
  await expect(wizard.getByRole('spinbutton')).toHaveCount(0);
  await expect(wizard.getByText('Ingredienti e dosi')).toHaveCount(0);
  await expect(row.getByText(generated.title, { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('plan-recipe-wizard.png') });
  await wizard.getByRole('button', { name: 'Salva nel ricettario e usa' }).click();
  await expect(wizard).not.toBeVisible();
  await expect(row.getByText(generated.title)).toBeVisible();
  await page.reload();
  await expect(row.getByText(generated.title)).toBeVisible();
  await page.goto('/recipes');
  await expect(page.getByText(generated.title, { exact: true })).toBeVisible();
  assertOfflineBackendClean(page);
});
