import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { DEFAULT_STAPLE_IDS, parseIngredientInput } from '../domain/ingredients';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import HomePage from '../pages/HomePage';
import PantryPage from '../pages/PantryPage';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import { hydrateDinnerDiaryStore, useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, scopeStorageKey, setActiveDataScope } from '../sync/scopeContext';
import { reportPersistenceMemoryOnly, usePersistenceStatusStore } from '../store/persistenceStatusStore';
import {
  getPantrySnapshotConflictError,
  PantrySnapshotConflictBackupError,
  PantrySnapshotConflictError,
  readPantrySnapshot,
} from '../storage/pantryStorage';
import { writeKeyValue } from '../storage/indexedDb';

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

const confirmedDiaryRecipe: SavedRecipe = {
  id: 'saved-diary-recipe', title: 'Pasta con zucchine della Casa', description: 'Con zucchine fresche.',
  ingredients: [
    { name: 'pasta', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' },
    { name: 'zucchine', amount: '2', ingredientId: null, optional: false, provenance: 'provided' },
  ],
  steps: ['Cuoci la pasta e salta le zucchine.'], servings: 2, durationMinutes: null, diets: null, allergens: null,
  suggestedFields: [], source: 'diary', authorId: 'user-1', createdAt: '2026-09-29T18:00:00.000Z', updatedAt: '2026-09-29T18:01:00.000Z',
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
    setActiveDataScope('guest');
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
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [], recipes: [], drafts: [], error: null });
    useDietProfileStore.setState({
      hasHydrated: true,
      profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-09-13T12:00:00.000Z' },
    });
  });

  it('keeps recipe search focused and routes pantry editing to its dedicated section', () => {
    seedPantry('pasta');
    renderHome();

    expect(screen.getByRole('heading', { name: 'Cucina viva' })).toBeVisible();
    expect(screen.queryByLabelText('Ingredienti presenti')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apri tutta la dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Ricette AI private' })).not.toBeInTheDocument();
  });

  it('explains the empty pantry and disables search until ingredients are saved', () => {
    renderHome();

    expect(screen.getByRole('link', { name: 'Apri tutta la dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Nessun ingrediente ancora aggiunto');
  });

  it('adds ingredients from Home through the shared pantry store', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
    const dialog = screen.getByRole('dialog', { name: 'Aggiungi ingredienti' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Ingredienti presenti' }), 'pomodoro, spezia speciale');
    await user.click(within(dialog).getByRole('button', { name: 'Aggiungi ingredienti' }));
    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'custom:spezia-speciale', label: 'spezia speciale', known: false },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Pomodoro')).toBeVisible();
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
    expect(within(screen.getByRole('article', { name: 'Pasta tonno e pomodoro' })).getByText('2 porzioni')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Apri Pasta tonno e pomodoro' })).toHaveAttribute('href', '/recipes/pasta-tonno-pomodoro');
  });

  it('includes a confirmed diary recipe in Trova ricette and opens its scoped detail', async () => {
    const user = userEvent.setup();
    const scope = getActiveDataScope();
    seedPantry('pasta, zucchine');
    useDinnerDiaryStore.setState({ recipes: [{ scope, value: confirmedDiaryRecipe }] });
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    expect(screen.getByRole('article', { name: confirmedDiaryRecipe.title })).toHaveAttribute('data-availability', 'ready');
    expect(screen.getByRole('link', { name: `Apri ${confirmedDiaryRecipe.title}` })).toHaveAttribute(
      'href',
      `/recipes/${confirmedDiaryRecipe.id}?scope=${encodeURIComponent(scope)}`,
    );
  });

  it('keeps diary suggestions in the active scope', async () => {
    const user = userEvent.setup();
    const activeScope = getActiveDataScope();
    const otherScope = activeScope === 'guest' ? 'account:other-user' : 'guest';
    seedPantry('pasta, zucchine');
    useDinnerDiaryStore.setState({ recipes: [{ scope: otherScope, value: confirmedDiaryRecipe }] });
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    expect(screen.queryByRole('article', { name: confirmedDiaryRecipe.title })).not.toBeInTheDocument();
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
    expect(within(readyRecipes).getByText('Hai tutti gli ingredienti necessari; controlla le quantità indicate nella ricetta.')).toBeVisible();
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
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Apri (?!tutta la dispensa)/ })).toHaveLength(4));

    act(() => {
      useActivityStore.setState({ preferences: [{
        recipeId: 'pasta-e-ceci', favorite: true, rating: 5, note: null,
        createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z',
      }] });
    });

    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Apri (?!tutta la dispensa)/ })[0]).toHaveAccessibleName('Apri Pasta e ceci'));
  });

  it('keeps results visible and varies their order with Altre idee', async () => {
    const user = userEvent.setup();
    seedPantry('pasta, tonno, passata, ceci, aglio, melanzane, basilico, uova');
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Apri (?!tutta la dispensa)/ })).toHaveLength(4));
    const initialOrder = screen.getAllByRole('link', { name: /^Apri (?!tutta la dispensa)/ }).map((link) => link.getAttribute('href'));

    await user.click(screen.getByRole('button', { name: 'Altre idee' }));

    await waitFor(() => {
      const nextOrder = screen.getAllByRole('link', { name: /^Apri (?!tutta la dispensa)/ }).map((link) => link.getAttribute('href'));
      expect(nextOrder).not.toEqual(initialOrder);
    });
  });

  it.each([
    ['account', 'account:account-1'],
    ['House', 'house:house-1'],
  ] as const)('hides a guest pantry conflict when the mounted Home changes to %s scope', async (_label, nextScope) => {
    const retry = vi.fn(async () => undefined);
    reportPersistenceMemoryOnly('pantry', {
      code: 'pantry_snapshot_conflict',
      scope: 'guest',
      detail: 'GUEST PANTRY CONFLICT LEAK 7B91',
      copies: [{
        id: 'guest-copy',
        label: 'Guest pantry backup',
        revision: 42,
        snapshot: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [] },
      }],
    }, retry);
    seedPantry('pasta');
    renderHome();

    expect(screen.getByRole('alert')).toHaveTextContent('copia recuperabile');
    expect(screen.getByRole('link', { name: 'Scegli una copia della dispensa' })).toBeVisible();

    await act(async () => {
      setActiveDataScope(nextScope);
      await hydrateDinnerDiaryStore();
      usePantryStore.setState({
        hasHydrated: true,
        pantryItems: parseIngredientInput('riso'),
        pantryLots: [],
        stapleIds: [...DEFAULT_STAPLE_IDS],
      });
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Scegli una copia della dispensa' })).not.toBeInTheDocument();
    expect(screen.getByText('Riso')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeEnabled();
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

  it('routes a recoverable Home pantry conflict through an explicit choice and returns with the recovered snapshot', async () => {
    const user = userEvent.setup();
    const selectedSnapshot = { pantryItems: parseIngredientInput('riso'), stapleIds: [] };
    await writeKeyValue(scopeStorageKey('guest', 'ikuck-pantry-conflict-backup-v1'), {
      id: 'home-active-conflict',
      scope: 'guest',
      reason: 'concurrent-write',
      copies: [{ id: 'home-recovery-copy', label: 'Copia da recuperare', revision: 42, snapshot: selectedSnapshot }],
      createdAt: '2026-10-09T10:00:00.000Z',
    });
    const conflict = await getPantrySnapshotConflictError('guest');
    if (conflict === null) throw new Error('Expected the stored pantry conflict');
    expect(conflict.copies).toHaveLength(1);
    act(() => reportPersistenceMemoryOnly('pantry', conflict, vi.fn(async () => undefined)));
    seedPantry('pasta');

    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/pantry" element={<PantryPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const homeAlert = screen.getByRole('alert');
    expect(homeAlert).toHaveTextContent('una copia recuperabile');
    expect(homeAlert).not.toHaveTextContent('Puoi riprovare quando vuoi.');
    expect(within(homeAlert).queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument();
    await user.click(within(homeAlert).getByRole('link', { name: 'Scegli una copia della dispensa' }));

    expect(await screen.findByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
    const copyChoice = screen.getByRole('radio', { name: /Copia da recuperare.*Riso/s });
    expect(copyChoice).not.toBeChecked();
    await user.click(copyChoice);
    await user.click(screen.getByRole('button', { name: 'Usa questa copia' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(usePantryStore.getState().pantryItems).toEqual(selectedSnapshot.pantryItems);
    await expect(readPantrySnapshot('guest')).resolves.toMatchObject(selectedSnapshot);
    await user.click(screen.getByRole('link', { name: 'Vai alle ricette' }));

    expect(screen.getByText('Riso')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument();
  });

  it('describes one retained pantry conflict copy without inventing a second copy', () => {
    const retry = vi.fn(async () => undefined);
    const copy = {
      id: 'only-home-copy',
      label: 'Backup selezionabile',
      revision: 42,
      snapshot: { pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }], stapleIds: [] },
    };
    const conflict = new PantrySnapshotConflictError(
      'guest', 'concurrent-write', copy.snapshot, copy.snapshot, 42, 42, [copy],
    );
    reportPersistenceMemoryOnly('pantry', conflict, retry);
    renderHome();

    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent(/due copie|entrambe le copie/i);
    expect(alert).toHaveTextContent('una copia recuperabile');
    expect(screen.getByRole('link', { name: 'Scegli una copia della dispensa' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument();
  });

  it('explains malformed pantry backup is preserved but no safe copy is selectable on Home', () => {
    const retry = vi.fn(async () => undefined);
    reportPersistenceMemoryOnly('pantry', new PantrySnapshotConflictBackupError('guest'), retry);
    renderHome();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Il backup della dispensa è stato conservato, ma i dati non sono leggibili.');
    expect(alert).toHaveTextContent('Non è disponibile alcuna copia sicura da scegliere');
    expect(alert).toHaveTextContent('le modifiche e la sincronizzazione restano sospese');
    expect(alert).not.toHaveTextContent(/due copie|entrambe le copie|scegli una copia/i);
    expect(alert).not.toHaveTextContent('Puoi riprovare quando vuoi.');
    expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });
});
