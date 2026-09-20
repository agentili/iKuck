import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import HomePage from '../pages/HomePage';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { reportPersistenceMemoryOnly, usePersistenceStatusStore } from '../store/persistenceStatusStore';

const renderHome = async () => {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );

  await screen.findByLabelText('Ingredienti presenti');
  await waitFor(() => expect(usePantryStore.getState().hasHydrated).toBe(true));
  act(() => {
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: [],
      pantryLots: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
  });
  return screen.getByLabelText('Ingredienti presenti');
};

describe('HomePage integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePersistenceStatusStore.getState().reset();
    usePantryStore.setState({
      hasHydrated: false,
      pantryItems: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
    useActivityStore.setState({ events: [], preferences: [] });
    useDietProfileStore.setState({
      hasHydrated: false,
      profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-09-13T12:00:00.000Z' },
    });
  });

  it('keeps the full account flow out of the recipe search page', async () => {
    await renderHome();

    expect(screen.queryByRole('region', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('places ingredient entry and selected items before the primary recipe action', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    const pantry = screen.getByRole('region', { name: 'La tua dispensa' });
    const searchOptions = screen.getByRole('region', { name: 'Opzioni ricette' });

    expect(pantry.compareDocumentPosition(searchOptions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.type(input, 'pasta, tonno');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    const selectedIngredients = within(pantry).getByRole('list', { name: 'La tua dispensa' });
    expect(within(selectedIngredients).getByText('Pasta')).toBeVisible();
    expect(within(selectedIngredients).getByText('Tonno')).toBeVisible();
  });

  it('shows an accessible persistence warning with an explicit retry action', async () => {
    const retry = vi.fn(async () => undefined);
    reportPersistenceMemoryOnly('pantry', new Error('IndexedDB unavailable'), retry);

    await renderHome();

    expect(screen.getByRole('alert')).toHaveTextContent('disponibili solo in memoria');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Riprova' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('adds comma-separated ingredients and searches only on request', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    expect(screen.queryByRole('heading', { name: 'Ricette per te' })).not.toBeInTheDocument();
    await user.type(input, 'pasta, tonno, passata');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    const pantry = screen.getByRole('list', { name: 'La tua dispensa' });
    expect(within(pantry).getByText('Pasta')).toBeInTheDocument();
    expect(within(pantry).getByText('Tonno')).toBeInTheDocument();
    expect(within(pantry).getByText('Passata di pomodoro')).toBeInTheDocument();
    expect(screen.queryByText('Pasta tonno e pomodoro')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    expect(screen.getByRole('heading', { name: 'Ricette per te' })).toBeInTheDocument();
    expect(screen.getByText('Pasta tonno e pomodoro')).toBeInTheDocument();
    expect(screen.getByText('Hai tutto')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toHaveAttribute(
      'href',
      '/recipes/pasta-tonno-pomodoro',
    );
  });

  it('shows one named missing ingredient only in extended mode', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    await user.type(input, 'pasta, uova, pancetta');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(screen.queryByText('Carbonara semplice')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Anche con 1 ingrediente in più'));
    expect(screen.queryByText('Carbonara semplice')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    expect(screen.getByText('Carbonara semplice')).toBeInTheDocument();
    expect(screen.getByText('Ti manca solo: Parmigiano')).toBeInTheDocument();
  });

  it('offers known ingredients while the current token is typed', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    await user.type(input, 'pom');

    const suggestions = screen.getByRole('listbox', { name: 'Ingredienti suggeriti' });
    expect(within(suggestions).getByRole('option', { name: 'Pomodoro' })).toBeInTheDocument();
    await user.click(within(suggestions).getByRole('option', { name: 'Pomodoro' }));
    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Pomodoro')).toBeInTheDocument();
  });

  it('offers useful ingredients that can be added directly', async () => {
    const user = userEvent.setup();
    await renderHome();

    const suggestions = screen.getByRole('region', { name: 'Potresti aggiungere' });
    expect(within(suggestions).getByRole('button', { name: 'Aggiungi Cipolla' })).toBeInTheDocument();

    await user.click(within(suggestions).getByRole('button', { name: 'Aggiungi Cipolla' }));

    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Cipolla')).toBeInTheDocument();
    expect(within(suggestions).queryByRole('button', { name: 'Aggiungi Cipolla' })).not.toBeInTheDocument();
  });

  it('can refresh all five pantry suggestions', async () => {
    const user = userEvent.setup();
    await renderHome();

    const suggestions = screen.getByRole('region', { name: 'Potresti aggiungere' });
    const initial = within(suggestions).getAllByRole('button', { name: /^Aggiungi / }).map((button) => button.textContent);

    await user.click(within(suggestions).getByRole('button', { name: 'Cambia tutti i suggerimenti' }));

    const refreshed = within(suggestions).getAllByRole('button', { name: /^Aggiungi / }).map((button) => button.textContent);
    expect(initial).toHaveLength(5);
    expect(refreshed).toHaveLength(5);
    expect(refreshed).not.toEqual(initial);
  });

  it('can replace one pantry suggestion without adding it', async () => {
    const user = userEvent.setup();
    await renderHome();

    const suggestions = screen.getByRole('region', { name: 'Potresti aggiungere' });
    await user.click(within(suggestions).getByRole('button', { name: 'Sostituisci Cipolla' }));

    expect(within(suggestions).queryByRole('button', { name: 'Aggiungi Cipolla' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'La tua dispensa' })).not.toBeInTheDocument();
    expect(within(suggestions).getAllByRole('button', { name: /^Aggiungi / })).toHaveLength(5);
  });

  it('keeps an unknown ingredient and explains that it is not matched', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    await user.type(input, 'Tempeh');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    expect(screen.getByText('Tempeh')).toBeInTheDocument();
    expect(screen.getByText('Non ancora usato nelle ricette')).toBeInTheDocument();
  });

  it('lets the user change default staples', async () => {
    const user = userEvent.setup();
    await renderHome();

    await user.click(screen.getByText('Ingredienti di base'));
    const salt = screen.getByLabelText('Sale');
    expect(salt).toBeChecked();
    await user.click(salt);
    expect(salt).not.toBeChecked();
  });

  it('recalculates visible recipes after a pantry change without a second search', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    await user.type(input, 'pasta');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(screen.queryByText('Pasta tonno e pomodoro')).not.toBeInTheDocument();

    await user.type(input, 'tonno, passata');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    expect(await screen.findByText('Pasta tonno e pomodoro')).toBeInTheDocument();
  });

  it('recalculates visible recipes when the diet profile changes', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    await user.type(input, 'pasta, tonno, passata');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(await screen.findByText('Pasta tonno e pomodoro')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Dieta'), 'vegan');

    await waitFor(() => expect(screen.queryByText('Pasta tonno e pomodoro')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Ricette per te' })).toBeInTheDocument();
  });

  it('uses favorites and ratings to reorder already visible recipes', async () => {
    const user = userEvent.setup();
    const input = await renderHome();

    await user.type(input, 'pasta, tonno, passata, ceci, aglio, melanzane, basilico, uova');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
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
    const input = await renderHome();

    await user.type(input, 'pasta, tonno, passata, ceci, aglio, melanzane, basilico, uova');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Apri / })).toHaveLength(4));
    const initialOrder = screen.getAllByRole('link', { name: /^Apri / }).map((link) => link.getAttribute('href'));

    await user.click(screen.getByRole('button', { name: 'Altre idee' }));

    await waitFor(() => {
      const nextOrder = screen.getAllByRole('link', { name: /^Apri / }).map((link) => link.getAttribute('href'));
      expect(nextOrder).not.toEqual(initialOrder);
    });
    expect(screen.getByRole('heading', { name: 'Ricette per te' })).toBeInTheDocument();
  });
});
