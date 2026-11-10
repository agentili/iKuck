import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { assertOfflineBackendClean, installOfflineBackend } from './helpers/backendMode';

test.afterEach(async ({ page }) => {
  assertOfflineBackendClean(page);
});

for (const width of [320, 390] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`keeps the shopping undo toast separated from navigation at ${width}px/200% (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await installOfflineBackend(page);
      await page.goto('/shopping-list');
      await expect(page.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
      await page.evaluate((selectedTheme) => {
        document.documentElement.style.fontSize = '200%';
        document.documentElement.dataset.theme = selectedTheme;
      }, theme);

      const addForm = page.getByRole('form', { name: 'Aggiungi un prodotto' });
      await addForm.getByLabel('Cosa ti serve?').fill('Pane');
      await addForm.getByRole('button', { name: 'Aggiungi alla lista' }).click();
      const pendingItem = page.locator('li[data-state="pending"]').filter({ hasText: 'Pane' });
      await expect(pendingItem).toBeVisible();
      await pendingItem.getByRole('button', { name: 'Segna Pane come acquistato' }).click();
      const purchasedItem = page.locator('li[data-state="purchased"]').filter({ hasText: 'Pane' });
      await expect(purchasedItem).toBeVisible();

      await page.getByRole('button', { name: 'Rimuovi gli acquistati' }).click();
      const toast = page.locator('.app-overlay');
      const undoButton = toast.getByRole('button', { name: 'Annulla', exact: true });
      const navigation = page.getByRole('navigation', { name: 'Navigazione principale' });
      await expect(undoButton).toBeVisible();
      await expect(undoButton).toBeFocused();
      await expect(navigation).toBeVisible();

      const [toastBox, navigationBox] = await Promise.all([
        toast.boundingBox(),
        navigation.boundingBox(),
      ]);
      expect(toastBox).not.toBeNull();
      expect(navigationBox).not.toBeNull();
      const gap = navigationBox!.y - (toastBox!.y + toastBox!.height);

      const viewport = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(viewport.scrollWidth, 'shopping undo state has no horizontal overflow').toBeLessThanOrEqual(viewport.clientWidth);

      const centerReceivesUndoClick = await undoButton.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return topmost === button || (topmost !== null && button.contains(topmost));
      });
      expect(centerReceivesUndoClick, 'Annulla remains hit-testable at its center').toBe(true);
      expect.soft(gap, 'undo toast has at least 8px of clearance above the fixed navigation').toBeGreaterThanOrEqual(8);

      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.map(({ id, impact }) => `${id}:${impact}`), 'shopping undo state passes axe').toEqual([]);

      await undoButton.click();
      await expect(page.locator('li[data-state="purchased"]').filter({ hasText: 'Pane' })).toBeVisible();
      await expect(toast).toHaveCount(0);
      const finalViewport = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(finalViewport.scrollWidth, 'undo state has no horizontal overflow').toBeLessThanOrEqual(finalViewport.clientWidth);
    });
  }
}
