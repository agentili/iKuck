import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccountSummary, DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { ApiClientError } from '../../api/apiClient';
import AiRecipePanel from './AiRecipePanel';
import { useAuthStore } from '../../auth/authStore';
import { useDinnerDiaryStore } from '../../store/dinnerDiaryStore';
import { getActiveDataScope, setActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';
import type { SyncScope } from '../../sync/scopeContext';
import { clearAiRecipeProposalHistory } from '../../ai/aiRecipeHistory';
import AiConsentSettings from './AiConsentSettings';
import {
  deleteAiRecipe,
  fetchAiConsent,
  fetchAiConsentStatus,
  fetchAiRecipes,
  generateAiRecipe,
  saveAiRecipe,
  updateAiConsent,
  updateDinnerAiConsent,
} from '../../ai/aiRecipeApi';

vi.mock('../../ai/aiRecipeApi', () => ({
  deleteAiRecipe: vi.fn(),
  fetchAiConsent: vi.fn(),
  fetchAiConsentStatus: vi.fn(),
  fetchAiRecipes: vi.fn(),
  generateAiRecipe: vi.fn(),
  saveAiRecipe: vi.fn(),
  updateAiConsent: vi.fn(),
  updateDinnerAiConsent: vi.fn(),
}));

const profile: DietProfilePayload = {
  diet: 'vegan',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

const user: AccountSummary = {
  id: 'user-1',
  email: 'user@example.com',
  emailVerifiedAt: '2026-09-13T12:00:00.000Z',
};

const recipe: GeneratedRecipe = {
  id: 'recipe-1',
  source: 'ai',
  title: 'Ceci croccanti',
  description: 'Una ricetta semplice.',
  ingredients: [{ name: 'Ceci', amount: '240 g' }],
  steps: ['Scola i ceci.', 'Rosolali in padella.'],
  diets: ['vegan'],
  allergens: [],
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-13T12:00:00.000Z',
};

const renderPanel = (overrides: Partial<React.ComponentProps<typeof AiRecipePanel>> = {}) => render(
  <AiRecipePanel
    ingredients={['Ceci', 'Pomodoro']}
    dietProfile={profile}
    user={user}
    csrfToken="csrf-token"
    {...overrides}
  />,
);

const panelCommitSnapshots: Array<{
  userId: string | null;
  verified: boolean;
  csrfToken: string | null;
  scope: SyncScope;
  bodyText: string;
}> = [];

function PanelCommitProbe({
  userId,
  verified,
  csrfToken,
  scope,
}: {
  userId: string | null;
  verified: boolean;
  csrfToken: string | null;
  scope: SyncScope;
}) {
  useLayoutEffect(() => {
    panelCommitSnapshots.push({
      userId,
      verified,
      csrfToken,
      scope,
      bodyText: document.body.textContent ?? '',
    });
  }, [userId, verified, csrfToken, scope]);

  return null;
}

function HomeLikeUnkeyedPanel() {
  const currentUser = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const activeScope = useSyncExternalStore(
    (listener: () => void) => subscribeActiveDataScope(listener),
    getActiveDataScope,
    getActiveDataScope,
  );
  const verified = currentUser !== null && currentUser.emailVerifiedAt.trim().length > 0 && csrfToken !== null;

  return (
    <>
      <AiRecipePanel
        ingredients={activeScope.startsWith('house:') ? ['Riso', 'Zafferano'] : ['Ceci', 'Pomodoro']}
        dietProfile={profile}
        user={currentUser}
        csrfToken={csrfToken}
      />
      <PanelCommitProbe
        userId={currentUser?.id ?? null}
        verified={verified}
        csrfToken={csrfToken}
        scope={activeScope}
      />
    </>
  );
}

const renderHomeLikePanel = () => render(<HomeLikeUnkeyedPanel />);

const expectGenerationEnabled = async (panel: HTMLElement): Promise<void> => {
  const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });
  await waitFor(() => expect(generateButton).toBeEnabled());
};

describe('AiRecipePanel', () => {
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
      transition: 'the active data scope changes in Home’s unkeyed panel',
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
      useAuthStore.setState({ user, csrfToken: 'csrf-token' });
      setActiveDataScope('account:user-1');
      vi.mocked(fetchAiConsentStatus)
        .mockResolvedValueOnce({
          consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
          selectedProvider: 'openai',
        })
        .mockImplementation(() => new Promise(() => {}));
      vi.mocked(fetchAiRecipes)
        .mockResolvedValueOnce([recipe])
        .mockImplementation(() => new Promise<GeneratedRecipe[]>(() => {}));

      renderHomeLikePanel();
      expect(await screen.findByRole('heading', { name: recipe.title })).toBeVisible();

      const snapshotCount = panelCommitSnapshots.length;
      act(() => {
        useAuthStore.setState({ user: nextUser, csrfToken: nextCsrfToken });
        setActiveDataScope(nextScope);
      });

      const committedRender = panelCommitSnapshots.slice(snapshotCount).at(-1);
      expect(committedRender).toBeDefined();
      expect(committedRender).toMatchObject({
        userId: nextUser?.id ?? null,
        verified: nextUser !== null && nextUser.emailVerifiedAt.trim().length > 0 && nextCsrfToken !== null,
        csrfToken: nextCsrfToken,
        scope: nextScope,
      });
      expect(committedRender?.bodyText).not.toContain(recipe.title);
    },
  );

  it('ignores an account response started before Home switches scope and displays the current house response', async () => {
    const accountRecipe = { ...recipe, id: 'account-recipe', title: 'Ricetta account precedente' };
    const staleResponseRecipe = { ...recipe, id: 'stale-recipe', title: 'Ricetta della sessione obsoleta' };
    const houseRecipe = { ...recipe, id: 'house-recipe', title: 'Ricetta della casa corrente' };
    let resolveStaleResponse!: (recipes: GeneratedRecipe[]) => void;
    const staleResponse = new Promise<GeneratedRecipe[]>((resolve) => { resolveStaleResponse = resolve; });
    useAuthStore.setState({ user, csrfToken: 'csrf-token' });
    setActiveDataScope('account:user-1');
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'openai',
    });
    vi.mocked(fetchAiRecipes)
      .mockResolvedValueOnce([accountRecipe])
      .mockReturnValueOnce(staleResponse)
      .mockResolvedValueOnce([houseRecipe]);

    renderHomeLikePanel();
    expect(await screen.findByRole('heading', { name: accountRecipe.title })).toBeVisible();

    act(() => useAuthStore.setState({ user, csrfToken: 'rotated-csrf-token' }));
    await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledTimes(2));
    act(() => setActiveDataScope('house:house-1'));

    await act(async () => { resolveStaleResponse([staleResponseRecipe]); });
    expect(screen.queryByRole('heading', { name: staleResponseRecipe.title })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchAiRecipes).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole('heading', { name: houseRecipe.title })).toBeVisible();
    expect(screen.queryByRole('heading', { name: accountRecipe.title })).not.toBeInTheDocument();
  });

  beforeEach(() => {
    panelCommitSnapshots.length = 0;
    localStorage.clear();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
      } as unknown as LockManager,
    });
    vi.mocked(fetchAiConsent).mockReset();
    vi.mocked(fetchAiConsentStatus).mockReset();
    vi.mocked(fetchAiRecipes).mockReset();
    vi.mocked(updateAiConsent).mockReset();
    vi.mocked(updateDinnerAiConsent).mockReset();
    vi.mocked(generateAiRecipe).mockReset();
    vi.mocked(saveAiRecipe).mockReset();
    vi.mocked(deleteAiRecipe).mockReset();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(fetchAiConsentStatus).mockImplementation(async () => ({
      consent: await vi.mocked(fetchAiConsent)(),
      selectedProvider: 'openai',
    }));
    vi.mocked(fetchAiRecipes).mockResolvedValue([]);
    useAuthStore.setState({ user: null, csrfToken: null });
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [], recipes: [], drafts: [], error: null });
    setActiveDataScope('guest');
  });

  it('generates from a dish description and portions without pantry ingredients', async () => {
    const events = userEvent.setup();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    const onRecipeProposed = vi.fn();
    const constraints = ['Prepara ingredienti e dosi per 4 porzioni.'];
    renderPanel({ ingredients: [], dishDescription: '  Un risotto cremoso al limone  ', constraints, onRecipeProposed });
    const generate = await screen.findByRole('button', { name: 'Genera ricetta AI' });
    await waitFor(() => expect(generate).toBeEnabled());
    await events.click(generate);
    await waitFor(() => expect(onRecipeProposed).toHaveBeenCalledWith(recipe));
    expect(generateAiRecipe).toHaveBeenCalledWith({ dishDescription: 'Un risotto cremoso al limone', ingredients: [], constraints, existingRecipes: [] }, profile, 'csrf-token');
    expect(saveAiRecipe).not.toHaveBeenCalled();
  });

  it('generates from a title without pantry ingredients and saves only on request', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    vi.mocked(saveAiRecipe).mockResolvedValue(recipe);
    const onRecipeSaved = vi.fn();
    const userEvents = userEvent.setup();
    renderPanel({ generationMode: 'title', ingredients: [], onRecipeSaved });
    const generate = await screen.findByRole('button', { name: 'Genera ricetta AI' });
    await waitFor(() => expect(screen.getByLabelText('Titolo del piatto')).not.toBeDisabled());
    expect(generate).toBeDisabled();
    await userEvents.type(screen.getByLabelText('Titolo del piatto'), '  Ceci croccanti  ');
    await waitFor(() => expect(generate).toBeEnabled());
    await userEvents.click(generate);
    expect(generateAiRecipe).toHaveBeenCalledWith({ dishTitle: 'Ceci croccanti', ingredients: [], constraints: [], existingRecipes: [] }, profile, 'csrf-token');
    expect(await screen.findByRole('heading', { name: recipe.title })).toBeVisible();
    expect(saveAiRecipe).not.toHaveBeenCalled();
    expect(onRecipeSaved).not.toHaveBeenCalled();
    await userEvents.click(screen.getByRole('button', { name: 'Salva ricetta' }));
    await waitFor(() => expect(onRecipeSaved).toHaveBeenCalledWith(recipe));
    expect(screen.queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();
  });

  it.each([
    { enabled: false },
    { enabled: true, homeProvider: 'gemini' as const },
  ])('reports title generation unavailable without showing consent UI (%j)', async (consent) => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { ...consent, updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    renderPanel({ generationMode: 'title', ingredients: [] });
    const panel = await screen.findByRole('region', { name: 'Ricette AI private' });
    await userEvent.type(within(panel).getByLabelText('Titolo del piatto'), 'Risotto ai funghi');
    expect(within(panel).getByRole('button', { name: 'Genera ricetta AI' })).toBeDisabled();
    expect(await within(panel).findByText('La generazione di ricette AI non è disponibile per questo account.')).toBeVisible();
    expect(panel).not.toHaveTextContent(/consenso|autorizza|i dati che possono essere inviati/i);
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
    expect(generateAiRecipe).not.toHaveBeenCalled();
  });

  it('keeps title generation disabled if the service status cannot be verified', async () => {
    vi.mocked(fetchAiConsentStatus).mockRejectedValue({ code: 'ai_consent_status_invalid' });
    renderPanel({ generationMode: 'title', ingredients: [] });
    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.type(within(panel).getByLabelText('Titolo del piatto'), 'Risotto ai funghi');
    expect(await within(panel).findByRole('alert')).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Genera ricetta AI' })).toBeDisabled();
    expect(panel).not.toHaveTextContent(/consenso|autorizza/i);
    expect(generateAiRecipe).not.toHaveBeenCalled();
  });

  it('keeps the verified-account requirement without consent links in guest title mode', () => {
    renderPanel({ generationMode: 'title', user: null, csrfToken: null });
    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(panel).toHaveTextContent(/accedi con un account verificato/i);
    expect(panel).not.toHaveTextContent(/consenso/i);
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
    expect(fetchAiConsentStatus).not.toHaveBeenCalled();
  });

  it('does not generate from a title until consent and diet hydration are ready', async () => {
    const userEvents = userEvent.setup();
    const view = renderPanel({ generationMode: 'title', ingredients: [], generationReady: false });
    await userEvents.type(screen.getByLabelText('Titolo del piatto'), 'Risotto ai funghi');
    expect(screen.getByRole('button', { name: 'Genera ricetta AI' })).toBeDisabled();
    expect(generateAiRecipe).not.toHaveBeenCalled();
    view.unmount();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    renderPanel({ generationMode: 'title', ingredients: [], generationReady: false });
    await userEvents.type(screen.getByLabelText('Titolo del piatto'), 'Risotto ai funghi');
    expect(screen.getByRole('button', { name: 'Genera ricetta AI' })).toBeDisabled();
  });

  it('does not show controls or make requests for a guest', () => {
    renderPanel({ user: null, csrfToken: null });

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(within(panel).getByText(/ospiti e account non verificati/i)).toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(fetchAiConsent).not.toHaveBeenCalled();
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('links Home generation to Profile consent settings without inline consent mutation controls', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'openai',
    });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const settingsLink = await within(panel).findByRole('link', { name: /gestisci il consenso AI nel profilo/i });
    expect(settingsLink).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /salva consenso/i })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /revoca consenso/i })).not.toBeInTheDocument();
    expect(updateAiConsent).not.toHaveBeenCalled();
  });

  it('keeps server-approved generation available and links consent management to Profile', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'gemini',
    });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });
    expect(generateButton).toBeVisible();
    expect(within(panel).getByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /revoca consenso/i })).not.toBeInTheDocument();
    expect(updateAiConsent).not.toHaveBeenCalled();

    await userEvent.click(generateButton);
    expect(await within(panel).findByRole('heading', { name: recipe.title })).toBeVisible();
  });

  it('reacts to Profile revocation without restoring the private generation controls', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'gemini',
    });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(panel).findByRole('heading', { name: recipe.title });
    await clearAiRecipeProposalHistory(user.id);

    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument());
    expect(within(panel).getByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /revoca consenso/i })).not.toBeInTheDocument();
    expect(updateAiConsent).not.toHaveBeenCalled();
  });

  it('generates only under server approval and keeps the recipe as an unsaved preview', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'openai',
    });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });
    await userEvents.click(generateButton);
    expect(generateAiRecipe).toHaveBeenCalledWith(
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
    expect(await within(panel).findByRole('heading', { name: 'Ceci croccanti' })).toBeInTheDocument();
    expect(within(panel).getByText(/non ancora salvata/i)).toBeInTheDocument();
    expect(saveAiRecipe).not.toHaveBeenCalled();
    expect(updateAiConsent).not.toHaveBeenCalled();
    expect(within(panel).queryByRole('button', { name: `Elimina ${recipe.title}` })).not.toBeInTheDocument();
  });

  it('links consent revisions to Profile rather than retrying a stale Home grant', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    renderPanel();
    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(updateAiConsent).not.toHaveBeenCalled();
  });

  it('stores the preview in the account only after the explicit save', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    vi.mocked(saveAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await expectGenerationEnabled(panel);
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));

    await userEvents.click(await within(panel).findByRole('button', { name: 'Salva ricetta' }));

    expect(saveAiRecipe).toHaveBeenCalledWith(recipe, 'csrf-token');
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Salva ricetta' })).not.toBeInTheDocument());
    expect(within(panel).queryByText(/non ancora salvata/i)).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: `Elimina ${recipe.title}` })).toBeInTheDocument();
  });

  it('keeps proposal history across a panel reload on the same account', async () => {
    const userEvents = userEvent.setup();
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci e melanzane speziati' };
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValueOnce(recipe).mockResolvedValueOnce(second);

    const firstRender = renderPanel();
    const firstPanel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(firstPanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(firstPanel).findByRole('heading', { name: recipe.title });
    firstRender.unmount();

    const secondRender = renderPanel();
    const secondPanel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(secondPanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(secondPanel).findByRole('heading', { name: second.title });

    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [{ title: recipe.title, ingredients: recipe.ingredients }] },
      profile,
      'csrf-token',
    );
    secondRender.unmount();
  });

  it('keeps a discarded proposal in generation history without storing it', async () => {
    const userEvents = userEvent.setup();
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci e peperoni al forno' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(generateAiRecipe).mockResolvedValueOnce(recipe).mockResolvedValueOnce(second);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await expectGenerationEnabled(panel);
    const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });
    await userEvents.click(generateButton);
    expect(await within(panel).findByRole('heading', { name: 'Ceci croccanti' })).toBeInTheDocument();

    await userEvents.click(within(panel).getByRole('button', { name: 'Scarta' }));
    expect(within(panel).queryByRole('heading', { name: 'Ceci croccanti' })).not.toBeInTheDocument();
    expect(saveAiRecipe).not.toHaveBeenCalled();

    await userEvents.click(generateButton);
    expect(await within(panel).findByRole('heading', { name: second.title })).toBeInTheDocument();
    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [{ title: recipe.title, ingredients: recipe.ingredients }] },
      profile,
      'csrf-token',
    );
  });

  it('keeps a preview visible with an error when the explicit save fails', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    vi.mocked(saveAiRecipe).mockRejectedValue(new ApiClientError(0, 'network_error', 'offline'));
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await expectGenerationEnabled(panel);
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));

    await userEvents.click(await within(panel).findByRole('button', { name: 'Salva ricetta' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(/non raggiungibile/i);
    expect(within(panel).getByRole('button', { name: 'Salva ricetta' })).toBeInTheDocument();
  });

  it('keeps earlier previews when another recipe is generated', async () => {
    const userEvents = userEvent.setup();
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Pomodori ripieni' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(generateAiRecipe).mockResolvedValueOnce(recipe).mockResolvedValueOnce(second);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await expectGenerationEnabled(panel);
    const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });

    await userEvents.click(generateButton);
    expect(await within(panel).findByRole('heading', { name: 'Ceci croccanti' })).toBeInTheDocument();
    await userEvents.click(generateButton);
    expect(await within(panel).findByRole('heading', { name: 'Pomodori ripieni' })).toBeInTheDocument();

    expect(within(panel).getAllByRole('button', { name: 'Salva ricetta' })).toHaveLength(2);
    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [{ title: recipe.title, ingredients: recipe.ingredients }] },
      profile,
      'csrf-token',
    );
    expect(saveAiRecipe).not.toHaveBeenCalled();
  });

  it('clears local proposal history when Profile revokes AI consent', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(panel).findByRole('heading', { name: recipe.title });
    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).not.toBeNull();

    await clearAiRecipeProposalHistory(user.id);

    await waitFor(() => expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull());
    expect(within(panel).getByRole('heading', { name: recipe.title })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();
  });

  it('does not send proposal history after Profile revocation and a later explicit regrant', async () => {
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci e limone' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'openai',
    });
    vi.mocked(generateAiRecipe).mockResolvedValueOnce(recipe).mockResolvedValueOnce(second);
    const firstView = renderPanel();

    const firstPanel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.click(await within(firstPanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(firstPanel).findByRole('heading', { name: recipe.title });
    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).not.toBeNull();

    await clearAiRecipeProposalHistory(user.id);
    await waitFor(() => expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull());
    firstView.unmount();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' }, selectedProvider: 'openai' });
    const secondView = renderPanel();
    const secondPanel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.click(await within(secondPanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(secondPanel).findByRole('heading', { name: second.title });

    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
    secondView.unmount();
  });

  it('explains when a near-duplicate preview was rejected', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(generateAiRecipe).mockRejectedValue(new ApiClientError(422, 'ai_recipe_not_novel', 'duplicate'));
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(/idea troppo simile/i);
    expect(within(panel).queryByRole('article')).not.toBeInTheDocument();
  });

  it('keeps saved recipes readable after Profile revocation and translates quota errors after regrant', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(fetchAiRecipes).mockResolvedValue([recipe]);
    vi.mocked(generateAiRecipe).mockRejectedValue(new ApiClientError(429, 'ai_daily_limit_reached', 'limit'));
    const firstView = renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('heading', { name: recipe.title })).toBeInTheDocument();
    await clearAiRecipeProposalHistory(user.id);
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument());
    expect(within(panel).getByRole('heading', { name: recipe.title })).toBeInTheDocument();

    firstView.unmount();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' }, selectedProvider: 'openai' });
    const secondView = renderPanel();
    const secondPanel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.click(await within(secondPanel).findByRole('button', { name: 'Genera ricetta AI' }));
    expect(await within(secondPanel).findByRole('alert')).toHaveTextContent(/limite giornaliero per le ricette AI/i);
    expect(within(secondPanel).getByRole('alert')).not.toHaveTextContent(/cinque ricette/i);
    secondView.unmount();
  });

  it('defers remote deletion so the undo action can restore the recipe', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(fetchAiRecipes).mockResolvedValue([recipe]);
    vi.mocked(deleteAiRecipe).mockResolvedValue();
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('heading', { name: recipe.title })).toBeInTheDocument();

    await userEvents.click(within(panel).getByRole('button', { name: `Elimina ${recipe.title}` }));
    expect(within(panel).queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();
    expect(deleteAiRecipe).not.toHaveBeenCalled();

    await userEvents.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(await within(panel).findByRole('heading', { name: recipe.title })).toBeInTheDocument();
    expect(deleteAiRecipe).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'openai' as const, recipient: 'OpenAI' },
    { provider: 'gemini' as const, recipient: 'Gemini di Google' },
  ])('names $recipient and every Home field in the Profile consent link', async ({ provider, recipient }) => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: provider,
    });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const settingsLink = await within(panel).findByRole('link', { name: /gestisci il consenso AI nel profilo/i });
    expect(settingsLink).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    const disclosure = panel.textContent ?? '';
    expect(disclosure).toContain(`I dati che possono essere inviati a ${recipient}`);
    expect(disclosure).toContain('nomi degli ingredienti della dispensa');
    expect(disclosure).toContain('dieta scelta, allergeni esclusi, calorie massime e proteine minime per porzione');
    expect(disclosure).toContain('titoli e nomi/quantità degli ingredienti delle ricette AI salvate o già proposte');
    expect(disclosure).toContain('vincoli di generazione, attualmente vuoto');
  });

  it('does not treat a legacy enabled Home consent without a provider marker as approval', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, updatedAt: '2026-09-13T12:00:00.000Z' } as never,
      selectedProvider: 'openai',
    });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('non specificava il destinatario');
  });

  it('does not treat a Home grant for an old provider as approval for the newly selected provider', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' } as never,
      selectedProvider: 'gemini',
    });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('Gemini di Google');
  });

  it('fails closed when server-selected Home provider status is unavailable', async () => {
    vi.mocked(fetchAiConsentStatus).mockRejectedValue(new Error('Consent status unavailable'));
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('alert')).toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();
  });

  it.each([
    { consent: { enabled: true, updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' as const },
    { consent: { enabled: true, homeProvider: 'openai' as const, updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'gemini' as const },
  ])('links legacy or mismatched global consent to Profile without approving $selectedProvider', async ({ consent, selectedProvider }) => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: consent as never, selectedProvider });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /revoca consenso/i })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();
    expect(updateAiConsent).not.toHaveBeenCalled();
  });

  it('does not imply a recipient or show literal null when Home provider is unknown', async () => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' } as never,
      selectedProvider: null as never,
    });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await waitFor(() => expect(panel).toHaveTextContent(/provider.*non è disponibile/i));
    expect(panel.textContent).not.toMatch(/\bnull\b|I dati inviati a|OpenAI|Gemini di Google/i);
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();
  });

  it('does not restore proposal history when a pending Home generation resolves after Profile revocation', async () => {
    let resolveGeneration!: (value: GeneratedRecipe) => void;
    const pendingGeneration = new Promise<GeneratedRecipe>((resolve) => { resolveGeneration = resolve; });
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci al limone' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' });
    vi.mocked(generateAiRecipe).mockReturnValueOnce(pendingGeneration).mockResolvedValueOnce(second);
    useAuthStore.setState({ user, csrfToken: 'csrf-token' });
    setActiveDataScope('account:user-1');
    const firstView = render(
      <>
        <AiRecipePanel ingredients={['Ceci', 'Pomodoro']} dietProfile={profile} user={user} csrfToken="csrf-token" />
        <AiConsentSettings />
      </>,
    );

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    expect(generateAiRecipe).toHaveBeenCalledTimes(1);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoca consenso AI globale' }));
    expect(updateAiConsent).toHaveBeenCalledWith(false, 'csrf-token', '2026-09-13T12:00:00.000Z');
    await waitFor(() => expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull());

    await act(async () => { resolveGeneration(recipe); });
    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull();
    expect(within(panel).queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();

    firstView.unmount();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' }, selectedProvider: 'openai' });
    const secondView = renderPanel();
    const secondPanel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvent.click(await within(secondPanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(secondPanel).findByRole('heading', { name: second.title });
    expect(generateAiRecipe).toHaveBeenNthCalledWith(2, { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] }, profile, 'csrf-token');
    secondView.unmount();
  });


  it.each([
    { userId: 'user-2', csrfToken: 'csrf-2', label: 'user scope' },
    { userId: 'user-1', csrfToken: 'csrf-2', label: 'session scope' },
  ])('does not persist a pending Home response after a $label change', async ({ userId, csrfToken }) => {
    const userEvents = userEvent.setup();
    let resolveGeneration!: (value: GeneratedRecipe) => void;
    const pendingGeneration = new Promise<GeneratedRecipe>((resolve) => { resolveGeneration = resolve; });
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'openai',
    });
    vi.mocked(generateAiRecipe).mockReturnValueOnce(pendingGeneration);
    const view = renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    view.rerender(
      <AiRecipePanel
        ingredients={['Ceci', 'Pomodoro']}
        dietProfile={profile}
        user={{ ...user, id: userId }}
        csrfToken={csrfToken}
      />,
    );
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument());
    expect(within(panel).getByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toBeInTheDocument();
    await act(async () => { resolveGeneration(recipe); });

    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull();
    expect(localStorage.getItem(`ikuck.ai-recipe-proposals:${userId}`)).toBeNull();
    expect(within(panel).queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();
  });

  it('invalidates pending Home generation on a cross-tab proposal-history storage event', async () => {
    const userEvents = userEvent.setup();
    let resolveGeneration!: (value: GeneratedRecipe) => void;
    const pendingGeneration = new Promise<GeneratedRecipe>((resolve) => { resolveGeneration = resolve; });
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci e spinaci' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'openai',
    });
    vi.mocked(generateAiRecipe).mockReturnValueOnce(pendingGeneration).mockResolvedValueOnce(second);
    const view = renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    const epochKey = 'ikuck.ai-recipe-proposal-revocation:user-1';
    localStorage.setItem(epochKey, '9999');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: epochKey,
        oldValue: '0',
        newValue: '9999',
        storageArea: localStorage,
      }));
    });
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument());
    expect(within(panel).getByRole('link', { name: /gestisci il consenso AI nel profilo/i })).toBeInTheDocument();
    await act(async () => { resolveGeneration(recipe); });

    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull();
    expect(within(panel).queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();
    view.unmount();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' }, selectedProvider: 'openai' });
    const regrantedView = renderPanel();
    const regrantedPanel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(regrantedPanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(regrantedPanel).findByRole('heading', { name: second.title });
    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
    regrantedView.unmount();
  });
});
