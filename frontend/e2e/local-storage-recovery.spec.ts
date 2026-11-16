import { expect, test } from '@playwright/test';
import { installOfflineBackend, assertOfflineBackendClean } from './helpers/backendMode';

test('read failures preserve shopping and activity snapshots through retry and reload', async ({ page }) => {
  await installOfflineBackend(page);
  await page.addInitScript(() => {
    const stamp = '2026-09-13T10:00:00.000Z';
    if (localStorage.getItem('fixture-seeded') === null) {
      localStorage.setItem('ikuck-shopping-list-v1', JSON.stringify({ version: 1, items: [{
        id: 'old-shopping', ingredientId: 'pasta', label: 'Pasta conservata', quantity: null, unit: null,
        note: null, purchased: false, sourceRecipeId: null, createdAt: stamp, updatedAt: stamp,
      }] }));
      localStorage.setItem('ikuck-activity-v1', JSON.stringify({ version: 1, items: [{
        id: 'old-event', recipeId: 'pasta', recipeTitle: 'Cena conservata', servings: 2,
        cookedAt: stamp, note: null, createdAt: stamp, updatedAt: stamp,
      }] }));
      localStorage.setItem('fixture-seeded', 'yes');
    }
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      if (localStorage.getItem('fixture-recovered') !== 'yes' && ['shopping-list', 'activity'].includes(String(key))) {
        throw new DOMException('Injected read failure', 'UnknownError');
      }
      return get.call(this, key);
    };
  });
  await page.goto('/shopping-list');
  await expect(page.getByRole('alert').filter({ hasText: 'Le modifiche a questi dati sono sospese' })).toBeVisible();
  const original = await page.evaluate(() => [localStorage.getItem('ikuck-shopping-list-v1'), localStorage.getItem('ikuck-activity-v1')]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Riprova lettura dati' })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('ikuck-shopping-list-v1'), localStorage.getItem('ikuck-activity-v1')])).toEqual(original);
  await page.evaluate(() => localStorage.setItem('fixture-recovered', 'yes'));
  await page.getByRole('button', { name: 'Riprova lettura dati' }).click();
  await expect(page.getByRole('button', { name: 'Riprova lettura dati' })).toHaveCount(0);
  await expect(page.getByText('Pasta conservata', { exact: true })).toBeVisible();
  await page.goto('/activity');
  await expect(page.getByText('Cena conservata', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('ikuck-shopping-list-v1'), localStorage.getItem('ikuck-activity-v1')])).toEqual(original);
  assertOfflineBackendClean(page);
});
