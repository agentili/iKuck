import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AccountSummary, GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError } from '../api/apiClient';
import RecipesPage from './RecipesPage';
import { useAuthStore } from '../auth/authStore';
import { setActiveDataScope } from '../sync/scopeContext';
import { fetchAiConsentStatus, fetchAiRecipes } from '../ai/aiRecipeApi';
import { writeSavedRecipes, clearDinnerDiary } from '../storage/dinnerDiaryStorage';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';

vi.mock('../ai/aiRecipeApi', () => ({
  fetchAiRecipes: vi.fn(),
  fetchAiConsentStatus: vi.fn(),
}));

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

const renderPage = () => render(
  <MemoryRouter initialEntries={['/recipes']}>
    <Routes>
      <Route path="/recipes" element={<RecipesPage />} />
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
  vi.mocked(fetchAiRecipes).mockReset();
  vi.mocked(fetchAiConsentStatus).mockReset().mockResolvedValue({ consent: { enabled: false, updatedAt: '2026-10-26T00:00:00.000Z' }, selectedProvider: 'gemini' });
  vi.mocked(hydrateDinnerDiaryStore).mockClear();
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  setActiveDataScope('guest');
});

describe('RecipesPage', () => {
  it('loads AI consent only after opening generation and resets the section when the session changes', async () => {
    const actions = userEvent.setup();
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledOnce());
    expect(fetchAiConsentStatus).not.toHaveBeenCalled();
    await actions.click(screen.getByText('Crea con AI', { selector: 'summary' }));
    await waitFor(() => expect(fetchAiConsentStatus).toHaveBeenCalledOnce());
    expect(screen.getByText('Crea con AI', { selector: 'summary' }).closest('details')).toHaveAttribute('open');
    act(() => useAuthStore.setState({ user: { ...user, id: 'user-2' }, csrfToken: 'csrf-user-2' }));
    expect(screen.getByText('Crea con AI', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
    expect(fetchAiConsentStatus).toHaveBeenCalledOnce();
  });

  it('drops a saved AI response from the previous session without exposing it in the new account', async () => {
    setVerifiedSession();
    let resolveOld!: (recipes: GeneratedRecipe[]) => void;
    vi.mocked(fetchAiRecipes).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue([]);
    renderPage();
    act(() => useAuthStore.setState({ user: { ...user, id: 'user-2' }, csrfToken: 'csrf-user-2' }));
    await act(async () => resolveOld([orataRecipe]));
    expect(screen.queryByRole('heading', { name: 'Orata al forno' })).not.toBeInTheDocument();
  });
  it('renderizza i tre gruppi con le badge di fonte per una sessione verificata', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([orataRecipe]);

    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Orata al forno' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Le tue ricette salvate' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Le tue ricette AI' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ricette suggerite' })).toBeInTheDocument();
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

  it('ospite: catalogo visibile, gruppo salvate con CTA accesso e nessuna chiamata', async () => {
    renderPage();

    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();
    expect(screen.getByText(/Ricette AI riservate agli account verificati/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Accedi al tuo account' })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('heading', { name: 'Le tue ricette salvate' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Nessuna ricetta salvata ancora.')).toBeInTheDocument());
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('vuoto senza risultati mostra CTA Trova ricette verso Home', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([]);

    renderPage();

    await waitFor(() => expect(screen.getByText('Nessuna ricetta AI salvata ancora.')).toBeInTheDocument());

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
