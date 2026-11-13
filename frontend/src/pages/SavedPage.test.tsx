import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary, GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import SavedPage from './SavedPage';
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

const renderSavedRoute = () => render(
  <MemoryRouter initialEntries={['/saved']}>
    <Routes>
      <Route path="/saved" element={<SavedPage />} />
    </Routes>
  </MemoryRouter>,
);

const verifiedUser: AccountSummary = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

const setVerifiedSession = (scope: Parameters<typeof setActiveDataScope>[0] = 'account:user-1', csrfToken: string | null = 'csrf-token'): void => {
  useAuthStore.setState({
    user: verifiedUser,
    csrfToken,
    expiresAt: '2026-10-20T10:00:00.000Z',
  });
  setActiveDataScope(scope);
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

const makeAiRecipe = (id: string, title: string, ingredient: string, updatedAt = '2026-10-04T10:00:00.000Z'): GeneratedRecipe => ({
  id,
  source: 'ai',
  title,
  description: `${title} fatta in casa.`,
  ingredients: [{ name: ingredient, amount: '1' }],
  steps: ['Prepara e servi.'],
  diets: [],
  allergens: [],
  createdAt: '2026-10-03T10:00:00.000Z',
  updatedAt,
});

const addTags = <T extends object>(recipe: T, tags: string[]): T & { tags: string[] } => ({ ...recipe, tags });

beforeEach(() => {
  vi.mocked(readSavedRecipes).mockReset();
  vi.mocked(readSavedRecipes).mockResolvedValue([]);
  vi.mocked(fetchAiRecipes).mockReset();
  vi.mocked(fetchAiRecipes).mockResolvedValue([]);
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null });
  setActiveDataScope('guest');
});

describe('SavedPage', () => {
  it('renders the direct route with semantic surfaces and visible keyboard focus', async () => {
    renderSavedRoute();

    expect(screen.getByRole('heading', { level: 1, name: 'Le tue ricette' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    const searchRegion = screen.getByRole('region', { name: 'Ricerca ricette salvate' });
    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    const filters = screen.getByRole('group', { name: 'Filtri categoria' });
    const allFilter = within(filters).getByRole('button', { name: 'Tutte' });

    expect(main).toHaveClass('ik-saved-page', 'text-[var(--ik-ink)]');
    expect(searchRegion).toHaveClass('bg-[var(--ik-surface)]');
    expect(search).toHaveClass('ik-input', 'focus-visible:outline-[var(--ik-focus)]');
    expect(allFilter).toHaveClass('min-h-11', 'ik-button-primary', 'focus-visible:outline-[var(--ik-focus)]');
    expect(screen.getByRole('region', { name: 'Ricette' })).toBeInTheDocument();
    expect(await screen.findByText('Nessuna ricetta salvata ancora.')).toBeInTheDocument();
  });

  it('keeps guest Diary recipes local and blocks AI reads until verification', async () => {
    vi.mocked(readSavedRecipes).mockResolvedValue([makeDiaryRecipe()]);

    renderSavedRoute();

    expect(await screen.findByRole('heading', { name: 'Pasta al pesto' })).toBeInTheDocument();
    expect(screen.getByText('Ambito: dati locali')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ricette AI riservate agli account verificati' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apri Pasta al pesto' })).toHaveAttribute(
      'href',
      '/recipes/diary-pesto?scope=guest',
    );
    expect(readSavedRecipes).toHaveBeenCalledWith('guest');
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('loads the verified account scope, unifies Diary and AI recipes, sorts and expands details', async () => {
    setVerifiedSession();
    const diaryOlder = makeDiaryRecipe({ id: 'diary-older', title: 'Pasta al pesto', updatedAt: '2026-10-02T10:00:00.000Z' });
    const diaryNewer = makeDiaryRecipe({ id: 'diary-newer', title: 'Risotto alle erbe', updatedAt: '2026-10-05T10:00:00.000Z' });
    vi.mocked(readSavedRecipes).mockResolvedValue([diaryOlder, diaryNewer]);
    vi.mocked(fetchAiRecipes).mockResolvedValue([
      makeAiRecipe('ai-older', 'Crema di ceci', 'Ceci', '2026-10-03T10:00:00.000Z'),
      makeAiRecipe('ai-newer', 'Verdure speziate', 'Zucchine', '2026-10-06T10:00:00.000Z'),
    ]);
    const user = userEvent.setup();

    renderSavedRoute();

    const diaryRegion = screen.getByRole('region', { name: 'Ricette' });
    const aiRegion = screen.getByRole('region', { name: 'Ricette' });
    await within(diaryRegion).findByRole('heading', { name: 'Risotto alle erbe' });
    await within(aiRegion).findByRole('heading', { name: 'Verdure speziate' });

    expect(within(diaryRegion).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual(['Risotto alle erbe', 'Pasta al pesto', 'Verdure speziate', 'Crema di ceci']);
    expect(screen.getByText('Ambito: personale')).toBeInTheDocument();
    expect(readSavedRecipes).toHaveBeenCalledWith('account:user-1');
    expect(fetchAiRecipes).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Apri Risotto alle erbe' })).toHaveAttribute(
      'href',
      '/recipes/diary-newer?scope=account%3Auser-1',
    );

    await user.click(within(diaryRegion).getAllByRole('button', { name: 'Mostra dettagli' })[0]);
    expect(within(diaryRegion).getByRole('button', { name: 'Nascondi dettagli' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(diaryRegion).getByText('Basilico')).toBeInTheDocument();
    expect(within(diaryRegion).getByText('un mazzo')).toBeInTheDocument();
    expect(within(diaryRegion).getByText('Pesta il basilico.')).toBeInTheDocument();

    const aiTargetCard = screen.getByRole('heading', { name: 'Crema di ceci' }).closest('article');
    expect(aiTargetCard).not.toBeNull();
    await user.click(within(aiTargetCard as HTMLElement).getByRole('button', { name: 'Mostra dettagli' }));
    expect(within(aiRegion).getByText('Ceci')).toBeInTheDocument();
    expect(within(aiRegion).getByText('Prepara e servi.')).toBeInTheDocument();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Crea|Modifica|Elimina|Salva)/i })).not.toBeInTheDocument();
  });

  it('uses only the active house scope for local recipes', async () => {
    const guestRecipe = makeDiaryRecipe({ id: 'guest-recipe', title: 'Zuppa locale' });
    const houseRecipe = makeDiaryRecipe({ id: 'house-recipe', title: 'Minestra di casa' });
    setVerifiedSession('house:house-1');
    vi.mocked(readSavedRecipes).mockImplementation((scope) => Promise.resolve(
      scope === 'house:house-1' ? [houseRecipe] : [guestRecipe],
    ));

    renderSavedRoute();

    expect(await screen.findByRole('heading', { name: 'Minestra di casa' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Zuppa locale' })).not.toBeInTheDocument();
    expect(readSavedRecipes).toHaveBeenCalledTimes(1);
    expect(readSavedRecipes).toHaveBeenCalledWith('house:house-1');
    expect(screen.getByRole('link', { name: 'Apri Minestra di casa' })).toHaveAttribute(
      'href',
      '/recipes/house-recipe?scope=house%3Ahouse-1',
    );
  });

  it('does not fetch AI recipes for an account without a CSRF token', async () => {
    setVerifiedSession('account:user-1', null);
    vi.mocked(readSavedRecipes).mockResolvedValue([makeDiaryRecipe()]);

    renderSavedRoute();

    expect(await screen.findByRole('heading', { name: 'Pasta al pesto' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ricette AI riservate agli account verificati' })).not.toBeInTheDocument();
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('searches both source groups and filters recipes by their existing tags', async () => {
    setVerifiedSession();
    vi.mocked(readSavedRecipes).mockResolvedValue([
      addTags(makeDiaryRecipe({ id: 'diary-fast', title: 'Pasta rapida', ingredients: [
        { name: 'Basilico', amount: 'un mazzo', ingredientId: null, optional: false, provenance: 'provided' },
      ] }), ['Veloce']),
      addTags(makeDiaryRecipe({ id: 'diary-soup', title: 'Zuppa di ceci', ingredients: [
        { name: 'Ceci', amount: '200 g', ingredientId: null, optional: false, provenance: 'provided' },
      ] }), ['Vegetariano']),
    ]);
    vi.mocked(fetchAiRecipes).mockResolvedValue([
      addTags(makeAiRecipe('ai-fast', 'Ceci veloci', 'Ceci'), ['Veloce']),
      addTags(makeAiRecipe('ai-baked', 'Torta di mele', 'Mele'), ['Forno']),
    ]);
    const user = userEvent.setup();

    renderSavedRoute();
    expect(await screen.findByRole('heading', { name: 'Pasta rapida' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Zuppa di ceci' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceci veloci' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Torta di mele' })).toBeInTheDocument();

    const quickFilter = screen.getByRole('button', { name: '< 20 min' });
    await user.tab();
    expect(screen.getByRole('searchbox', { name: 'Cerca ricette' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Tutte' })).toHaveFocus();
    await user.tab();
    expect(quickFilter).toHaveFocus();
    await user.keyboard(' ');

    expect(quickFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Pasta rapida' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceci veloci' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Zuppa di ceci' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Torta di mele' })).not.toBeInTheDocument();

    const search = screen.getByRole('searchbox', { name: 'Cerca ricette' });
    await user.type(search, 'basilico');
    expect(screen.getByRole('heading', { name: 'Pasta rapida' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ceci veloci' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pulisci ricerca' }));
    expect(search).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'Ceci veloci' })).toBeInTheDocument();

    await user.type(search, 'ricetta-inesistente');
    expect(await screen.findByText('Nessuna ricetta corrisponde alla ricerca.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pulisci la ricerca' }));
    expect(search).toHaveValue('');
  });

  it('keeps both sources in loading state without claiming empty results', async () => {
    setVerifiedSession();
    let resolveDiary: ((recipes: SavedRecipe[]) => void) | undefined;
    let resolveAi: ((recipes: GeneratedRecipe[]) => void) | undefined;
    const diaryRead = new Promise<SavedRecipe[]>((resolve) => { resolveDiary = resolve; });
    const aiRead = new Promise<GeneratedRecipe[]>((resolve) => { resolveAi = resolve; });
    vi.mocked(readSavedRecipes).mockReturnValue(diaryRead);
    vi.mocked(fetchAiRecipes).mockReturnValue(aiRead);

    renderSavedRoute();

    expect(await screen.findByText('Carico le ricette salvate…')).toBeInTheDocument();
    expect(screen.getByText('Carico le ricette AI…')).toBeInTheDocument();
    expect(screen.queryByText('Nessuna ricetta salvata nel diario.')).not.toBeInTheDocument();
    expect(screen.queryByText('Nessuna ricetta AI salvata ancora.')).not.toBeInTheDocument();

    await act(async () => {
      resolveDiary?.([]);
      resolveAi?.([]);
      await Promise.all([diaryRead, aiRead]);
    });
    expect(await screen.findByText('Nessuna ricetta salvata ancora.')).toBeInTheDocument();
    expect(screen.queryByText('Nessuna ricetta AI salvata ancora.')).not.toBeInTheDocument();
  });

  it('shows source errors without presenting unavailable data as empty', async () => {
    setVerifiedSession();
    vi.mocked(readSavedRecipes).mockRejectedValue(new Error('storage unavailable'));
    vi.mocked(fetchAiRecipes).mockRejectedValue(new Error('network unavailable'));

    renderSavedRoute();

    expect(await screen.findByText('Non è stato possibile caricare le ricette salvate. Riprova.')).toBeInTheDocument();
    expect(await screen.findByText('Errore nel caricamento')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.queryByText('Nessuna ricetta salvata nel diario.')).not.toBeInTheDocument();
    expect(screen.queryByText('Nessuna ricetta AI salvata ancora.')).not.toBeInTheDocument();
  });

  it('ignores a stale local read after the active scope changes', async () => {
    let resolveGuestRead: ((recipes: SavedRecipe[]) => void) | undefined;
    const guestRead = new Promise<SavedRecipe[]>((resolve) => { resolveGuestRead = resolve; });
    vi.mocked(readSavedRecipes).mockImplementation((scope) => scope === 'guest'
      ? guestRead
      : Promise.resolve([makeDiaryRecipe({ id: 'account-recipe', title: 'Ricetta personale' })]));

    renderSavedRoute();
    await waitFor(() => expect(readSavedRecipes).toHaveBeenCalledWith('guest'));
    setVerifiedSession();

    expect(await screen.findByRole('heading', { name: 'Ricetta personale' })).toBeInTheDocument();
    await act(async () => {
      resolveGuestRead?.([makeDiaryRecipe({ id: 'stale-guest', title: 'Ricetta locale obsoleta' })]);
      await guestRead;
    });
    expect(screen.queryByRole('heading', { name: 'Ricetta locale obsoleta' })).not.toBeInTheDocument();
    expect(readSavedRecipes).toHaveBeenCalledWith('account:user-1');
  });
});
