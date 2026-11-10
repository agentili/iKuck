import { expect, type Page } from '@playwright/test';

export const kitchenPath = '/cucina';
export const kitchenHeading = 'Cucina viva';
export const landingHeading = 'Cosa cuciniamo oggi?';
export const kitchenNavigationLabel = 'Chef';

export const goToKitchen = async (page: Page): Promise<void> => {
  await page.goto(kitchenPath);
};

export const openPantryInventory = async (page: Page): Promise<void> => {
  const inventorySummary = page.locator('details > summary').filter({ hasText: 'Inventario' }).first();
  await expect(inventorySummary).toBeVisible();
  const disclosureIsOpen = await inventorySummary.evaluate((summary) => summary.parentElement?.matches('details[open]') ?? false);
  if (!disclosureIsOpen) await inventorySummary.click();
};

export const openShellProfileMenu = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Profilo', exact: true }).click();
};
