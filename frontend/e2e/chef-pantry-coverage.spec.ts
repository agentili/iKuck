import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

const draft = { title: 'Ceci croccanti con patate', description: 'Un piatto semplice.', ingredients: [{ name: 'Ceci', amount: '150 g' }, { name: 'Patate', amount: '100 g' }], steps: ['Cuoci i ceci con le patate.'], diets: ['omnivore'], allergens: [] };

test('Chef conferma l’invio della dispensa e salva solo su richiesta', async ({ page }) => {
  const userId = 'chef-coverage-user';
  const submissions: unknown[] = [];
  await page.addInitScript(({ id }) => {
    const pantryItems = [{ id: 'chickpeas', label: 'Ceci', known: true }, { id: 'potatoes', label: 'Patate', known: true }, { id: 'rice', label: 'Riso', known: true }];
    localStorage.setItem(`ikuck:account:${id}:ikuck-pantry-v1`, JSON.stringify({ state: { pantryItems, stapleIds: [] }, version: 1 }));
  }, { id: userId });
  await installOfflineBackend(page, { responses: {
    'GET /v1/auth/session': { json: { authenticated: true, user: { id: userId, email: 'chef@example.test', emailVerifiedAt: '2026-09-12T10:00:00.000Z' }, csrfToken: 'chef-token', expiresAt: '2027-10-12T12:00:00.000Z' } },
    'GET /v1/house': { json: { house: null } },
    'GET /v1/sync': { json: { changes: [], nextCursor: 0 } },
    'POST /v1/sync': { json: { uploaded: 0, downloaded: 0, pending: 0, complete: true } },
    'POST /v1/recipes/generate': { json: { kind: 'candidate', recipe: draft, omittedIngredient: 'Riso' } },
    'POST /v1/ai-recipes/save': { json: { recipe: { ...draft, id: 'chef-test', source: 'ai', createdAt: '2026-09-12T10:00:00Z', updatedAt: '2026-09-12T10:00:00Z' } } },
  } });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && ['/v1/recipes/generate', '/v1/ai-recipes/save'].includes(path)) submissions.push({ path, body: request.postDataJSON() });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Genera dalla dispensa' }).click({ timeout: 5000 });
  expect(submissions).toHaveLength(0);
  await page.getByRole('button', { name: 'Conferma e genera' }).click();
  await expect(page.getByRole('heading', { name: draft.title })).toBeVisible();
  await expect(page.getByText('Ingrediente non usato: Riso.')).toBeVisible();
  expect(submissions).toEqual([{ path: '/v1/recipes/generate', body: expect.objectContaining({ mode: 'chef_coverage', confirmedReferences: true, syncScope: `account:${userId}`, ingredients: ['Ceci', 'Patate', 'Riso'] }) }]);
  await page.getByRole('button', { name: 'Salva nel ricettario' }).click();
  await expect(page.getByText('Ricetta salvata nel ricettario.')).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toMatchObject({ path: '/v1/ai-recipes/save', body: { syncScope: `account:${userId}`, recipe: { title: draft.title, source: 'ai' } } });
  assertOfflineBackendClean(page);
});
