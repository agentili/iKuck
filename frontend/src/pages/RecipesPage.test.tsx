import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AccountSummary, GeneratedRecipe } from '@ikuck/shared/contracts';
import { ApiClientError } from '../api/apiClient';
import RecipesPage from './RecipesPage';
import { useAuthStore } from '../auth/authStore';
import { setActiveDataScope } from '../sync/scopeContext';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';

vi.mock('../ai/aiRecipeApi', () => ({
  fetchAiRecipes: vi.fn(),
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
  steps: ['Inforna l\'orata a 200 gradi.', 'Servi con contorno.'],
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

const tortaLimoneRecipe: GeneratedRecipe = {
  id: 'saved-torta-limone',
  source: 'ai',
  title: 'Torta al limone',
  description: 'Torta soffice al limone.',
  ingredients: [{ name: 'Limone', amount: '2' }, { name: 'Farina', amount: '250 g' }],
  steps: ['Mescola farina e uova con la scorza di limone.'],
  diets: [],
  allergens: [],
  createdAt: '2026-09-20T12:00:00.000Z',
  updatedAt: '2026-09-21T12:00:00.000Z',
};

const giudiaLibraryRecipe: GeneratedRecipe = {
  id: 'saved-giudia',
  source: 'ai',
  title: 'Carciofi alla giudìa',
  description: 'Carciofi fritti croccanti.',
  ingredients: [{ name: 'Carciofi', amount: '4' }, { name: 'Olio', amount: 'q.b.' }],
  steps: ['Fritta i carciofi finché non sono dorati.'],
  diets: [],
  allergens: [],
  createdAt: '2026-09-22T12:00:00.000Z',
  updatedAt: '2026-09-23T12:00:00.000Z',
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
  vi.mocked(hydrateDinnerDiaryStore).mockClear();
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  setActiveDataScope('guest');
});

describe('RecipesPage', () => {
  it('renderizza i due gruppi (AI e catalogo) per una sessione verificata', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([orataRecipe]);

    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Orata al forno' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Le tue ricette AI' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ricette suggerite' })).toBeInTheDocument();
    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getAllByText('Catalogo').length).toBeGreaterThan(0);
  });

  it('ordina le ricette AI per updatedAt discendente', async () => {
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

  it('filtra anche sui nomi degli ingredienti delle ricette AI', async () => {
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

  it('mostra lo stato di caricamento solo sul gruppo AI, catalogo consultabile', async () => {
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

  it('ospite: catalogo visibile, gruppo AI con CTA accesso e nessuna chiamata', async () => {
    renderPage();

    expect(screen.getByText('Pollo al limone')).toBeInTheDocument();
    expect(screen.getByText(/Ricette AI riservate agli account verificati/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Accedi al tuo account' })).toHaveAttribute('href', '/profile');
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
    expect(screen.getByRole('link', { name: 'Trova ricette' })).toHaveAttribute('href', '/pantry');
  });

  it('applica la ricerca live al gruppo AI per titolo e per ingrediente', async () => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([orataRecipe, curryRecipe]);

    renderPage();

    await waitFor(() => expect(screen.getByText('Orata al forno')).toBeInTheDocument());
    expect(screen.getByText('Pollo al curry')).toBeInTheDocument();

    const search = screen.getByLabelText('Cerca ricette');
    const userEvents = userEvent.setup();

    await userEvents.type(search, 'orata');
    await waitFor(() => expect(screen.queryByText('Pollo al curry')).not.toBeInTheDocument());
    expect(screen.getByText('Orata al forno')).toBeInTheDocument();

    await userEvents.clear(search);
    await userEvents.type(search, 'curry');
    await waitFor(() => expect(screen.queryByText('Orata al forno')).not.toBeInTheDocument());
    expect(screen.getByText('Pollo al curry')).toBeInTheDocument();
    expect(screen.queryByText(/Nessuna ricetta trovata/)).not.toBeInTheDocument();
  });

  // Filtro unificato: una sola query attraversa i due gruppi (AI, catalogo).
  const seedUnifiedGroups = async (): Promise<void> => {
    setVerifiedSession();
    vi.mocked(fetchAiRecipes).mockResolvedValue([limoneAiRecipe, giudiaAiRecipe, tortaLimoneRecipe, giudiaLibraryRecipe]);
  };

  it('filtra i due gruppi con una sola query e ripristina tutto con query vuota', async () => {
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

    // Una coincidenza per gruppo: AI e catalogo restano; le giudìa escono.
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
    expect(screen.getAllByText('AI').length).toBe(4);
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
    expect(screen.getByRole('link', { name: 'Trova ricette' })).toHaveAttribute('href', '/pantry');
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

    // Query senza accento su titolo accentato: coincide in AI, non nel catalogo.
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