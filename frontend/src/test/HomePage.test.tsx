import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import type { GeneratedRecipe, PantryLot } from '@ikuck/shared/contracts';
import { DEFAULT_STAPLE_IDS, parseIngredientInput } from '@ikuck/shared/ingredients';
import { useAuthStore } from '../auth/authStore';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import HomePage from '../pages/HomePage';
import PantryPage from '../pages/PantryPage';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import { hydrateDinnerDiaryStore, useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, scopeStorageKey, setActiveDataScope, subscribeActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { reportPersistenceMemoryOnly, usePersistenceStatusStore } from '../store/persistenceStatusStore';
import {
  getPantrySnapshotConflictError,
  PantrySnapshotConflictBackupError,
  PantrySnapshotConflictError,
  readPantrySnapshot,
} from '../storage/pantryStorage';
import { writeKeyValue } from '../storage/indexedDb';

const hydratePantryStoreMock = vi.hoisted(() => vi.fn());
const generateRecipeFromPantryMock = vi.hoisted(() => vi.fn());
const saveAiRecipeMock = vi.hoisted(() => vi.fn());

vi.mock('../store/localPantryStore', async () => {
  const actual = await vi.importActual<typeof import('../store/localPantryStore')>('../store/localPantryStore');
  return { ...actual, hydratePantryStore: hydratePantryStoreMock };
});

vi.mock('../components/ai/AiRecipePanel', () => ({ default: () => null }));
vi.mock('../ai/aiRecipeApi', async () => ({
  ...(await vi.importActual<typeof import('../ai/aiRecipeApi')>('../ai/aiRecipeApi')),
  generateRecipeFromPantry: generateRecipeFromPantryMock,
  saveAiRecipe: saveAiRecipeMock,
}));

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

const renderHome = () => render(
  <MemoryRouter>
    <HomePage />
  </MemoryRouter>,
);

const ownershipCommitSnapshots: Array<{
  userId: string | null;
  csrfToken: string | null;
  scope: SyncScope;
  bodyText: string;
}> = [];

function HomeOwnershipCommitProbe() {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const scope = useSyncExternalStore(
    (listener) => subscribeActiveDataScope(listener),
    getActiveDataScope,
    getActiveDataScope,
  );

  useLayoutEffect(() => {
    ownershipCommitSnapshots.push({
      userId: user?.id ?? null,
      csrfToken,
      scope,
      bodyText: document.body.textContent ?? '',
    });
  }, [user, csrfToken, scope]);

  return null;
}

const renderHomeWithOwnershipProbe = () => render(
  <MemoryRouter>
    <>
      <HomePage />
      <HomeOwnershipCommitProbe />
    </>
  </MemoryRouter>,
);

const setOwnership = (userId: string | null, csrfToken: string | null, scope: SyncScope): void => {
  act(() => {
    useAuthStore.setState({
      user: userId === null
        ? null
        : { id: userId, email: `${userId}@example.com`, emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
      csrfToken,
      expiresAt: null,
    });
    setActiveDataScope(scope);
    usePantryStore.setState({ hasHydrated: true });
    useDinnerDiaryStore.setState({ hasHydrated: true });
  });
};

const setVerifiedOwner = (userId: string, csrfToken: string, scope: SyncScope = `account:${userId}`): void => {
  setOwnership(userId, csrfToken, scope);
};

const generatedCandidate = (title: string) => ({
  kind: 'candidate' as const,
  recipe: {
    title,
    description: 'Una ricetta generata.',
    ingredients: [{ name: 'Pasta', amount: '160 g' }],
    steps: ['Cuoci la pasta.'],
    diets: [],
    allergens: [],
  },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('HomePage recipe search', () => {
  beforeEach(() => {
    ownershipCommitSnapshots.length = 0;
    window.localStorage.clear();
    generateRecipeFromPantryMock.mockReset();
    saveAiRecipeMock.mockReset();
    useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
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

  it('shows a generated pantry recipe candidate in the preview dialog', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
      csrfToken: 'csrf-token',
    });
    seedPantry('pasta, tonno');
    useDietProfileStore.setState({
      profile: {
        ...DEFAULT_DIET_PROFILE,
        diet: 'vegan',
        excludedAllergens: ['milk'],
        updatedAt: '2026-09-24T00:00:00.000Z',
      },
    });
    generateRecipeFromPantryMock.mockResolvedValueOnce({
      kind: 'candidate',
      recipe: {
        title: 'Ceci e riso',
        description: 'Ceci e riso con olio e spezie.',
        ingredients: [{ name: 'Ceci', amount: '150 g' }, { name: 'Riso', amount: '100 g' }],
        steps: ['Cuoci il riso e unisci i ceci.'],
        diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'],
        allergens: [],
      },
    });
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));

    const preview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    expect(within(preview).getByRole('heading', { name: 'Ceci e riso' })).toBeVisible();
    expect(generateRecipeFromPantryMock).toHaveBeenCalledWith({
      ingredients: ['Pasta', 'Tonno'],
      dietProfile: {
        diet: 'vegan',
        excludedAllergens: ['milk'],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      },
    }, 'csrf-token');
  });

  it('focuses the preview when opened and restores focus after Escape closes it', async () => {
    const user = userEvent.setup();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock.mockResolvedValueOnce(generatedCandidate('Pasta semplice'));
    renderHome();

    const trigger = screen.getByRole('button', { name: 'Genera ricetta da dispensa' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });

    expect(within(dialog).getByRole('heading', { name: 'Anteprima ricetta' })).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps Tab and Shift+Tab navigation inside the preview dialog', async () => {
    const user = userEvent.setup();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock.mockResolvedValueOnce(generatedCandidate('Pasta semplice'));
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    const closeButton = within(dialog).getByRole('button', { name: 'Scarta anteprima' });
    const discardButton = within(dialog).getByRole('button', { name: 'Scarta' });

    discardButton.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(discardButton).toHaveFocus();
  });

  it('dismisses an error-only generation dialog with Escape and restores focus', async () => {
    const user = userEvent.setup();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock.mockRejectedValueOnce(new Error('Provider unavailable'));
    renderHome();

    const trigger = screen.getByRole('button', { name: 'Genera ricetta da dispensa' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Generazione non riuscita' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Impossibile generare la ricetta in questo momento.');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Generazione non riuscita' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('offers an operable close control on an error-only dialog', async () => {
    const user = userEvent.setup();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock.mockRejectedValueOnce(new Error('Provider unavailable'));
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Generazione non riuscita' });
    const closeButton = within(dialog).getByRole('button', { name: 'Chiudi' });
    expect(closeButton).toBeVisible();
    closeButton.focus();
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('dialog', { name: 'Generazione non riuscita' })).not.toBeInTheDocument();
  });

  const ownershipTransitions = [
    { label: 'account changes', userId: 'user-2', csrfToken: 'csrf-token-2', scope: 'account:user-2' },
    { label: 'session token changes', userId: 'user-1', csrfToken: 'csrf-token-2', scope: 'account:user-1' },
    { label: 'house scope changes', userId: 'user-1', csrfToken: 'csrf-token', scope: 'house:house-1' },
    { label: 'the session logs out', userId: null, csrfToken: null, scope: 'guest' },
  ] satisfies Array<{ label: string; userId: string | null; csrfToken: string | null; scope: SyncScope }>;

  it('ignores a deferred generation across an uncommitted A-to-B-to-A owner transition', async () => {
    const user = userEvent.setup();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    const pendingGeneration = deferred<ReturnType<typeof generatedCandidate>>();
    generateRecipeFromPantryMock.mockReturnValueOnce(pendingGeneration.promise);
    renderHomeWithOwnershipProbe();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    expect(generateRecipeFromPantryMock).toHaveBeenCalledTimes(1);

    const snapshotStart = ownershipCommitSnapshots.length;
    act(() => {
      usePantryStore.setState({ hasHydrated: false });
      useDinnerDiaryStore.setState({ hasHydrated: false });
      useAuthStore.setState({
        user: { id: 'user-2', email: 'user-2@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
        csrfToken: 'csrf-token-2',
        expiresAt: null,
      });
      setActiveDataScope('account:user-2');
      useAuthStore.setState({
        user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
        csrfToken: 'csrf-token',
        expiresAt: null,
      });
      setActiveDataScope('account:user-1');
      usePantryStore.setState({ hasHydrated: true });
      useDinnerDiaryStore.setState({ hasHydrated: true });
    });

    const transitionSnapshots = ownershipCommitSnapshots.slice(snapshotStart);
    expect(transitionSnapshots.some((snapshot) => snapshot.userId === 'user-2')).toBe(false);
    await act(async () => {
      pendingGeneration.resolve(generatedCandidate('Anteprima obsoleta'));
      await pendingGeneration.promise;
    });

    expect(screen.queryByRole('heading', { name: 'Anteprima obsoleta' })).not.toBeInTheDocument();
  });

  it.each([
    { settlement: 'succeeds', resolve: true },
    { settlement: 'fails', resolve: false },
  ])('ignores a deferred save that $settlement across an uncommitted A-to-B-to-A owner transition', async ({ resolve }) => {
    const user = userEvent.setup();
    const pendingSave = deferred<void>();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock.mockResolvedValueOnce(generatedCandidate('Bozza A'));
    saveAiRecipeMock.mockReturnValueOnce(pendingSave.promise);
    renderHomeWithOwnershipProbe();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const preview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    await user.click(within(preview).getByRole('button', { name: 'Salva nel ricettario' }));
    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());

    const snapshotStart = ownershipCommitSnapshots.length;
    act(() => {
      usePantryStore.setState({ hasHydrated: false });
      useDinnerDiaryStore.setState({ hasHydrated: false });
      useAuthStore.setState({
        user: { id: 'user-2', email: 'user-2@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
        csrfToken: 'csrf-token-2',
        expiresAt: null,
      });
      setActiveDataScope('account:user-2');
      useAuthStore.setState({
        user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
        csrfToken: 'csrf-token',
        expiresAt: null,
      });
      setActiveDataScope('account:user-1');
      usePantryStore.setState({ hasHydrated: true });
      useDinnerDiaryStore.setState({ hasHydrated: true });
    });
    expect(ownershipCommitSnapshots.slice(snapshotStart).some((snapshot) => snapshot.userId === 'user-2')).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();

    await act(async () => {
      if (resolve) pendingSave.resolve();
      else {
        pendingSave.reject(new Error('Salvataggio della sessione precedente'));
        await pendingSave.promise.catch(() => undefined);
      }
    });

    expect(screen.queryByText('Impossibile salvare la ricetta.')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();
  });

  it.each(ownershipTransitions)(
    'hides and invalidates a generated preview in the same committed render when $label',
    async ({ userId, csrfToken, scope }) => {
      const user = userEvent.setup();
      setVerifiedOwner('user-1', 'csrf-token');
      seedPantry('pasta');
      generateRecipeFromPantryMock.mockResolvedValueOnce(generatedCandidate('Privata della sessione'));
      renderHomeWithOwnershipProbe();

      await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
      expect(await screen.findByRole('heading', { name: 'Privata della sessione' })).toBeVisible();

      const snapshotStart = ownershipCommitSnapshots.length;
      setOwnership(userId, csrfToken, scope);

      const transitionCommit = ownershipCommitSnapshots.slice(snapshotStart).at(-1);
      expect(transitionCommit).toMatchObject({ userId, csrfToken, scope });
      expect(transitionCommit?.bodyText).not.toContain('Privata della sessione');
      expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();

      setVerifiedOwner('user-1', 'csrf-token');
      expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();
    },
  );

  it.each(ownershipTransitions)(
    'ignores deferred generation success and failure after $label and return',
    async ({ userId, csrfToken, scope }) => {
      const user = userEvent.setup();
      setVerifiedOwner('user-1', 'csrf-token');
      seedPantry('pasta');
      renderHomeWithOwnershipProbe();

      for (const attempt of [1, 2]) {
        const pendingGeneration = deferred<ReturnType<typeof generatedCandidate>>();
        generateRecipeFromPantryMock.mockReturnValueOnce(pendingGeneration.promise);
        await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
        await waitFor(() => expect(generateRecipeFromPantryMock).toHaveBeenCalledTimes(attempt));
        setOwnership(userId, csrfToken, scope);
        setVerifiedOwner('user-1', 'csrf-token');
        seedPantry('pasta');

        await act(async () => {
          if (attempt === 1) pendingGeneration.resolve(generatedCandidate('Risposta della sessione precedente'));
          else {
            pendingGeneration.reject(new Error('Errore della sessione precedente'));
            await pendingGeneration.promise.catch(() => undefined);
          }
        });

        expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();
        expect(screen.queryByText('Risposta della sessione precedente')).not.toBeInTheDocument();
        expect(screen.queryByText('Impossibile generare la ricetta in questo momento.')).not.toBeInTheDocument();
      }
    },
  );

  it('ignores a pending generation from an unmounted Home after the same owner remounts', async () => {
    const user = userEvent.setup();
    const oldGeneration = deferred<ReturnType<typeof generatedCandidate>>();
    const currentGeneration = deferred<ReturnType<typeof generatedCandidate>>();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock
      .mockReturnValueOnce(oldGeneration.promise)
      .mockReturnValueOnce(currentGeneration.promise);
    const oldPage = renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    await waitFor(() => expect(generateRecipeFromPantryMock).toHaveBeenCalledOnce());
    oldPage.unmount();

    renderHome();
    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    await waitFor(() => expect(generateRecipeFromPantryMock).toHaveBeenCalledTimes(2));
    await act(async () => currentGeneration.resolve(generatedCandidate('Anteprima del nuovo Home')));
    expect(await screen.findByRole('heading', { name: 'Anteprima del nuovo Home' })).toBeVisible();

    await act(async () => oldGeneration.resolve(generatedCandidate('Risposta del Home smontato')));

    expect(screen.getByRole('heading', { name: 'Anteprima del nuovo Home' })).toBeVisible();
    expect(screen.queryByText('Risposta del Home smontato')).not.toBeInTheDocument();
  });

  it('shows no-new-recipe feedback without opening the preview dialog', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
      csrfToken: 'csrf-token',
    });
    seedPantry('pasta, tonno');
    generateRecipeFromPantryMock.mockResolvedValueOnce({
      kind: 'none_available',
      message: 'Non ho trovato ingredienti sufficienti per proporre qualcosa di nuovo.',
    });
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));

    expect(await screen.findByText('Non ho trovato ingredienti sufficienti per proporre qualcosa di nuovo.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();
  });

  it('saves a candidate only after explicit confirmation', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
      csrfToken: 'csrf-token',
    });
    seedPantry('pasta, tonno');
    generateRecipeFromPantryMock.mockResolvedValueOnce({
      kind: 'candidate',
      recipe: {
        title: 'Pasta al tonno',
        description: 'Una ricetta semplice.',
        ingredients: [{ name: 'Pasta', amount: '160 g' }, { name: 'Tonno', amount: '1 scatoletta' }],
        steps: ['Cuoci la pasta.', 'Aggiungi il tonno.'],
        diets: [],
        allergens: [],
      },
    });
    saveAiRecipeMock.mockResolvedValueOnce(undefined);
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const preview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    expect(saveAiRecipeMock).not.toHaveBeenCalled();

    await user.click(within(preview).getByRole('button', { name: 'Salva nel ricettario' }));

    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());
    expect(saveAiRecipeMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Pasta al tonno',
      source: 'ai',
    }), 'csrf-token');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument());
  });

  it('keeps save identity stable per candidate after a committed response is lost', async () => {
    const user = userEvent.setup();
    const persistedRecipes = new Map<string, GeneratedRecipe>();
    const lostFirstResponse = deferred<void>();
    let rejectFirstResponse = true;
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock
      .mockResolvedValueOnce(generatedCandidate('Pasta semplice'))
      .mockResolvedValueOnce(generatedCandidate('Pasta semplice'));
    saveAiRecipeMock.mockImplementation(async (recipe: GeneratedRecipe) => {
      // Model the route's scoped entity upsert: persistence is keyed by recipe ID.
      persistedRecipes.set(recipe.id, structuredClone(recipe));
      if (rejectFirstResponse) {
        rejectFirstResponse = false;
        await lostFirstResponse.promise;
        throw new Error('The response was lost after persistence completed');
      }
      return structuredClone(persistedRecipes.get(recipe.id)!);
    });
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const firstPreview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    const saveButton = within(firstPreview).getByRole('button', { name: 'Salva nel ricettario' });
    await user.click(saveButton);
    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());
    expect(saveButton).toBeDisabled();
    await user.click(saveButton);
    expect(saveAiRecipeMock).toHaveBeenCalledOnce();
    expect(persistedRecipes.size).toBe(1);

    await act(async () => lostFirstResponse.resolve());
    expect(await within(firstPreview).findByRole('alert')).toHaveTextContent('Impossibile salvare la ricetta.');
    expect(within(firstPreview).getByRole('heading', { name: 'Pasta semplice' })).toBeVisible();

    await user.click(within(firstPreview).getByRole('button', { name: 'Salva nel ricettario' }));
    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledTimes(2));
    expect(saveAiRecipeMock.mock.calls[1]?.[0]).toEqual(saveAiRecipeMock.mock.calls[0]?.[0]);
    expect(persistedRecipes.size).toBe(1);
    expect(await screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const secondPreview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    await user.click(within(secondPreview).getByRole('button', { name: 'Salva nel ricettario' }));
    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledTimes(3));
    expect((saveAiRecipeMock.mock.calls[2]?.[0] as GeneratedRecipe).id)
      .not.toBe((saveAiRecipeMock.mock.calls[0]?.[0] as GeneratedRecipe).id);
    expect(persistedRecipes.size).toBe(2);
  });

  it('disables repeated saves while the explicit save is pending', async () => {
    const user = userEvent.setup();
    let finishSave: (() => void) | undefined;
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
      csrfToken: 'csrf-token',
    });
    seedPantry('pasta, tonno');
    generateRecipeFromPantryMock.mockResolvedValueOnce({
      kind: 'candidate',
      recipe: {
        title: 'Pasta al tonno',
        description: 'Una ricetta semplice.',
        ingredients: [{ name: 'Pasta', amount: '160 g' }, { name: 'Tonno', amount: '1 scatoletta' }],
        steps: ['Cuoci la pasta.', 'Aggiungi il tonno.'],
        diets: [],
        allergens: [],
      },
    });
    saveAiRecipeMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const preview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    const saveButton = within(preview).getByRole('button', { name: 'Salva nel ricettario' });
    await user.click(saveButton);

    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());
    expect(saveButton).toBeDisabled();
    await act(async () => finishSave?.());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument());
  });

  it('keeps the preview open while a dispatched save is pending', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<void>();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock.mockResolvedValueOnce(generatedCandidate('Pasta in corso'));
    saveAiRecipeMock.mockReturnValueOnce(pendingSave.promise);
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    await user.click(within(dialog).getByRole('button', { name: 'Salva nel ricettario' }));
    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());

    expect(within(dialog).getByRole('button', { name: 'Scarta anteprima' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Salva nel ricettario' })).toBeDisabled();
    expect(within(dialog).getByText('Salvataggio in corso: attendi la risposta prima di chiudere.')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();

    await act(async () => pendingSave.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument());
  });

  it.each([
    { settlement: 'succeeds', resolve: true },
    { settlement: 'fails', resolve: false },
  ])('does not let a late save that $settlement replace or report over a newer preview', async ({ resolve }) => {
    const user = userEvent.setup();
    const pendingSave = deferred<void>();
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' },
      csrfToken: 'csrf-token',
    });
    seedPantry('pasta');
    generateRecipeFromPantryMock
      .mockResolvedValueOnce(generatedCandidate('Prima ricetta'))
      .mockResolvedValueOnce(generatedCandidate('Anteprima più recente'));
    saveAiRecipeMock.mockReturnValueOnce(pendingSave.promise);
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const firstPreview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    await user.click(within(firstPreview).getByRole('button', { name: 'Salva nel ricettario' }));
    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    expect(await screen.findByRole('heading', { name: 'Anteprima più recente' })).toBeVisible();

    await act(async () => {
      if (resolve) pendingSave.resolve();
      else {
        pendingSave.reject(new Error('Salvataggio obsoleto non riuscito'));
        await pendingSave.promise.catch(() => undefined);
      }
    });

    expect(screen.getByRole('heading', { name: 'Anteprima più recente' })).toBeVisible();
    expect(screen.queryByText('Impossibile salvare la ricetta.')).not.toBeInTheDocument();
  });

  it.each([
    { settlement: 'succeeds', resolve: true },
    { settlement: 'fails', resolve: false },
  ])('ignores a deferred save that $settlement after Home unmounts', async ({ resolve }) => {
    const user = userEvent.setup();
    const pendingSave = deferred<void>();
    setVerifiedOwner('user-1', 'csrf-token');
    seedPantry('pasta');
    generateRecipeFromPantryMock
      .mockResolvedValueOnce(generatedCandidate('Anteprima salvata'))
      .mockResolvedValueOnce(generatedCandidate('Anteprima dopo il remount'));
    saveAiRecipeMock.mockReturnValueOnce(pendingSave.promise);
    const oldPage = renderHome();

    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    const firstPreview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
    await user.click(within(firstPreview).getByRole('button', { name: 'Salva nel ricettario' }));
    await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());
    oldPage.unmount();

    renderHome();
    await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
    expect(await screen.findByRole('heading', { name: 'Anteprima dopo il remount' })).toBeVisible();
    await act(async () => {
      if (resolve) pendingSave.resolve();
      else {
        pendingSave.reject(new Error('Salvataggio precedente al remount'));
        await pendingSave.promise.catch(() => undefined);
      }
    });

    expect(screen.getByRole('heading', { name: 'Anteprima dopo il remount' })).toBeVisible();
    expect(screen.queryByText('Impossibile salvare la ricetta.')).not.toBeInTheDocument();
  });

  it.each(ownershipTransitions.flatMap((transition) => [
    { ...transition, settlement: 'succeeds', resolve: true },
    { ...transition, settlement: 'fails', resolve: false },
  ]))(
    'ignores a deferred save that $settlement after $label and return',
    async ({ userId, csrfToken, scope, resolve }) => {
      const user = userEvent.setup();
      const pendingSave = deferred<void>();
      setVerifiedOwner('user-1', 'csrf-token');
      seedPantry('pasta');
      generateRecipeFromPantryMock
        .mockResolvedValueOnce(generatedCandidate('Anteprima da salvare'))
        .mockResolvedValueOnce(generatedCandidate('Anteprima proprietaria corrente'));
      saveAiRecipeMock.mockReturnValueOnce(pendingSave.promise);
      renderHome();

      await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
      const firstPreview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
      await user.click(within(firstPreview).getByRole('button', { name: 'Salva nel ricettario' }));
      await waitFor(() => expect(saveAiRecipeMock).toHaveBeenCalledOnce());
      expect(saveAiRecipeMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Anteprima da salvare' }), 'csrf-token');

      setOwnership(userId, csrfToken, scope);
      setVerifiedOwner('user-1', 'csrf-token');
      seedPantry('pasta');
      await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
      expect(await screen.findByRole('heading', { name: 'Anteprima proprietaria corrente' })).toBeVisible();

      await act(async () => {
        if (resolve) pendingSave.resolve();
        else {
          pendingSave.reject(new Error('Salvataggio della sessione precedente'));
          await pendingSave.promise.catch(() => undefined);
        }
      });

      expect(screen.getByRole('heading', { name: 'Anteprima proprietaria corrente' })).toBeVisible();
      expect(screen.queryByText('Impossibile salvare la ricetta.')).not.toBeInTheDocument();
    },
  );

  it('explains the empty pantry and disables search until ingredients are saved', () => {
    renderHome();

    expect(screen.getByRole('link', { name: 'Apri tutta la dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Nessun ingrediente ancora aggiunto');
  });

  it('announces local hydration and withholds recipe controls until the stores are ready', () => {
    usePantryStore.setState({ hasHydrated: false });
    useDinnerDiaryStore.setState({ hasHydrated: false });
    renderHome();

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento delle tue ricette');
    expect(screen.queryByRole('button', { name: 'Trova ricette' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Risultati delle ricette' })).not.toBeInTheDocument();
  });

  it('keeps the live results inside the named recipe-results region before search', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    const resultsRegion = screen.getByRole('region', { name: 'Risultati delle ricette' });

    expect(resultsRegion.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: '' })).not.toBeInTheDocument();
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
      { id: 'custom:spezia-speciale', label: 'spezia speciale', known: true },
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

  it('shows a quantity warning without removing an otherwise ready recipe', async () => {
    const user = userEvent.setup();
    const pastaLot: PantryLot = {
      id: 'home-pasta-lot', ingredientId: 'pasta', label: 'Pasta', known: true,
      quantity: 100, unit: 'g', expiresAt: null,
      createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
    };
    seedPantry('pasta, tonno, passata');
    usePantryStore.setState({ pantryLots: [pastaLot] });
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));

    const recipe = screen.getByRole('article', { name: 'Pasta tonno e pomodoro' });
    expect(recipe).toHaveAttribute('data-availability', 'ready');
    expect(within(recipe).getByText('Verifica le quantità')).toBeVisible();
    expect(within(recipe).getByText('La quantità potrebbe non bastare per: Pasta.')).toBeVisible();
  });

  it('offers the one-missing search after an empty result and then links to pantry management', async () => {
    const user = userEvent.setup();
    seedPantry('ingrediente impossibile');
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Trova ricette' }));
    expect(screen.getByRole('heading', { name: 'Nessuna ricetta pronta con questi ingredienti' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Prova con 1 ingrediente in più' }));

    expect(screen.getByLabelText('Anche con 1 ingrediente in più')).toBeChecked();
    expect(screen.getByRole('link', { name: 'Gestisci la dispensa' })).toHaveAttribute('href', '/pantry');
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
          <Route path="/cucina" element={<HomePage />} />
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
