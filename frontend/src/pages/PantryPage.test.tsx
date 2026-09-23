import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAPLE_IDS, parseIngredientInput } from '../domain/ingredients';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import PantryPage from './PantryPage';
import { usePantryStore } from '../store/localPantryStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { reportPersistenceMemoryOnly, usePersistenceStatusStore } from '../store/persistenceStatusStore';

const hydratePantryStoreMock = vi.hoisted(() => vi.fn());

vi.mock('../store/localPantryStore', async () => {
  const actual = await vi.importActual<typeof import('../store/localPantryStore')>('../store/localPantryStore');
  return { ...actual, hydratePantryStore: hydratePantryStoreMock };
});

const renderPantry = (): void => {
  render(
    <MemoryRouter>
      <PantryPage />
    </MemoryRouter>,
  );
};

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

const openDisclosure = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> => {
  const summary = screen.getByText(name, { exact: true });
  const disclosure = summary.closest('details');
  if (disclosure === null) throw new Error(`${name} must be a disclosure`);
  if (!disclosure.hasAttribute('open')) await user.click(summary);
};

describe('PantryPage', () => {
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
    useDietProfileStore.setState({
      hasHydrated: true,
      profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-09-13T12:00:00.000Z' },
    });
  });

  it('shows a dedicated loading state while pantry hydration is pending', () => {
    usePantryStore.setState({ hasHydrated: false });
    renderPantry();

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento della tua dispensa…');
    expect(hydratePantryStoreMock).toHaveBeenCalledOnce();
  });

  it('owns ingredient entry and shows added items in the pantry', async () => {
    const user = userEvent.setup();
    renderPantry();

    await user.type(screen.getByLabelText('Ingredienti presenti'), 'pasta, tonno');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    const pantry = screen.getByRole('list', { name: 'La tua dispensa' });
    expect(within(pantry).getByText('Pasta')).toBeVisible();
    expect(within(pantry).getByText('Tonno')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Vai alle ricette' })).toHaveAttribute('href', '/');
  });

  it('does not expose a keyboard-activatable recipe link while the pantry is empty', () => {
    renderPantry();

    expect(screen.queryByRole('link', { name: 'Vai alle ricette' })).not.toBeInTheDocument();
    expect(screen.getByText('Vai alle ricette')).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers known ingredients while an ingredient is being typed', async () => {
    const user = userEvent.setup();
    renderPantry();

    await user.type(screen.getByLabelText('Ingredienti presenti'), 'pom');

    const suggestions = screen.getByRole('listbox', { name: 'Ingredienti suggeriti' });
    expect(within(suggestions).getByRole('option', { name: 'Pomodoro' })).toBeVisible();
    await user.click(within(suggestions).getByRole('option', { name: 'Pomodoro' }));
    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Pomodoro')).toBeVisible();
  });

  it('keeps expansion ideas and pantry configuration in progressive disclosure', async () => {
    const user = userEvent.setup();
    renderPantry();

    const ideas = screen.getByText('Idee per ampliare la dispensa', { exact: true }).closest('details');
    const configuration = screen.getByText('Personalizza la dispensa', { exact: true }).closest('details');
    expect(ideas).not.toHaveAttribute('open');
    expect(configuration).not.toHaveAttribute('open');

    await openDisclosure(user, 'Idee per ampliare la dispensa');
    expect(screen.getByRole('region', { name: 'Potresti aggiungere' })).toBeVisible();

    await openDisclosure(user, 'Personalizza la dispensa');
    expect(screen.getByText('Filtri alimentari', { exact: true })).toBeVisible();
    expect(screen.getByText('Ingredienti di base', { exact: true })).toBeVisible();
  });

  it('adds useful pantry suggestions without returning to Home', async () => {
    const user = userEvent.setup();
    renderPantry();

    await openDisclosure(user, 'Idee per ampliare la dispensa');
    const suggestions = screen.getByRole('region', { name: 'Potresti aggiungere' });
    await user.click(within(suggestions).getByRole('button', { name: 'Aggiungi Cipolla' }));

    expect(within(screen.getByRole('list', { name: 'La tua dispensa' })).getByText('Cipolla')).toBeVisible();
    expect(within(suggestions).queryByRole('button', { name: 'Aggiungi Cipolla' })).not.toBeInTheDocument();
  });

  it('keeps unknown ingredients and explains that recipes do not match them yet', async () => {
    const user = userEvent.setup();
    renderPantry();

    await user.type(screen.getByLabelText('Ingredienti presenti'), 'Tempeh');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));

    expect(screen.getByText('Tempeh')).toBeVisible();
    expect(screen.getByText('Non ancora usato nelle ricette')).toBeVisible();
  });

  it('keeps staple and lot management inside pantry configuration', async () => {
    const user = userEvent.setup();
    seedPantry('pasta');
    renderPantry();

    await openDisclosure(user, 'Personalizza la dispensa');
    await user.click(screen.getByText('Ingredienti di base', { exact: true }));
    const salt = screen.getByLabelText('Sale');
    expect(salt).toBeChecked();
    await user.click(salt);
    expect(salt).not.toBeChecked();
    expect(screen.getByText('Dettagli lotti', { exact: true })).toBeVisible();
  });

  it('shows a persistence warning and retry action in the section that owns pantry data', async () => {
    const retry = vi.fn(async () => undefined);
    reportPersistenceMemoryOnly('pantry', new Error('IndexedDB unavailable'), retry);
    renderPantry();

    expect(screen.getByRole('alert')).toHaveTextContent('disponibili solo in memoria');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Riprova' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
