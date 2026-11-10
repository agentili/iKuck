import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { DEFAULT_DIET_PROFILE, isRecipeCompatible } from '../domain/dietary';
import { RECIPES } from '../domain/recipes';
import PlanPage from './PlanPage';

describe('PlanPage recipe proposals', () => {
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

    expect(await screen.findAllByRole('button', { name: /modifica ricetta/i })).toHaveLength(7);
  });

  it('persists a replacement across a page reload', async () => {
    const user = userEvent.setup();
    const compatibleTitles = RECIPES.filter((recipe) => isRecipeCompatible(recipe, DEFAULT_DIET_PROFILE))
      .map((recipe) => recipe.title);
    const view = render(<MemoryRouter><PlanPage /></MemoryRouter>);
    const firstRow = await screen.findAllByRole('listitem').then((items) => items[0]);
    const originalTitle = within(firstRow).getByText((text) => compatibleTitles.includes(text)).textContent;

    await user.click(within(firstRow).getByRole('button', { name: /modifica ricetta/i }));
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
