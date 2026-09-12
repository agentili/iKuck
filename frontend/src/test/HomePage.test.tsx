import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_STAPLE_IDS } from '../domain/ingredients';
import HomePage from '../pages/HomePage';
import { usePantryStore } from '../store/localPantryStore';

const renderHome = async () => {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );

  return screen.findByLabelText('Ingredienti presenti');
};

describe('HomePage integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePantryStore.setState({
      hasHydrated: false,
      pantryItems: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
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

    const suggestions = screen.getByRole('list', { name: 'Ingredienti suggeriti' });
    expect(within(suggestions).getByRole('button', { name: 'Pomodoro' })).toBeInTheDocument();
    await user.click(within(suggestions).getByRole('button', { name: 'Pomodoro' }));
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
});
