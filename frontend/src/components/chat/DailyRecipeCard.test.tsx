import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dailyRecipeStorage from '../../storage/dailyRecipeStorage';
import * as pantryStore from '../../store/localPantryStore';
import * as dietProfileStore from '../../store/dietProfileStore';
import { usePantryStore } from '../../store/localPantryStore';
import { useDietProfileStore } from '../../store/dietProfileStore';
import { DEFAULT_DIET_PROFILE, normalizeDietProfile } from '../../domain/dietary';
import { RECIPES } from '../../domain/recipes';
import { selectDailyRecipe } from '../../domain/dailyRecipe';
import { setActiveDataScope } from '../../sync/scopeContext';
import { DailyRecipeCard } from './DailyRecipeCard';

const renderCard = () => render(<MemoryRouter><DailyRecipeCard /></MemoryRouter>);
const date = '2026-11-02';
const profile = normalizeDietProfile({ ...DEFAULT_DIET_PROFILE, updatedAt: '2026-11-01T12:00:00.000Z' });

beforeEach(() => {
  vi.restoreAllMocks();
  setActiveDataScope('guest');
  vi.spyOn(pantryStore, 'hydratePantryStore').mockResolvedValue();
  vi.spyOn(dietProfileStore, 'hydrateDietProfileStore').mockResolvedValue();
  usePantryStore.setState({ hasHydrated: true, pantryItems: [], stapleIds: [] });
  useDietProfileStore.setState({ hasHydrated: true, profile });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DailyRecipeCard', () => {
  it('shows loading feedback until the local catalog selection resolves', async () => {
    let resolveSelection!: (selection: Awaited<ReturnType<typeof dailyRecipeStorage.getDailyRecipe>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof dailyRecipeStorage.getDailyRecipe>>>((resolve) => {
      resolveSelection = resolve;
    });
    vi.spyOn(dailyRecipeStorage, 'localDateKey').mockReturnValue(date);
    vi.spyOn(dailyRecipeStorage, 'getDailyRecipe').mockReturnValue(pending);

    renderCard();
    expect(screen.getByRole('status')).toHaveTextContent('Caricamento ricetta del giorno…');

    resolveSelection(null);
    expect(await screen.findByText('Nessuna ricetta compatibile disponibile nel catalogo.')).toBeVisible();
  });

  it('shows a recoverable local-storage error without exposing an implementation error', async () => {
    vi.spyOn(dailyRecipeStorage, 'localDateKey').mockReturnValue(date);
    vi.spyOn(dailyRecipeStorage, 'getDailyRecipe').mockRejectedValue(new Error('IndexedDB unavailable'));

    renderCard();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Non è possibile salvare la proposta su questo dispositivo.');
    expect(alert).not.toHaveTextContent('IndexedDB unavailable');
  });

  it('shows no-selection feedback when the real catalog has no recipe compatible with the active profile', async () => {
    vi.spyOn(dailyRecipeStorage, 'localDateKey').mockReturnValue(date);
    const restrictiveProfile = normalizeDietProfile({
      ...DEFAULT_DIET_PROFILE,
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: 100_000 },
      updatedAt: '2026-11-01T12:00:00.000Z',
    });
    useDietProfileStore.setState({ profile: restrictiveProfile });

    const selection = await dailyRecipeStorage.getDailyRecipe({
      scope: 'guest',
      date,
      recipes: RECIPES,
      availableIds: [],
      profile: restrictiveProfile,
    });
    expect(selection).toBeNull();

    renderCard();

    expect(await screen.findByText('Nessuna ricetta compatibile disponibile nel catalogo.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Vedi ricetta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('expands and collapses a catalog recipe without mutating pantry or diet data', async () => {
    vi.spyOn(dailyRecipeStorage, 'localDateKey').mockReturnValue(date);
    const availableIds = RECIPES[0].ingredients.filter((ingredient) => !ingredient.optional).map((ingredient) => ingredient.ingredientId);
    usePantryStore.setState({ stapleIds: availableIds });
    const expected = selectDailyRecipe({ recipes: RECIPES, availableIds, profile, date, previousIds: [] });
    expect(expected).not.toBeNull();
    if (expected === null) throw new Error('The checked-in recipe catalog must provide a daily suggestion for the default profile.');

    const pantryBefore = usePantryStore.getState();
    const profileBefore = useDietProfileStore.getState().profile;
    renderCard();

    const region = screen.getByRole('region', { name: 'Ricetta del giorno' });
    expect(region).toHaveClass('rounded-[var(--ik-radius-panel)]', 'bg-[var(--ik-surface)]');
    expect(await screen.findByRole('heading', { level: 3, name: expected.recipe.title })).toBeVisible();
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(`${expected.recipe.durationMinutes} minuti`)).toBeVisible();
    expect(screen.queryByText(/Da aggiungere:/)).not.toBeInTheDocument();
    expect(screen.getByText('Procedimento')).not.toBeVisible();
    const summary = region.querySelector('summary');
    if (summary === null) throw new Error('The daily recipe must have an expandable summary.');
    const user = userEvent.setup();
    await user.click(summary);
    expect(screen.getByText('Ingredienti')).toBeVisible();
    expect(screen.getByText('Procedimento')).toBeVisible();
    expect(screen.getByText(expected.recipe.steps[0])).toBeVisible();
    await user.click(summary);
    expect(screen.getByText('Procedimento')).not.toBeVisible();
    expect(usePantryStore.getState().pantryItems).toEqual(pantryBefore.pantryItems);
    expect(usePantryStore.getState().stapleIds).toEqual(pantryBefore.stapleIds);
    expect(useDietProfileStore.getState().profile).toEqual(profileBefore);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('lists only missing ingredients in the collapsed summary', async () => {
    vi.spyOn(dailyRecipeStorage, 'localDateKey').mockReturnValue(date);
    vi.spyOn(dailyRecipeStorage, 'getDailyRecipe').mockResolvedValue({
      recipe: RECIPES[0], missingIngredientIds: ['unknown-ingredient'], reasons: [],
    });
    renderCard();
    expect(await screen.findByText('Da aggiungere: unknown-ingredient.')).toBeVisible();
    expect(screen.getByText('Procedimento')).not.toBeVisible();
    expect(screen.queryByText(/La proponiamo|Hai gli ingredienti|Questa proposta/)).not.toBeInTheDocument();
  });

});
