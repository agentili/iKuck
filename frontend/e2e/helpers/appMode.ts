import { expect, type Page } from '@playwright/test';

const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
export const isSousChefBuild = runtime.process?.env?.VITE_SOUS_CHEF === 'true';
export const kitchenPath = isSousChefBuild ? '/cucina' : '/';
export const kitchenHeading = 'Cucina viva';
export const landingHeading = isSousChefBuild ? 'Chef' : kitchenHeading;
export const kitchenNavigationLabel = isSousChefBuild ? 'Chef' : 'Cucina';

export const goToKitchen = async (page: Page): Promise<void> => {
  await page.goto(kitchenPath);
};

export const openPantryInventory = async (page: Page): Promise<void> => {
  if (!isSousChefBuild) return;

  const inventorySummary = page.locator('details > summary').filter({ hasText: 'Inventario' }).first();
  await expect(inventorySummary).toBeVisible();
  const disclosureIsOpen = await inventorySummary.evaluate((summary) => summary.parentElement?.matches('details[open]') ?? false);
  if (!disclosureIsOpen) await inventorySummary.click();
};

export const openShellProfileMenu = async (page: Page): Promise<void> => {
  if (isSousChefBuild) {
    await page.getByRole('button', { name: 'Profilo', exact: true }).click();
  }
};
