import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAPLE_IDS, parseIngredientInput } from '../domain/ingredients';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import HomePage from '../pages/HomePage';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import { reportPersistenceMemoryOnly, usePersistenceStatusStore } from '../store/persistenceStatusStore';

const hydratePantryStoreMock = vi.hoisted(() => vi.fn());

vi.mock('../store/localPantryStore', async () => {
  const actual = await vi.importActual<typeof import('../store/localPantryStore')>('../store/localPantryStore');
  return { ...actual, hydratePantryStore: hydratePantryStoreMock };
});

const seedPantry = (value: string): void => {
  act(() => {
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: parseIngredientInput(value),
      pantryLots: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
  });
};

const renderHome = (): void => {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
};

describe('HomePage recipe search', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hydratePantryStoreMock.mockReset();
    hydratePantryStoreMock.mockResolvedValue(undefined);
    usePersistenceStatusStore.getState().reset();
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: [],
      pantryLots: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
    useActivityStore.setState({ events: [], preferences: [] });
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
    useDietProfileStore.setState({
      hasHydrated: true,
      profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-09-13T12:00:00.000Z' },
    });
  });

  it('keeps recipe search focused and routes pantry editing to its dedicated section', () => {
    seedPantry('pasta');
    renderHome();

    expect(screen.getByRole('heading', { name: 'Cosa cuciniamo oggi?' })).toBeVisible();
    expect(screen.queryByLabelText('Ingredienti presenti')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gestisci la dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Ricette AI private' })).not.toBeInTheDocument();
  });

  it('explains the empty pantry and disables search until ingredients are saved', () => {
    renderHome();

    expect(screen.getByRole('link', { name: 'Apri la dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Aggiungi almeno un ingrediente nella dispensa');
  });

  it('finds recipes from saved pantry items only after an explicit request', async () => {
    const user = userEvent.setup();
    seedPantry('pasta, tonno, passata');
    renderHome();

    expect(screen.queryByRole('heading', { name: 'Ricette per te' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    expect(screen.getByRole('heading', { name: 'Ricette per te' })).toBeVisible();
    expect(screen.getByText('Pasta tonno e pomodoro')).toBeVisible();
    expect(screen.getByText('Hai tutto')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toHaveAttribute('href', '/recipes/pasta-tonno-pomodoro');
  });

  it('separates recipes ready now from recipes needing one purchase', async () => {
    const user = userEvent.setup();
    seedPantry('pasta, tonno, passata, uova, pancetta');
    renderHome();

    await user.click(screen.getByLabelText('Anche con 1 ingrediente in più'));
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    const readyRecipes = screen.getByRole('region', { name: 'Pronte da cucinare' });
    const onePurchaseRecipes = screen.getByRole('region', { name: 'Con un solo acquisto' });
    expect(within(readyRecipes).getByRole('article', { name: 'Pasta tonno e pomodoro' })).toHaveAttribute('data-availability', 'ready');
    expect(within(onePurchaseRecipes).getByRole('article', { name: 'Carbonara semplice' })).toHaveAttribute('data-availability', 'one-missing');
  });

  it('adds a one-purchase recipe ingredient to the shopping list', async () => {
    const user = userEvent.setup();
    seedPantry('pasta, uova, pancetta');
    renderHome();

    await user.click(screen.getByLabelText('Anche con 1 ingrediente in più'));
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    const onePurchaseRecipes = screen.getByRole('region', { name: 'Con un solo acquisto' });
    const carbonara = within(onePurchaseRecipes).getByRole('article', { name: 'Carbonara semplice' });
    await user.click(within(carbonara).getByRole('button', { name: 'Aggiungi Parmigiano alla lista della spesa' }));

    expect(useShoppingListStore.getState().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ ingredientId: 'parmesan', label: 'Parmigiano', purchased: false, sourceRecipeId: 'carbonara-semplice' }),
    ]));
    expect(within(carbonara).getByRole('link', { name: 'Apri lista della spesa' })).toHaveAttribute('href', '/shopping-list');
  });

  it('updates visible results when the saved pantry changes', async () => {
    const user = userEvent.setup();
    seedPantry('pasta');
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(screen.queryByText('Pasta tonno e pomodoro')).not.toBeInTheDocument();

    act(() => {
      usePantryStore.setState({ pantryItems: parseIngredientInput('pasta, tonno, passata') });
    });

    expect(await screen.findByText('Pasta tonno e pomodoro')).toBeVisible();
  });

  it('updates visible results when dietary preferences change', async () => {
    const user = userEvent.setup();
    seedPantry('pasta, tonno, passata');
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(await screen.findByText('Pasta tonno e pomodoro')).toBeVisible();

    act(() => {
      useDietProfileStore.setState((state) => ({ profile: { ...state.profile, diet: 'vegan' } }));
    });

    await waitFor(() => expect(screen.queryByText('Pasta tonno e pomodoro')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Ricette per te' })).toBeVisible();
  });

  it('reorders visible recipes using saved preferences', async () => {
    const user = userEvent.setup();
    seedPantry('pasta, tonno, passata, ceci, aglio, melanzane, basilico, uova');
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Apri / })).toHaveLength(4));

    act(() => {
      useActivityStore.setState({ preferences: [{
        recipeId: 'pasta-e-ceci', favorite: true, rating: 5, note: null,
        createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z',
      }] });
    });

    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Apri / })[0]).toHaveAccessibleName('Apri Pasta e ceci'));
  });

  it('keeps results visible and varies their order with Altre idee', async () => {
    const user = userEvent.setup();
    seedPantry('pasta, tonno, passata, ceci, aglio, melanzane, basilico, uova');
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Apri / })).toHaveLength(4));
    const initialOrder = screen.getAllByRole('link', { name: /^Apri / }).map((link) => link.getAttribute('href'));

    await user.click(screen.getByRole('button', { name: 'Altre idee' }));

    await waitFor(() => {
      const nextOrder = screen.getAllByRole('link', { name: /^Apri / }).map((link) => link.getAttribute('href'));
      expect(nextOrder).not.toEqual(initialOrder);
    });
  });

  it('shows an accessible persistence warning with an explicit retry action', async () => {
    const retry = vi.fn(async () => undefined);
    reportPersistenceMemoryOnly('pantry', new Error('IndexedDB unavailable'), retry);
    seedPantry('pasta');
    renderHome();

    expect(screen.getByRole('alert')).toHaveTextContent('disponibili solo in memoria');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Riprova' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
