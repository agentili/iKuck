import { choosePlanRecipe } from '../test/choosePlanRecipe';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DIET_PROFILE, isRecipeCompatible } from '../domain/dietary';
import { RECIPES } from '../domain/recipes';
import PlanPage from './PlanPage';
import { readMealPlanSnapshot } from '../mealPlan/storage';

describe('PlanPage recipe proposals', () => {
  it('opens the wizard without changing the plan and cancels without writing', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);
    const buttons = await screen.findAllByRole('button', { name: /cambia ricetta/i });
    const before = await readMealPlanSnapshot('guest');
    await user.click(buttons[0]);
    const wizard = await screen.findByRole('dialog', { name: 'Definisci la ricetta del giorno' });
    expect(wizard).toBeVisible();
    expect(await readMealPlanSnapshot('guest')).toEqual(before);
    await user.click(within(wizard).getByRole('button', { name: 'Annulla' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await readMealPlanSnapshot('guest')).toEqual(before);
  });
  it('proposes a compatible real catalogue recipe within 30 minutes when one is available', async () => {
    const eligibleRecipes = RECIPES.filter((recipe) => (
      recipe.durationMinutes !== null
      && recipe.durationMinutes <= 30
      && isRecipeCompatible(recipe, DEFAULT_DIET_PROFILE)
    ));
    expect(eligibleRecipes.length).toBeGreaterThan(0);
    expect(eligibleRecipes.some((recipe) => recipe.durationMinutes === 30)).toBe(true);

    render(
      <MemoryRouter initialEntries={['/plan']}>
        <PlanPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const recipeElements = eligibleRecipes.flatMap((recipe) => screen.queryAllByText(recipe.title, { exact: true }));
      expect(recipeElements.length).toBeGreaterThan(0);
      expect(recipeElements[0]).toBeVisible();
    });
  });

  it('exposes an accessible action to change a proposed plan recipe', async () => {
    const compatibleCatalogRecipes = RECIPES.filter((recipe) => isRecipeCompatible(recipe, DEFAULT_DIET_PROFILE));
    expect(compatibleCatalogRecipes.length).toBeGreaterThan(1);

    render(
      <MemoryRouter initialEntries={['/plan']}>
        <PlanPage />
      </MemoryRouter>,
    );

    expect(await screen.findAllByRole('button', { name: /cambia ricetta/i })).toHaveLength(7);
    for (const row of screen.getAllByRole('listitem')) {
      const button = within(row).getByRole('button', { name: /cambia ricetta/i });
      expect(button).toHaveAccessibleName(/^Cambia ricetta per .+/i);
      expect(button.textContent).toBe('');
      expect(button).toBeEnabled();
    }
  });

  it('persists a replacement across a page reload', async () => {
    const compatibleTitles = RECIPES.filter((recipe) => isRecipeCompatible(recipe, DEFAULT_DIET_PROFILE))
      .map((recipe) => recipe.title);
    const view = render(<MemoryRouter><PlanPage /></MemoryRouter>);
    const firstRow = await screen.findAllByRole('listitem').then((items) => items[0]);
    const originalTitle = within(firstRow).getByText((text) => compatibleTitles.includes(text)).textContent;

    await choosePlanRecipe(within(firstRow).getByRole('button', { name: /cambia ricetta/i }));
    await waitFor(() => {
      const title = within(firstRow).getByText((text) => compatibleTitles.includes(text)).textContent;
      expect(title).not.toBe(originalTitle);
    });
    const savedTitle = within(firstRow).getByText((text) => compatibleTitles.includes(text)).textContent;

    view.unmount();
    render(<MemoryRouter><PlanPage /></MemoryRouter>);
    const reloadedRow = (await screen.findAllByRole('listitem'))[0];
    await waitFor(() => expect(within(reloadedRow).getByText(savedTitle!)).toBeVisible());
  });
});
