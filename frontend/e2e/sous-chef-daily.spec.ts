import { expect, test } from '@playwright/test';
import { RECIPES } from '../src/domain/recipes';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test('daily recipe is from the real catalog and survives offline reload', async ({ page, context }) => {
  await installOfflineBackend(page, { serviceWorkers: 'allow' });
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Ricetta del giorno' });
  await expect(card).toBeVisible();
  const title = card.getByRole('heading', { level: 3 });
  await expect(title).toBeVisible();
  const recipeTitle = await title.innerText();
  const recipe = RECIPES.find((candidate) => candidate.title === recipeTitle);
  expect(recipe).toBeDefined();
  await expect.poll(async () => page.evaluate(() => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open('ikuck-local-v2');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('keyValue').objectStore('keyValue').get('ikuck:guest:daily-recipes-v1');
      read.onsuccess = () => { resolve(JSON.stringify(read.result)); db.close(); };
      read.onerror = () => reject(read.error);
    };
  }))).toContain(recipe!.id);
  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(title).toHaveText(recipeTitle);
  await card.locator('summary').click();
  await expect(card.getByRole('heading', { name: 'Procedimento' })).toBeVisible();
  await context.setOffline(false);
  assertOfflineBackendClean(page);
});
