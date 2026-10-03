import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccountSummary, DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { ApiClientError } from '../../api/apiClient';
import AiRecipePanel from './AiRecipePanel';
import DinnerDiaryPage from '../../pages/DinnerDiaryPage';
import { useAuthStore } from '../../auth/authStore';
import { useDinnerDiaryStore } from '../../store/dinnerDiaryStore';
import { setActiveDataScope } from '../../sync/scopeContext';
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

const enableGeneration = async (
  panel: HTMLElement,
  userEvents: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await userEvents.click(await within(panel).findByRole('checkbox', { name: /acconsento all’invio a .*degli ingredienti/i }));
  await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
};

describe('AiRecipePanel', () => {
  beforeEach(() => {
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

  it('does not show controls or make requests for a guest', () => {
    renderPanel({ user: null, csrfToken: null });

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(within(panel).getByText(/ospiti e account non verificati/i)).toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(fetchAiConsent).not.toHaveBeenCalled();
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('saves consent before showing generation and keeps the generated recipe as an unsaved preview', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:01:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const consentCheckbox = await within(panel).findByRole('checkbox', { name: /acconsento all’invio a .*degli ingredienti/i });
    await userEvents.click(consentCheckbox);
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();

    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });
    expect(updateAiConsent).toHaveBeenCalledWith(true, 'csrf-token', '2026-09-13T12:00:00.000Z', undefined, 'openai');

    await userEvents.click(generateButton);
    expect(generateAiRecipe).toHaveBeenCalledWith(
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
    expect(await within(panel).findByRole('heading', { name: 'Ceci croccanti' })).toBeInTheDocument();
    expect(within(panel).getByText(/non ancora salvata/i)).toBeInTheDocument();
    expect(saveAiRecipe).not.toHaveBeenCalled();
    expect(within(panel).queryByRole('button', { name: `Elimina ${recipe.title}` })).not.toBeInTheDocument();
  });

  it('refreshes consent after a stale Home grant conflict', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsent)
      .mockResolvedValueOnce({ enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' })
      .mockResolvedValueOnce({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:02:00.000Z' });
    vi.mocked(updateAiConsent).mockRejectedValueOnce(
      new ApiClientError(409, 'ai_consent_revision_conflict', 'Consent changed'),
    );
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const checkbox = await within(panel).findByRole('checkbox', { name: /acconsento all’invio a .*degli ingredienti/i });
    await userEvents.click(checkbox);
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));

    expect(updateAiConsent).toHaveBeenCalledWith(true, 'csrf-token', '2026-09-13T12:00:00.000Z', undefined, 'openai');
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/aggiornato lo stato/i);
    expect(fetchAiConsent).toHaveBeenCalledTimes(2);
    expect(checkbox).toBeChecked();
  });

  it('stores the preview in the account only after the explicit save', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:01:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    vi.mocked(saveAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await enableGeneration(panel, userEvents);
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
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:01:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValueOnce(recipe).mockResolvedValueOnce(second);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await enableGeneration(panel, userEvents);
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
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:01:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    vi.mocked(saveAiRecipe).mockRejectedValue(new ApiClientError(0, 'network_error', 'offline'));
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await enableGeneration(panel, userEvents);
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));

    await userEvents.click(await within(panel).findByRole('button', { name: 'Salva ricetta' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(/non raggiungibile/i);
    expect(within(panel).getByRole('button', { name: 'Salva ricetta' })).toBeInTheDocument();
  });

  it('keeps earlier previews when another recipe is generated', async () => {
    const userEvents = userEvent.setup();
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Pomodori ripieni' };
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:01:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValueOnce(recipe).mockResolvedValueOnce(second);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await enableGeneration(panel, userEvents);
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

  it('clears local proposal history when AI consent is revoked', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(panel).findByRole('heading', { name: recipe.title });
    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).not.toBeNull();

    await userEvents.click(within(panel).getByRole('checkbox', { name: /acconsento all’invio a .*degli ingredienti/i }));
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));

    await waitFor(() => expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull());
    expect(within(panel).getByRole('heading', { name: recipe.title })).toBeInTheDocument();
  });

  it('does not send in-memory proposal history after global consent is revoked and explicitly regranted', async () => {
    const userEvents = userEvent.setup();
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci e limone' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' } as never,
      selectedProvider: 'openai',
    });
    vi.mocked(generateAiRecipe).mockResolvedValueOnce(recipe).mockResolvedValueOnce(second);
    vi.mocked(updateAiConsent)
      .mockResolvedValueOnce({ enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' })
      .mockResolvedValueOnce({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' } as never);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });
    await userEvents.click(generateButton);
    await within(panel).findByRole('heading', { name: recipe.title });
    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).not.toBeNull();

    const consentCheckbox = within(panel).getByRole('checkbox');
    await userEvents.click(consentCheckbox);
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await waitFor(() => expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull());

    await userEvents.click(consentCheckbox);
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(panel).findByRole('heading', { name: second.title });

    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
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

  it('keeps saved recipes readable after revocation and translates quota errors', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(fetchAiRecipes).mockResolvedValue([recipe]);
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' });
    vi.mocked(generateAiRecipe).mockRejectedValue(new ApiClientError(429, 'ai_daily_limit_reached', 'limit'));
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('heading', { name: recipe.title })).toBeInTheDocument();
    const consentCheckbox = await within(panel).findByRole('checkbox', { name: /acconsento all’invio a .*degli ingredienti/i });
    await userEvents.click(consentCheckbox);
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument());
    expect(within(panel).getByRole('heading', { name: recipe.title })).toBeInTheDocument();

    await userEvents.click(consentCheckbox);
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' });
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/limite giornaliero per le ricette AI/i);
    expect(within(panel).getByRole('alert')).not.toHaveTextContent(/cinque ricette/i);
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
  ])('names $recipient and every Home field in the consent disclosure', async ({ provider, recipient }) => {
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: provider,
    });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const checkbox = await within(panel).findByRole('checkbox');
    expect(checkbox).toHaveAccessibleName(expect.stringContaining(recipient));
    expect(checkbox).toHaveAccessibleName(expect.stringContaining('ingredienti della dispensa'));
    expect(checkbox).toHaveAccessibleName(expect.stringContaining('profilo alimentare'));
    expect(checkbox).toHaveAccessibleName(expect.stringContaining('titoli'));
    expect(checkbox).toHaveAccessibleName(expect.stringContaining('ingredienti'));
    const disclosure = panel.textContent ?? '';
    expect(disclosure).toContain(`I dati inviati a ${recipient}`);
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
    const checkbox = await within(panel).findByRole('checkbox');
    expect(checkbox).not.toBeChecked();
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
    const checkbox = await within(panel).findByRole('checkbox');

    expect(checkbox).not.toBeChecked();
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
  ])('lets the user revoke legacy or mismatched global consent without approving $selectedProvider', async ({ consent, selectedProvider }) => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: consent as never, selectedProvider });
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-13T12:01:00.000Z' });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('checkbox')).not.toBeChecked();
    await userEvents.click(await within(panel).findByRole('button', { name: /revoca consenso AI globale/i }));

    expect(updateAiConsent).toHaveBeenCalledWith(false, 'csrf-token', '2026-09-13T12:00:00.000Z', undefined, undefined);
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

  it('does not restore proposal history when a pending Home generation resolves after same-tab revocation', async () => {
    const userEvents = userEvent.setup();
    let resolveGeneration!: (value: GeneratedRecipe) => void;
    const pendingGeneration = new Promise<GeneratedRecipe>((resolve) => { resolveGeneration = resolve; });
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci al limone' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'openai',
    });
    vi.mocked(generateAiRecipe).mockReturnValueOnce(pendingGeneration).mockResolvedValueOnce(second);
    vi.mocked(updateAiConsent)
      .mockResolvedValueOnce({ enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' })
      .mockResolvedValueOnce({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' });
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    expect(generateAiRecipe).toHaveBeenCalledTimes(1);
    await userEvents.click(await within(panel).findByRole('button', { name: /revoca consenso AI globale/i }));
    await waitFor(() => expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull());

    await act(async () => { resolveGeneration(recipe); });
    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull();
    expect(within(panel).queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();

    const consentCheckbox = within(panel).getByRole('checkbox');
    await userEvents.click(consentCheckbox);
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(panel).findByRole('heading', { name: second.title });

    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
  });

  it('invalidates pending Home generation when Dinner revokes consent in the same tab', async () => {
    const userEvents = userEvent.setup();
    let resolveGeneration!: (value: GeneratedRecipe) => void;
    const pendingGeneration = new Promise<GeneratedRecipe>((resolve) => { resolveGeneration = resolve; });
    const second: GeneratedRecipe = { ...recipe, id: 'recipe-2', title: 'Ceci e finocchio' };
    const revision = '2026-09-13T12:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', dinnerProvider: 'openai', updatedAt: revision },
      selectedProvider: 'openai',
    });
    vi.mocked(generateAiRecipe).mockReturnValueOnce(pendingGeneration).mockResolvedValueOnce(second);
    vi.mocked(updateAiConsent)
      .mockResolvedValueOnce({ enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' })
      .mockResolvedValueOnce({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' });
    useAuthStore.setState({ user: { ...user, id: user.id } as never, csrfToken: 'csrf-token' });
    setActiveDataScope('account:user-1');
    render(
      <>
        <AiRecipePanel ingredients={['Ceci', 'Pomodoro']} dietProfile={profile} user={user} csrfToken="csrf-token" />
        <MemoryRouter><DinnerDiaryPage /></MemoryRouter>
      </>,
    );

    const homePanel = screen.getByRole('region', { name: 'Ricette AI private' });
    const dinnerPanel = await screen.findByRole('region', { name: 'Consenso per ricostruire ricette' });
    await userEvents.click(await within(homePanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await userEvents.click(within(dinnerPanel).getByRole('button', { name: /revoca consenso AI globale/i }));
    await waitFor(() => expect(within(homePanel).getByRole('checkbox')).not.toBeChecked());

    await act(async () => { resolveGeneration(recipe); });
    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull();
    expect(within(homePanel).queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();

    await userEvents.click(within(homePanel).getByRole('checkbox'));
    await userEvents.click(within(homePanel).getByRole('button', { name: 'Salva consenso' }));
    await userEvents.click(await within(homePanel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(homePanel).findByRole('heading', { name: second.title });
    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
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
    await within(panel).findByRole('checkbox');
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
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:03:00.000Z' });
    renderPanel();

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
    await waitFor(() => expect(within(panel).getByRole('checkbox')).not.toBeChecked());
    await act(async () => { resolveGeneration(recipe); });

    expect(localStorage.getItem('ikuck.ai-recipe-proposals:user-1')).toBeNull();
    expect(within(panel).queryByRole('heading', { name: recipe.title })).not.toBeInTheDocument();
    await userEvents.click(within(panel).getByRole('checkbox'));
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    await within(panel).findByRole('heading', { name: second.title });
    expect(generateAiRecipe).toHaveBeenNthCalledWith(
      2,
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [], existingRecipes: [] },
      profile,
      'csrf-token',
    );
  });
});
