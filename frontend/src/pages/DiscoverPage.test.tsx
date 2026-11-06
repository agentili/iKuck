import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary, GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import DiscoverPage from './DiscoverPage';
import { useAuthStore } from '../auth/authStore';
import { readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { setActiveDataScope } from '../sync/scopeContext';

vi.mock('../storage/dinnerDiaryStorage', () => ({
  readSavedRecipes: vi.fn(),
}));
vi.mock('../store/dinnerDiaryStore', () => ({
  hydrateDinnerDiaryStore: vi.fn(() => Promise.resolve()),
}));
vi.mock('../ai/aiRecipeApi', () => ({
  fetchAiRecipes: vi.fn(),
}));

const renderPage = () => render(
  <MemoryRouter initialEntries={['/discover']}>
    <DiscoverPage />
  </MemoryRouter>,
);

const verifiedUser: AccountSummary = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

const setVerifiedSession = (): void => {
  useAuthStore.setState({
    user: verifiedUser,
    csrfToken: 'csrf-token',
    expiresAt: '2026-10-20T10:00:00.000Z',
  });
  setActiveDataScope('account:user-1');
};

const makeDiaryRecipe = (overrides: Partial<SavedRecipe> = {}): SavedRecipe => ({
  id: 'diary-pesto',
  title: 'Pasta al pesto',
  description: 'Una pasta con basilico fresco.',
  ingredients: [{ name: 'Basilico', amount: 'un mazzo', ingredientId: null, optional: false, provenance: 'provided' }],
  steps: ['Pesta il basilico.'],
  servings: 2,
  durationMinutes: 20,
  diets: null,
  allergens: null,
  suggestedFields: [],
  source: 'diary',
  authorId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  ...overrides,
});

const addTags = <T extends object>(recipe: T, tags: string[]): T & { tags: string[] } => ({ ...recipe, tags });

const makeAiRecipe = (id: string, title: string, ingredient: string): GeneratedRecipe => ({
  id,
  source: 'ai',
  title,
  description: `${title} fatta in casa.`,
  ingredients: [{ name: ingredient, amount: '1' }],
  steps: ['Prepara e servi.'],
  diets: [],
  allergens: [],
  createdAt: '2026-10-03T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
});

beforeEach(() => {
  vi.mocked(readSavedRecipes).mockReset();
  vi.mocked(readSavedRecipes).mockResolvedValue([]);
  vi.mocked(fetchAiRecipes).mockReset();
  vi.mocked(fetchAiRecipes).mockResolvedValue([]);
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  setActiveDataScope('guest');
});

describe('DiscoverPage', () => {
  it('uses the shared semantic surfaces and visible focus treatment', async () => {
    renderPage();
    await waitFor(() => expect(screen.queryByText('Carico le ricette salvate…')).not.toBeInTheDocument());

    const main = screen.getByRole('main');
    const searchRegion = screen.getByRole('region', { name: 'Ricerca ricette' });
    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    const filters = screen.getByRole('group', { name: 'Filtri categoria' });
    const selectedFilter = within(filters).getByRole('button', { name: 'Tutte' });

    expect(main).toHaveClass('ik-discover-page', 'text-[var(--ik-ink)]');
    expect(searchRegion).toHaveClass('bg-[var(--ik-surface)]');
    expect(search).toHaveClass('ik-input', 'focus-visible:outline-[var(--ik-focus)]');
    expect(selectedFilter).toHaveClass('min-h-11', 'ik-button-primary', 'focus-visible:outline-[var(--ik-focus)]');
    expect(within(filters).getByRole('button', { name: 'Carne' })).toHaveClass('bg-[var(--ik-sage)]');
    expect(screen.getByRole('region', { name: 'Ricette salvate' })).toHaveClass('bg-[var(--ik-surface)]');
    expect(screen.getByRole('region', { name: 'Ricette AI' })).toHaveClass('bg-[var(--ik-surface)]');
    expect(screen.getByRole('region', { name: 'Tutte le ricette' })).toHaveClass('bg-[var(--ik-surface)]');
  });

  it('searches locally by title and ingredient across Diary, AI and catalog groups', async () => {
    setVerifiedSession();
    vi.mocked(readSavedRecipes).mockResolvedValue([makeDiaryRecipe({
      title: 'Lasagne al forno',
      ingredients: [{ name: 'Besciamella', amount: '500 ml', ingredientId: null, optional: false, provenance: 'provided' }],
    })]);
    vi.mocked(fetchAiRecipes).mockResolvedValue([makeAiRecipe('ai-salsa-limone', 'Salsa al limone', 'Limone')]);
    const user = userEvent.setup();

    renderPage();
    expect(await screen.findByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Salsa al limone' })).toBeInTheDocument();

    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    await user.type(search, 'lasagne');
    expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Salsa al limone' })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'besciamella');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Lasagne al forno' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Salsa al limone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pollo al limone' })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'limone');
    expect(await screen.findByRole('heading', { name: 'Salsa al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Lasagne al forno' })).not.toBeInTheDocument();
    expect(fetchAiRecipes).toHaveBeenCalledTimes(1);
    expect(readSavedRecipes).toHaveBeenCalledTimes(1);
  });

  it('activates recipe filters by keyboard and pointer without changing their tag semantics', async () => {
    setVerifiedSession();
    vi.mocked(readSavedRecipes).mockResolvedValue([
      addTags(makeDiaryRecipe({ id: 'diary-fast', title: 'Pasta rapida' }), ['Veloce']),
      addTags(makeDiaryRecipe({ id: 'diary-meat', title: 'Polpette di casa' }), ['Carne']),
    ]);
    vi.mocked(fetchAiRecipes).mockResolvedValue([
      addTags(makeAiRecipe('ai-fast', 'Ceci veloci', 'Ceci'), ['Veloce']),
    ]);
    const user = userEvent.setup();

    renderPage();
    expect(await screen.findByRole('heading', { name: 'Pasta rapida' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Polpette di casa' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceci veloci' })).toBeInTheDocument();

    const allFilter = screen.getByRole('button', { name: 'Tutte' });
    const quickFilter = screen.getByRole('button', { name: '< 20 min' });
    await user.tab();
    expect(screen.getByRole('searchbox', { name: 'Cerca ricette' })).toHaveFocus();
    await user.tab();
    expect(allFilter).toHaveFocus();
    await user.tab();
    expect(quickFilter).toHaveFocus();
    await user.keyboard(' ');

    expect(quickFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Pasta rapida' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceci veloci' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Polpette di casa' })).not.toBeInTheDocument();

    const meatFilter = screen.getByRole('button', { name: 'Carne' });
    await user.click(meatFilter);
    expect(meatFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Polpette di casa' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pasta rapida' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ceci veloci' })).not.toBeInTheDocument();

    await user.click(allFilter);
    expect(allFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Pasta rapida' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Polpette di casa' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceci veloci' })).toBeInTheDocument();
  });

  it('filters pantry catalog records by category and normalized tags', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Pollo al limone' });

    const fishFilter = screen.getByRole('button', { name: 'Pesce' });
    await user.click(fishFilter);
    expect(fishFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Pasta tonno e pomodoro' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pollo al limone' })).not.toBeInTheDocument();

    const quickFilter = screen.getByRole('button', { name: '< 20 min' });
    await user.click(quickFilter);
    expect(quickFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
  });

  it('clears a no-match search instead of linking back to the same route', async () => {
    const user = userEvent.setup();
    renderPage();

    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    await user.type(search, 'ricetta-che-non-esiste');
    expect(await screen.findByText(/Nessuna ricetta trovata per/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pollo al limone' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pulisci la ricerca' }));
    expect(search).toHaveValue('');
    expect(await screen.findByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.queryByText(/Nessuna ricetta trovata per/)).not.toBeInTheDocument();

    await user.type(search, 'limone');
    const clearButton = screen.getByRole('button', { name: 'Pulisci ricerca' });
    expect(clearButton).toHaveClass('min-h-11', 'min-w-11');
    await user.click(clearButton);
    expect(search).toHaveValue('');
  });

  it('keeps guest discovery local and does not request account AI recipes', async () => {
    vi.mocked(readSavedRecipes).mockResolvedValue([makeDiaryRecipe({ title: 'Minestra locale' })]);

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Minestra locale' })).toBeInTheDocument();
    expect(screen.getByText(/Ambito: dati locali/)).toBeInTheDocument();
    expect(screen.getByText(/Ricette AI riservate agli account verificati/)).toBeInTheDocument();
    expect(readSavedRecipes).toHaveBeenCalledWith('guest');
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('loads account Diary and AI recipes without mixing the guest scope', async () => {
    setVerifiedSession();
    const accountRecipe = makeDiaryRecipe({ id: 'account-recipe', title: 'Risotto personale' });
    const guestRecipe = makeDiaryRecipe({ id: 'guest-recipe', title: 'Zuppa locale' });
    vi.mocked(readSavedRecipes).mockImplementation((scope) => Promise.resolve(
      scope === 'account:user-1' ? [accountRecipe] : [guestRecipe],
    ));
    vi.mocked(fetchAiRecipes).mockResolvedValue([makeAiRecipe('account-ai', 'Ceci speziati', 'Ceci')]);

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Risotto personale' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Ceci speziati' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Zuppa locale' })).not.toBeInTheDocument();
    expect(screen.getByText(/Ambito: personale/)).toBeInTheDocument();
    expect(readSavedRecipes).toHaveBeenCalledTimes(1);
    expect(readSavedRecipes).toHaveBeenCalledWith('account:user-1');
    expect(fetchAiRecipes).toHaveBeenCalledTimes(1);
  });

  it('ignores a pending local read after the active data scope changes', async () => {
    let resolveGuestRead: ((recipes: SavedRecipe[]) => void) | undefined;
    const guestRead = new Promise<SavedRecipe[]>((resolve) => { resolveGuestRead = resolve; });
    vi.mocked(readSavedRecipes).mockImplementation((scope) => scope === 'guest'
      ? guestRead
      : Promise.resolve([makeDiaryRecipe({ id: 'house-recipe', title: 'Ricetta di casa' })]));

    renderPage();
    await waitFor(() => expect(readSavedRecipes).toHaveBeenCalledWith('guest'));
    setActiveDataScope('house:house-1');

    expect(await screen.findByRole('heading', { name: 'Ricetta di casa' })).toBeInTheDocument();
    await act(async () => {
      resolveGuestRead?.([makeDiaryRecipe({ id: 'stale-guest-recipe', title: 'Ricetta locale obsoleta' })]);
      await guestRead;
    });
    expect(screen.queryByRole('heading', { name: 'Ricetta locale obsoleta' })).not.toBeInTheDocument();
    expect(readSavedRecipes).toHaveBeenCalledWith('house:house-1');
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('does not announce an empty search or filter while their sources are loading', async () => {
    setVerifiedSession();
    let resolveDiaryRead: ((recipes: SavedRecipe[]) => void) | undefined;
    let resolveAiRead: ((recipes: GeneratedRecipe[]) => void) | undefined;
    const diaryRead = new Promise<SavedRecipe[]>((resolve) => { resolveDiaryRead = resolve; });
    const aiRead = new Promise<GeneratedRecipe[]>((resolve) => { resolveAiRead = resolve; });
    vi.mocked(readSavedRecipes).mockReturnValue(diaryRead);
    vi.mocked(fetchAiRecipes).mockReturnValue(aiRead);
    const user = userEvent.setup();

    renderPage();
    expect(screen.getByText('Carico le ricette salvate…')).toBeInTheDocument();
    expect(screen.getByText('Carico le ricette AI…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();

    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    await user.type(search, 'nessuna-ricetta-corrisponde');
    expect(screen.queryByRole('button', { name: 'Pulisci la ricerca' })).not.toBeInTheDocument();
    await user.clear(search);
    await user.click(screen.getByRole('button', { name: 'Forno' }));
    expect(screen.queryByText('Nessuna ricetta corrisponde al filtro selezionato.')).not.toBeInTheDocument();

    await act(async () => {
      resolveDiaryRead?.([]);
      resolveAiRead?.([]);
      await Promise.all([diaryRead, aiRead]);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Nessuna ricetta corrisponde al filtro selezionato.');
  });

  it('keeps the local catalog available and avoids a global no-result claim after source errors', async () => {
    setVerifiedSession();
    vi.mocked(readSavedRecipes).mockRejectedValue(new Error('storage unavailable'));
    vi.mocked(fetchAiRecipes).mockRejectedValue(new Error('network unavailable'));
    const user = userEvent.setup();

    renderPage();

    expect(await screen.findByText('Non è stato possibile caricare le ricette salvate. Riprova.')).toBeInTheDocument();
    expect(await screen.findByText('Servizio non raggiungibile: le ricette AI restano disponibili solo online.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Cerca ricette' }), 'nessuna-ricetta-corrisponde');
    expect(screen.queryByRole('button', { name: 'Pulisci la ricerca' })).not.toBeInTheDocument();
  });

  it('offers a reset when a selected category has no results', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Pollo al limone' });

    await user.click(screen.getByRole('button', { name: 'Forno' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Nessuna ricetta corrisponde al filtro selezionato.');
    await user.click(screen.getByRole('button', { name: 'Mostra tutte' }));

    expect(screen.getByRole('button', { name: 'Tutte' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.queryByText('Nessuna ricetta corrisponde al filtro selezionato.')).not.toBeInTheDocument();
  });
});
