import { expect, type Locator, type Page } from '@playwright/test';
import { getAllIngredients } from '@ikuck/shared/ingredients';

export async function seedPlanPantry(page: Page, scope = 'guest'): Promise<void> {
  await page.addInitScript(({ scope, ingredients }) => {
    const key = scope === 'guest' ? 'ikuck-pantry-v1' : `ikuck:${scope}:ikuck-pantry-v1`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ state: { pantryItems: ingredients, stapleIds: [] }, version: 1 }));
  }, { scope, ingredients: getAllIngredients().map(({ id, label }) => ({ id, label, known: true })) });
}

export async function choosePlanAlternative(page: Page, action: Locator): Promise<void> {
  await action.click();
  const wizard = page.getByRole('dialog', { name: 'Definisci la ricetta del giorno' });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: /scegli dalla dispensa/i }).click();
  await wizard.getByRole('region', { name: 'Alternative dalla dispensa' }).getByRole('button').first().click();
  await wizard.getByRole('button', { name: 'Usa per questo giorno' }).click();
}
