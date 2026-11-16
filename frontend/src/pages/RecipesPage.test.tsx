import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { AccountSummary, GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError } from '../api/apiClient';
import RecipesPage from './RecipesPage';
import AiRecipePanel from '../components/ai/AiRecipePanel';
import { useAuthStore } from '../auth/authStore';
import { getActiveDataScope, setActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import type { SyncScope } from '../sync/scopeContext';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { writeSavedRecipes, clearDinnerDiary } from '../storage/dinnerDiaryStorage';
import * as dinnerDiaryStorage from '../storage/dinnerDiaryStorage';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';

vi.mock('../ai/aiRecipeApi', () => ({
  fetchAiRecipes: vi.fn(),
}));

vi.mock('../components/ai/AiRecipePanel', () => ({ default: vi.fn(() => <section aria-label="Creazione ricetta AI">Crea una ricetta con l’AI</section>) }));

// The diary store is only needed by the page to hydrate RecipeDetailPage data:
// keep the real store (and its scope subscriptions) out of these render tests.
vi.mock('../store/dinnerDiaryStore', () => ({
  hydrateDinnerDiaryStore: vi.fn(() => Promise.resolve()),
}));

const user: AccountSummary = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

const orataRecipe: GeneratedRecipe = {
  id: 'saved-orata',
  source: 'ai',
  title: 'Orata al forno',
  description: 'Orata al forno con patate.',
  ingredients: [{ name: 'Orata', amount: '1' }, { name: 'Patate', amount: '300 g' }],
  steps: ['Inforna l’orata a 200 gradi.', 'Servi con contorno.'],
  diets: [],
  allergens: [],
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-14T12:00:00.000Z',
};

const curryRecipe: GeneratedRecipe = {
  id: 'saved-pollo-curry',
  source: 'ai',
  title: 'Pollo al curry',
  description: 'Pollo speziato.',
  ingredients: [{ name: 'Pollo', amount: '300 g' }, { name: 'Curry', amount: '1 cucchiaio' }],
  steps: ['Cuoci il pollo con il curry.'],
  diets: [],
  allergens: [],
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-15T12:00:00.000Z',
};

const savedRecipe = (overrides: Partial<SavedRecipe> = {}): SavedRecipe => ({
  id: 'saved-lasagne',
  title: 'Lasagne al forno',
  description: 'Lasagne della domenica.',
  ingredients: [
    { name: 'Sfoglie', amount: '250 g', ingredientId: null, optional: false, provenance: 'provided' },
    { name: 'Besciamella', amount: '500 ml', ingredientId: null, optional: false, provenance: 'provided' },
  ],
  steps: ['Stendi le sfoglie.', 'Cuoci in forno a 180 gradi per 30 minuti.'],
  servings: 4,
  durationMinutes: 90,
  diets: null,
  allergens: null,
  suggestedFields: [],
  source: 'diary',
  authorId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  ...overrides,
});

const pestoRecipe = savedRecipe({
  id: 'saved-pesto',
  title: 'Pasta al pesto',
  description: '',
  ingredients: [
    { name: 'Basilico', amount: 'un mazzo', ingredientId: null, optional: false, provenance: 'provided' },
    { name: 'Pinoli', amount: '30 g', ingredientId: null, optional: false, provenance: 'provided' },
  ],
  steps: ['Pesta basilico e pinoli.'],
  createdAt: '2026-10-03T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
});

const tortaLimoneRecipe = savedRecipe({
  id: 'saved-torta-limone',
  title: 'Torta al limone',
  description: 'Torta soffice al limone.',
  ingredients: [
    { name: 'Limone', amount: '2', ingredientId: null, optional: false, provenance: 'provided' },
    { name: 'Farina', amount: '250 g', ingredientId: null, optional: false, provenance: 'provided' },
  ],
  steps: ['Mescola farina e uova con la scorza di limone.'],
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-06T10:00:00.000Z',
});

const giudiaLibraryRecipe = savedRecipe({
  id: 'saved-giudia',
  title: 'Carciofi alla giudìa',
  description: 'Carciofi fritti croccanti.',
  ingredients: [
    { name: 'Carciofi', amount: '4', ingredientId: null, optional: false, provenance: 'provided' },
    { name: 'Olio', amount: 'q.b.', ingredientId: null, optional: false, provenance: 'provided' },
  ],
  steps: ['Fritta i carciofi finché non sono dorati.'],
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
});

const limoneAiRecipe: GeneratedRecipe = {
  id: 'saved-limone-ai',
  source: 'ai',
  title: 'Salsa al limone',
  description: 'Salsa veloce per il pesce.',
  ingredients: [{ name: 'Limone', amount: '1' }, { name: 'Burro', amount: '50 g' }],
  steps: ['Sciogli il burro e unisci il succo di limone.'],
  diets: [],
  allergens: [],
  createdAt: '2026-09-16T12:00:00.000Z',
  updatedAt: '2026-09-17T12:00:00.000Z',
};

const giudiaAiRecipe: GeneratedRecipe = {
  id: 'saved-giudia-ai',
  source: 'ai',
  title: 'Carciofi alla giudìa del forno',
  description: 'Versione forno più leggera.',
  ingredients: [{ name: 'Carciofi', amount: '4' }, { name: 'Aglio', amount: '1 spicchio' }],
  steps: ['Condisci e inforna.'],
  diets: [],
  allergens: [],
  createdAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-19T12:00:00.000Z',
};

const pageCommitSnapshots: Array<{
  userId: string | null;
  verified: boolean;
  csrfToken: string | null;
  scope: SyncScope;
  bodyText: string;
}> = [];

function PageCommitProbe() {
  const currentUser = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const activeScope = useSyncExternalStore(
    (listener: () => void) => subscribeActiveDataScope(listener),
    getActiveDataScope,
    getActiveDataScope,
  );
  const verified = currentUser !== null && currentUser.emailVerifiedAt.trim().length > 0 && csrfToken !== null;

  useLayoutEffect(() => {
    pageCommitSnapshots.push({
      userId: currentUser?.id ?? null,
      verified,
      csrfToken,
      scope: activeScope,
      bodyText: document.body.textContent ?? '',
    });
  }, [currentUser, verified, csrfToken, activeScope]);

  return null;
}

const renderPage = () => render(
  <MemoryRouter initialEntries={['/recipes']}>
    <Routes>
      <Route path="/recipes" element={<><RecipesPage /><PageCommitProbe /></>} />
    </Routes>
  </MemoryRouter>,
);

const setVerifiedSession = (): void => {
  useAuthStore.setState({
    user,
    csrfToken: 'csrf-token',
    expiresAt: '2026-10-20T10:00:00.000Z',
  });
  setActiveDataScope('account:user-1');
};

beforeEach((): void => {
  pageCommitSnapshots.length = 0;
  vi.mocked(fetchAiRecipes).mockReset();
  vi.mocked(hydrateDinnerDiaryStore).mockClear();
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  setActiveDataScope('guest');
});

afterEach((): void => {
  vi.restoreAllMocks();
});

describe('RecipesPage', () => {
  const ownershipTransitions = [
    {
      transition: 'verification is revoked',
      user: { ...user, emailVerifiedAt: '' },
      csrfToken: 'csrf-token',
      scope: 'account:user-1',
    },
    {
      transition: 'the session signs out',
      user: null,
      csrfToken: null,
      scope: 'account:user-1',
    },
    {
      transition: 'the user ID changes',
      user: { ...user, id: 'user-2' },
      csrfToken: 'csrf-token',
      scope: 'account:user-1',
    },
    {
      transition: 'the CSRF session token changes',
      user,
      csrfToken: 'csrf-token-2',
      scope: 'account:user-1',
    },
    {
      transition: 'the active data scope changes',
      user,
      csrfToken: 'csrf-token',
      scope: 'house:house-1',
    },
  ] satisfies Array<{
    transition: string;
    user: AccountSummary | null;
    csrfToken: string | null;
    scope: SyncScope;
  }>;

  it.each(ownershipTransitions)(
    'hides a previously loaded private AI card in the committed render when $transition',
    async ({ user: nextUser, csrfToken: nextCsrfToken, scope: nextScope }) => {
      setVerifiedSession();
      vi.mocked(fetchAiRecipes)
        .mockResolvedValueOnce([orataRecipe])
        .mockImplementation(() => new Promise<GeneratedRecipe[]>(() => {}));

      renderPage();
      expect(await screen.findByRole('heading', { name: orataRecipe.title })).toBeVisible();

      const snapshotCount = pageCommitSnapshots.length;
      act(() => {
        useAuthStore.setState({ user: nextUser, csrfToken: nextCsrfToken, expiresAt: null });
        setActiveDataScope(nextScope);
      });

      const committedRender = pageCommitSnapshots.slice(snapshotCount).at(-1);
      expect(committedRender).toBeDefined();
      expect(committedRender).toMatchObject({
        userId: nextUser?.id ?? null,
        verified: nextUser !== null && nextUser.emailVerifiedAt.trim().length > 0 && nextCsrfToken !== null,
        csrfToken: nextCsrfToken,
        scope: nextScope,
      });
      expect(committedRender?.bodyText).not.toContain(orataRecipe.title);
    },
  );

  it('ignores a prior-scope in-flight response and displays only the current scope collection', async () => {
    const staleResponseRecipe = { ...orataRecipe, id: 'stale-account-recipe', title: 'Ricetta account obsoleta' };
    const houseRecipe = { ...orataRecipe, id: 'house-recipe', title: 'Ricetta della casa attiva' };
    let resolveStaleResponse!: (recipes: GeneratedRecipe[]) => void;
    const staleResponse = new Promise<GeneratedRecipe[]>((resolve) => { resolveStaleResponse = resolve; });
    setVerifiedSession();
    vi.mocked(fetchAiRecipes)
      .mockResolvedValueOnce([orataRecipe])
      .mockReturnValueOnce(staleResponse)
      .mockResolvedValueOnce([houseRecipe]);

    renderPage();
    expect(await screen.findByRole('heading', { name: orataRecipe.title })).toBeVisible();

    act(() => useAuthStore.setState({ user, csrfToken: 'rotated-csrf-token', expiresAt: null }));
    await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledTimes(2));
    act(() => setActiveDataScope('house:house-1'));

    await act(async () => { resolveStaleResponse([staleResponseRecipe]); });
    expect(screen.queryByRole('heading', { name: staleResponseRecipe.title })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole('heading', { name: houseRecipe.title })).toBeVisible();
    expect(screen.queryByRole('heading', { name: orataRecipe.title })).not.toBeInTheDocument();
  });

  it('offers title generation and immediately adds explicitly saved recipes to the library', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.queryByText('Carico le tue ricette AI…')).not.toBeInTheDocument());
    const props = vi.mocked(AiRecipePanel).mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({ generationMode: 'title', ingredients: [], csrfToken: 'csrf-token' });
    act(() => props?.onRecipeSaved?.(orataRecipe));
    expect(await screen.findByRole('heading', { name: orataRecipe.title })).toBeVisible();
  });

  it('does not show links to search, saved recipes or the removed diary page', () => {
    renderPage();
    expect(screen.queryByRole('navigation', { name: 'Altre sezioni di Ricette' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Cerca ricette' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ricette salvate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Diario delle cene' })).not.toBeInTheDocument();
  });

  it('usa le superfici e l’indicatore di focus semantici per ricerca e navigazione', () => {
    renderPage();

    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    const searchRegion = screen.getByRole('region', { name: 'Ricerca tra le ricette' });

    expect(searchRegion).toHaveClass('bg-[var(--ik-surface)]');
    expect(search).toHaveClass('ik-input');
    expect(search).toHaveClass('focus-visible:outline-[var(--ik-focus)]');
    expect(screen.getByRole('main')).toHaveClass('ik-recipes-page');
  });

  it('etichetta la raccolta con un titolo distinto e univoco, mantenendo il nome della ricerca', () => {
    renderPage();

    const pageTitle = screen.getByRole('heading', { level: 1, name: 'Ricette' });
    expect(screen.getByRole('region', { name: 'Ricerca tra le ricette' })).toBeInTheDocument();
    const resultsTitle = screen.queryByRole('heading', { level: 2, name: 'La tua raccolta' });
    expect(resultsTitle).toBeVisible();
    if (resultsTitle === null) return;

    const resultsRegion = screen.queryByRole('region', { name: 'La tua raccolta' });
    const titleId = resultsTitle.getAttribute('id');

    expect(titleId).toBeTruthy();
    expect(resultsTitle.id).not.toBe(pageTitle.id);
    expect(resultsRegion).toHaveAttribute('aria-labelledby', titleId);
    expect(document.querySelectorAll(`[id="${titleId}"]`)).toHaveLength(1);
  });

  it('riunisce tutte le fonti in un solo gruppo Ricette', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([orataRecipe]);

    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Orata al forno' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Le tue ricette AI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Le tue ricette salvate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ricette suggerite' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'La tua raccolta' })).getByText('Orata al forno')).toBeInTheDocument();
    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getAllByText('Catalogo').length).toBeGreaterThan(0);
  });

  it('ordina le ricette salvate per updatedAt discendente', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([orataRecipe, curryRecipe]);

    renderPage();

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: /^(Orata al forno|Pollo al curry)$/ })).toHaveLength(2),
    );
    const titles = screen.getAllByRole('heading', { name: /^(Orata al forno|Pollo al curry)$/ });
    expect(titles.map((heading) => heading.textContent)).toEqual(['Pollo al curry', 'Orata al forno']);
  });

  it('filtra live per titolo con la ricerca', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([orataRecipe]);

    renderPage();

    await waitFor(() => expect(screen.getByText('Orata al forno')).toBeInTheDocument());
    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();
    await userEvents.type(search, 'orata');

    await waitFor(() => expect(screen.queryByText('Pollo al limone')).not.toBeInTheDocument());
    expect(screen.getByText('Orata al forno')).toBeInTheDocument();
  });

  it('filtra anche sui nomi degli ingredienti delle ricette salvate', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([curryRecipe]);

    renderPage();

    await waitFor(() => expect(screen.getByText('Pollo al curry')).toBeInTheDocument());

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();
    await userEvents.type(search, 'curry');

    expect(screen.getByText('Pollo al curry')).toBeInTheDocument();
    expect(screen.queryByText('Pollo al limone')).not.toBeInTheDocument();
  });

  it('mostra lo stato di caricamento solo sul gruppo salvate, catalogo consultabile', async () => {
    setVerifiedSession();
    let resolveRecipes: ((value: GeneratedRecipe[]) => void) | null = null;
    vi.mocked(fetchAiRecipes).mockReturnValue(new Promise((resolve) => { resolveRecipes = resolve; }));

    renderPage();

    expect(screen.getByText('Carico le tue ricette AI…')).toBeInTheDocument();
    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();

    act(() => { resolveRecipes!([orataRecipe]); });
    await waitFor(() => expect(screen.getByText('Orata al forno')).toBeInTheDocument());
    expect(screen.queryByText('Carico le tue ricette AI…')).not.toBeInTheDocument();
  });

  it('mantiene il catalogo consultabile in caso di errore di rete sulle salvate', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockRejectedValue(new ApiClientError(0, 'network_error', 'down'));

    renderPage();

    await waitFor(() => expect(screen.getByText(/Servizio non raggiungibile/)).toBeInTheDocument());
    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();
    expect(fetchAiRecipes).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      source: 'AI',
      error: 'Servizio non raggiungibile: le ricette AI restano disponibili solo online.',
      matchTitle: 'Lasagne al forno',
      matchQuery: 'lasagne',
      prepare: async (): Promise<void> => {
        setVerifiedSession();
        await clearDinnerDiary('account:user-1');
        await writeSavedRecipes([savedRecipe()], 'account:user-1');
        vi.mocked(fetchAiRecipes).mockRejectedValue(new ApiClientError(0, 'network_error', 'down'));
      },
    },
    {
      source: 'lettura locale',
      error: 'Non è stato possibile caricare le tue ricette salvate. Riprova.',
      matchTitle: 'Orata al forno',
      matchQuery: 'orata',
      prepare: (): void => {
        setVerifiedSession();
        vi.spyOn(dinnerDiaryStorage, 'readSavedRecipes').mockRejectedValue(new Error('IndexedDB unavailable'));
        vi.mocked(fetchAiRecipes).mockResolvedValue([orataRecipe]);
      },
    },
  ])('mantiene le corrispondenze riuscite e non dichiara vuota la ricerca se fallisce $source', async ({
    prepare,
    error,
    matchTitle,
    matchQuery,
  }) => {
    await prepare();
    renderPage();

    await screen.findByText(error);
    await waitFor(() => {
      expect(screen.queryByText('Carico le tue ricette salvate…')).not.toBeInTheDocument();
      expect(screen.queryByText('Carico le tue ricette AI…')).not.toBeInTheDocument();
    });

    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    const userEvents = userEvent.setup();
    await userEvents.type(search, matchQuery);

    expect(await screen.findByRole('heading', { name: matchTitle })).toBeVisible();
    expect(screen.getByText(error)).toBeInTheDocument();
    expect(screen.queryByText(/Nessuna ricetta trovata/)).not.toBeInTheDocument();

    await userEvents.clear(search);
    await userEvents.type(search, 'quasar-ricetta-assente-xyz');

    expect(screen.getByText(error)).toBeInTheDocument();
    expect(screen.queryByText(/Nessuna ricetta trovata/)).not.toBeInTheDocument();
  });

  it('ospite: raccolta visibile senza sezioni AI separate e nessuna chiamata', async () => {
    renderPage();

    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('ospite: offre l’accesso al profilo senza effettuare richieste AI', () => {
    renderPage();

    expect(fetchAiRecipes).not.toHaveBeenCalled();
    const profileLink = screen.queryByRole('link', { name: 'Accedi al tuo account' });
    expect(profileLink).toBeVisible();
    expect(profileLink).toHaveAttribute('href', '/profile');
  });

  it.each(['ospite', 'sessione non verificata'])('completa la ricerca senza consultare AI quando la sessione è %s', async (sessionState) => {
    if (sessionState === 'sessione non verificata') {
      useAuthStore.setState({
        user: { ...user, emailVerifiedAt: '' },
        csrfToken: 'csrf-token',
        expiresAt: '2026-10-20T10:00:00.000Z',
      });
      setActiveDataScope('account:user-1');
    }

    renderPage();
    await waitFor(() => expect(screen.queryByText('Carico le tue ricette salvate…')).not.toBeInTheDocument());
    expect(fetchAiRecipes).not.toHaveBeenCalled();

    const userEvents = userEvent.setup();
    await userEvents.type(screen.getByRole('searchbox', { name: 'Cerca ricette' }), 'quasar-ricetta-assente-xyz');

    expect(await screen.findByText(/Nessuna ricetta trovata/)).toBeVisible();
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('vuoto senza risultati mostra CTA Trova ricette verso Home', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([]);

    renderPage();

    await waitFor(() => expect(screen.queryByText('Carico le tue ricette AI…')).not.toBeInTheDocument());

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();
    await userEvents.type(search, 'ricetta-inesistente-xyz');

    await waitFor(() => expect(screen.getByText(/Nessuna ricetta trovata/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Trova ricette' })).toHaveAttribute('href', '/');
  });

  it('ospite: legge le ricette salvate dal diario in read-only e apre il dettaglio con scope', async () => {
    await writeSavedRecipes([savedRecipe()], 'guest');

    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument());
    expect(screen.getByText('Salvata')).toBeInTheDocument();
    expect(hydrateDinnerDiaryStore).toHaveBeenCalledTimes(1);

    const card = screen.getByRole('heading', { name: 'Lasagne al forno' }).closest('article');
    expect(card).not.toBeNull();
    const cardScreen = within(card as HTMLElement);

    // Read-only: nessun form e nessun comando di creazione/modifica/eliminazione.
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: /crea|modifica|elimina/i })).not.toBeInTheDocument();

    // Card espandibile con ingredienti e procedimento.
    const toggle = cardScreen.getByRole('button', { name: 'Mostra dettagli' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const userEvents = userEvent.setup();
    await userEvents.click(toggle);
    expect(cardScreen.getByRole('button', { name: 'Nascondi dettagli' })).toHaveAttribute('aria-expanded', 'true');
    expect(cardScreen.getByText('Sfoglie', { exact: true })).toBeInTheDocument();
    expect(cardScreen.getByText('250 g')).toBeInTheDocument();
    expect(cardScreen.getByText('Cuoci in forno a 180 gradi per 30 minuti.')).toBeInTheDocument();

    // Link al dettaglio con lo scope attivo, come per le ricette del diario.
    expect(screen.getByRole('link', { name: 'Apri Lasagne al forno' }))
      .toHaveAttribute('href', '/recipes/saved-lasagne?scope=guest');
  });

  it('casa: mostra solo le ricette salvate dello scope casa attivo', async () => {
    await writeSavedRecipes([savedRecipe({ id: 'saved-casa', title: 'Minestra di ceci della casa' })], 'house:house-1');
    await writeSavedRecipes([savedRecipe({ id: 'saved-guest', title: 'Galette di mele' })], 'guest');

    setActiveDataScope('house:house-1');
    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Minestra di ceci della casa' })).toBeInTheDocument());
    expect(screen.queryByText('Galette di mele')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apri Minestra di ceci della casa' }))
      .toHaveAttribute('href', '/recipes/saved-casa?scope=house%3Ahouse-1');
  });

  it('applica la ricerca live al gruppo salvate per titolo e per ingrediente', async () => {
    await writeSavedRecipes([savedRecipe(), pestoRecipe], 'guest');

    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Pasta al pesto' })).toBeInTheDocument();

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();

    await userEvents.type(search, 'lasagne');
    await waitFor(() => expect(screen.queryByText('Pasta al pesto')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument();

    await userEvents.clear(search);
    await userEvents.type(search, 'besciamella');
    await waitFor(() => expect(screen.queryByText(/Nessuna ricetta salvata/)).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument();
    expect(screen.queryByText('Pasta al pesto')).not.toBeInTheDocument();
    // La coincidenza solo nel gruppo salvate tiene nascosta la CTA «nessun risultato».
    expect(screen.queryByText(/Nessuna ricetta trovata/)).not.toBeInTheDocument();

    await userEvents.clear(search);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Pasta al pesto' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument();
  });

  // Filtro unificato: una sola query attraversa i tre gruppi (salvate, AI, catalogo).
  const seedUnifiedGroups = async (): Promise<void> => {
    setVerifiedSession();
    await clearDinnerDiary('account:user-1');
    await writeSavedRecipes([tortaLimoneRecipe, giudiaLibraryRecipe], 'account:user-1');
    vi.mocked(fetchAiRecipes).mockResolvedValue([limoneAiRecipe, giudiaAiRecipe]);
  };

  it('filtra i tre gruppi con una sola query e ripristina tutto con query vuota', async () => {
    await seedUnifiedGroups();
    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Torta al limone' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Salsa al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa del forno' })).toBeInTheDocument();

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();
    await userEvents.type(search, 'limone');

    // Una coincidenza per gruppo: salvate, AI e catalogo restano; le giudìa escono.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Carciofi alla giudìa' })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Torta al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Salsa al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Carciofi alla giudìa del forno' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nessuna ricetta trovata/)).not.toBeInTheDocument();

    // Query vuota: tutti i gruppi tornano completi, con le rispettive badge.
    await userEvents.clear(search);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa del forno' })).toBeInTheDocument();
    expect(screen.getAllByText('Salvata').length).toBe(2);
    expect(screen.getAllByText('AI').length).toBe(2);
    expect(screen.getAllByText('Catalogo').length).toBeGreaterThan(0);
  });

  it('nessuna corrispondenza in nessun gruppo mostra la CTA e nasconde tutte le card', async () => {
    await seedUnifiedGroups();
    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Torta al limone' })).toBeInTheDocument());

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();
    await userEvents.type(search, 'zzzzzz');

    await waitFor(() => expect(screen.getByText(/Nessuna ricetta trovata/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Trova ricette' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('heading', { name: 'Torta al limone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Salsa al limone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pollo al limone' })).not.toBeInTheDocument();
  });

  it('la ricerca ignora gli accenti sia con query accentata sia senza', async () => {
    await seedUnifiedGroups();
    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Torta al limone' })).toBeInTheDocument());

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();

    // Query senza accento su titolo accentato: coincide in salvate e AI, non nel catalogo.
    await userEvents.type(search, 'giudia');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa del forno' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Torta al limone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pollo al limone' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nessuna ricetta trovata/)).not.toBeInTheDocument();

    // Query con accento: stesso risultato.
    await userEvents.clear(search);
    await userEvents.type(search, 'giudìa');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa del forno' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Carciofi alla giudìa' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Torta al limone' })).not.toBeInTheDocument();
  });
});
