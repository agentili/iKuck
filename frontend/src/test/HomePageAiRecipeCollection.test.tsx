import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedRecipe, GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { DEFAULT_STAPLE_IDS, parseIngredientInput } from '@ikuck/shared/ingredients';
import { fetchAiConsentStatus, fetchAiRecipes, generateRecipeFromPantry, saveAiRecipe } from '../ai/aiRecipeApi';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import HomePage from '../pages/HomePage';
import { useAuthStore } from '../auth/authStore';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import { useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, setActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { usePersistenceStatusStore } from '../store/persistenceStatusStore';

const apiMocks = vi.hoisted(() => ({
  fetchAiConsentStatus: vi.fn(),
  fetchAiRecipes: vi.fn(),
  generateRecipeFromPantry: vi.fn(),
  saveAiRecipe: vi.fn(),
  hydratePantryStore: vi.fn(),
}));

vi.mock('../ai/aiRecipeApi', async () => ({
  ...(await vi.importActual<typeof import('../ai/aiRecipeApi')>('../ai/aiRecipeApi')),
  fetchAiConsentStatus: apiMocks.fetchAiConsentStatus,
  fetchAiRecipes: apiMocks.fetchAiRecipes,
  generateRecipeFromPantry: apiMocks.generateRecipeFromPantry,
  saveAiRecipe: apiMocks.saveAiRecipe,
}));

vi.mock('../store/localPantryStore', async () => ({
  ...(await vi.importActual<typeof import('../store/localPantryStore')>('../store/localPantryStore')),
  hydratePantryStore: apiMocks.hydratePantryStore,
}));

const canonicalRecipesByOwner = new Map<string, GeneratedRecipe[]>();

const currentOwnerKey = (): string => {
  const { user, csrfToken } = useAuthStore.getState();
  return `${user?.id ?? 'guest'}|${csrfToken ?? 'no-session'}|${getActiveDataScope()}`;
};

const recipeDraft = (title: string, description = 'Bozza generata dalla dispensa.'): GeneratedRecipeDraft => ({
  title,
  description,
  ingredients: [{ name: 'Pasta', amount: '160 g' }],
  steps: ['Cuoci la pasta.'],
  diets: ['pescatarian'],
  allergens: ['fish'],
});

const savedRecipe = (id: string, title: string, description: string): GeneratedRecipe => ({
  ...recipeDraft(title, description),
  id,
  source: 'ai',
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:01:00.000Z',
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

const owner = (userId: string, csrfToken: string, scope: SyncScope): void => {
  act(() => {
    useAuthStore.setState({
      user: { id: userId, email: `${userId}@example.test`, emailVerifiedAt: '2026-09-12T10:00:00.000Z' },
      csrfToken,
      expiresAt: null,
    });
    setActiveDataScope(scope);
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: parseIngredientInput('pasta'),
      pantryLots: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [], recipes: [], drafts: [], error: null });
  });
};

const renderHome = () => render(
  <MemoryRouter>
    <HomePage />
  </MemoryRouter>,
);

const openPantryPreview = async (user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> => {
  vi.mocked(generateRecipeFromPantry).mockResolvedValueOnce({ kind: 'candidate', recipe: recipeDraft(title) });
  await user.click(screen.getByRole('button', { name: 'Genera ricetta da dispensa' }));
  const preview = await screen.findByRole('dialog', { name: 'Anteprima ricetta' });
  expect(within(preview).getByRole('heading', { name: title })).toBeVisible();
  return preview;
};

const savePantryPreview = async (user: ReturnType<typeof userEvent.setup>, preview: HTMLElement): Promise<void> => {
  await user.click(within(preview).getByRole('button', { name: 'Salva nel ricettario' }));
  await waitFor(() => expect(saveAiRecipe).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument());
};

beforeEach(() => {
  window.localStorage.clear();
  canonicalRecipesByOwner.clear();
  vi.mocked(fetchAiConsentStatus).mockReset();
  vi.mocked(fetchAiRecipes).mockReset();
  vi.mocked(generateRecipeFromPantry).mockReset();
  vi.mocked(saveAiRecipe).mockReset();
  vi.mocked(apiMocks.hydratePantryStore).mockReset();
  vi.mocked(apiMocks.hydratePantryStore).mockResolvedValue(undefined);
  vi.mocked(fetchAiConsentStatus).mockResolvedValue({
    consent: { enabled: false, updatedAt: '2026-09-12T10:00:00.000Z' },
    selectedProvider: 'openai',
  });
  vi.mocked(fetchAiRecipes).mockImplementation(async () => (
    structuredClone(canonicalRecipesByOwner.get(currentOwnerKey()) ?? [])
  ));
  vi.mocked(saveAiRecipe).mockImplementation(async (recipe) => {
    const key = currentOwnerKey();
    const saved = structuredClone(recipe);
    canonicalRecipesByOwner.set(key, [saved, ...(canonicalRecipesByOwner.get(key) ?? []).filter((item) => item.id !== saved.id)]);
    return saved;
  });
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  setActiveDataScope('guest');
  owner('user-1', 'csrf-token', 'account:user-1');
  usePantryStore.setState({
    hasHydrated: true,
    pantryItems: parseIngredientInput('pasta'),
    pantryLots: [],
    stapleIds: [...DEFAULT_STAPLE_IDS],
  });
  useActivityStore.setState({ events: [], preferences: [] });
  useDietProfileStore.setState({
    hasHydrated: true,
    profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-09-12T10:00:00.000Z' },
  });
  useShoppingListStore.setState({ hasHydrated: true, items: [] });
  useDinnerDiaryStore.setState({ hasHydrated: true, entries: [], recipes: [], drafts: [], error: null });
  usePersistenceStatusStore.getState().reset();
});

describe('Home pantry saves and the real AI recipe collection', () => {
  it('shows the server-confirmed recipe in the mounted collection immediately after saving the pantry preview', async () => {
    const user = userEvent.setup();
    const canonical = savedRecipe('server-recipe-1', 'Pasta al tonno', 'Descrizione confermata dal server.');
    vi.mocked(saveAiRecipe).mockImplementationOnce(async (recipe) => {
      canonicalRecipesByOwner.set(currentOwnerKey(), [canonical]);
      expect(recipe.title).toBe('Pasta al tonno');
      return canonical;
    });
    const view = renderHome();
    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(panel).queryByText('Carico le tue ricette AI…')).not.toBeInTheDocument());

    const preview = await openPantryPreview(user, 'Pasta al tonno');
    await savePantryPreview(user, preview);

    expect(screen.getByRole('region', { name: 'Ricette AI private' })).toBe(panel);
    const card = await within(panel).findByRole('article');
    expect(card).toHaveAttribute('data-ai-recipe');
    expect(within(card).getByRole('heading', { name: canonical.title })).toBeVisible();
    expect(within(card).getByText(canonical.description)).toBeVisible();
    expect(within(panel).getAllByRole('article')).toHaveLength(1);
    expect(view.container.querySelector('[data-ai-recipe]')).toBe(card);
  });

  it('keeps a pantry-saved recipe when the same-owner initial collection fetch resolves late', async () => {
    const user = userEvent.setup();
    const canonical = savedRecipe('server-recipe-late-fetch', 'Pasta salvata durante il caricamento', 'Risultato confermato prima della risposta iniziale.');
    const delayedInitialFetch = deferred<GeneratedRecipe[]>();
    vi.mocked(fetchAiRecipes)
      .mockImplementationOnce(() => delayedInitialFetch.promise)
      .mockImplementation(async () => structuredClone(canonicalRecipesByOwner.get(currentOwnerKey()) ?? []));
    vi.mocked(saveAiRecipe).mockImplementationOnce(async () => {
      canonicalRecipesByOwner.set(currentOwnerKey(), [canonical]);
      return canonical;
    });
    const view = renderHome();
    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledOnce());
    expect(within(panel).getByText('Carico le tue ricette AI…')).toBeVisible();

    const preview = await openPantryPreview(user, canonical.title);
    await savePantryPreview(user, preview);
    expect(within(panel).queryByText('Carico le tue ricette AI…')).toBeVisible();

    await act(async () => {
      delayedInitialFetch.resolve([]);
      await delayedInitialFetch.promise;
    });

    const card = await within(panel).findByRole('article');
    expect(within(card).getByRole('heading', { name: canonical.title })).toBeVisible();
    expect(within(card).getByText(canonical.description)).toBeVisible();
    expect(view.container.querySelector('[data-ai-recipe]')).toBe(card);
  });

  const ownerTransitions = [
    { label: 'account changes', userId: 'user-2', csrfToken: 'csrf-token-2', scope: 'account:user-2' },
    { label: 'session token rotates', userId: 'user-1', csrfToken: 'rotated-csrf-token', scope: 'account:user-1' },
    { label: 'house scope changes', userId: 'user-1', csrfToken: 'csrf-token', scope: 'house:house-1' },
  ] satisfies Array<{ label: string; userId: string; csrfToken: string; scope: SyncScope }>;

  it.each(ownerTransitions)(
    'does not let a stale pantry-save response cross ownership when the $label',
    async ({ userId, csrfToken, scope }) => {
      const user = userEvent.setup();
      const pendingOldResponse = deferred<GeneratedRecipe>();
      const oldSaved = savedRecipe('owner-a-recipe', 'Ricetta del proprietario precedente', 'Non deve apparire nel nuovo ambito.');
      const currentSaved = savedRecipe('current-owner-recipe', 'Ricetta del proprietario corrente', 'Salvata dal proprietario corrente.');
      vi.mocked(saveAiRecipe).mockImplementation(async (recipe) => {
        const key = currentOwnerKey();
        if (recipe.title === 'Bozza del proprietario precedente') {
          canonicalRecipesByOwner.set(key, [oldSaved]);
          return pendingOldResponse.promise;
        }
        canonicalRecipesByOwner.set(key, [currentSaved]);
        return currentSaved;
      });
      const view = renderHome();

      const oldPreview = await openPantryPreview(user, 'Bozza del proprietario precedente');
      await user.click(within(oldPreview).getByRole('button', { name: 'Salva nel ricettario' }));
      await waitFor(() => expect(saveAiRecipe).toHaveBeenCalledOnce());

      owner(userId, csrfToken, scope);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Anteprima ricetta' })).not.toBeInTheDocument());
      await screen.findByRole('button', { name: 'Genera ricetta da dispensa' });
      await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledTimes(2));

      const currentPreview = await openPantryPreview(user, 'Bozza del proprietario corrente');
      await savePantryPreview(user, currentPreview);
      const panel = screen.getByRole('region', { name: 'Ricette AI private' });
      const currentCard = await within(panel).findByRole('article');
      expect(within(currentCard).getByRole('heading', { name: currentSaved.title })).toBeVisible();

      await act(async () => {
        pendingOldResponse.resolve(oldSaved);
        await pendingOldResponse.promise;
      });

      expect(within(panel).getByRole('heading', { name: currentSaved.title })).toBeVisible();
      expect(within(panel).queryByRole('heading', { name: oldSaved.title })).not.toBeInTheDocument();
      expect(view.container.querySelectorAll('[data-ai-recipe]')).toHaveLength(1);
    },
  );
});
