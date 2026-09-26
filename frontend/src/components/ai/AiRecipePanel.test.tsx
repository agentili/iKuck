import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccountSummary, DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { ApiClientError } from '../../api/apiClient';
import AiRecipePanel from './AiRecipePanel';
import {
  deleteAiRecipe,
  fetchAiConsent,
  fetchAiRecipes,
  generateAiRecipe,
  saveAiRecipe,
  updateAiConsent,
} from '../../ai/aiRecipeApi';

vi.mock('../../ai/aiRecipeApi', () => ({
  deleteAiRecipe: vi.fn(),
  fetchAiConsent: vi.fn(),
  fetchAiRecipes: vi.fn(),
  generateAiRecipe: vi.fn(),
  saveAiRecipe: vi.fn(),
  updateAiConsent: vi.fn(),
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
  await userEvents.click(await within(panel).findByRole('checkbox', { name: /acconsento all’uso degli ingredienti/i }));
  await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
};

describe('AiRecipePanel', () => {
  beforeEach(() => {
    vi.mocked(fetchAiConsent).mockReset();
    vi.mocked(fetchAiRecipes).mockReset();
    vi.mocked(updateAiConsent).mockReset();
    vi.mocked(generateAiRecipe).mockReset();
    vi.mocked(saveAiRecipe).mockReset();
    vi.mocked(deleteAiRecipe).mockReset();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(fetchAiRecipes).mockResolvedValue([]);
  });

  it('does not show controls or make requests for a guest', () => {
    renderPanel({ user: null, csrfToken: null });

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(within(panel).getByText(/disponibili dopo la verifica/i)).toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(fetchAiConsent).not.toHaveBeenCalled();
    expect(fetchAiRecipes).not.toHaveBeenCalled();
  });

  it('saves consent before showing generation and keeps the generated recipe as an unsaved preview', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:01:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    const consentCheckbox = await within(panel).findByRole('checkbox', { name: /acconsento all’uso degli ingredienti/i });
    await userEvents.click(consentCheckbox);
    expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();

    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    const generateButton = await within(panel).findByRole('button', { name: 'Genera ricetta AI' });
    expect(updateAiConsent).toHaveBeenCalledWith(true, 'csrf-token');

    await userEvents.click(generateButton);
    expect(generateAiRecipe).toHaveBeenCalledWith(
      { ingredients: ['Ceci', 'Pomodoro'], constraints: [] },
      profile,
      'csrf-token',
    );
    expect(await within(panel).findByRole('heading', { name: 'Ceci croccanti' })).toBeInTheDocument();
    expect(within(panel).getByText(/non ancora salvata/i)).toBeInTheDocument();
    expect(saveAiRecipe).not.toHaveBeenCalled();
    expect(within(panel).queryByRole('button', { name: `Elimina ${recipe.title}` })).not.toBeInTheDocument();
  });

  it('stores the preview in the account only after the explicit save', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:01:00.000Z' });
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

  it('discards a generated preview without storing it', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:01:00.000Z' });
    vi.mocked(generateAiRecipe).mockResolvedValue(recipe);
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    await enableGeneration(panel, userEvents);
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    expect(await within(panel).findByRole('heading', { name: 'Ceci croccanti' })).toBeInTheDocument();

    await userEvents.click(within(panel).getByRole('button', { name: 'Scarta' }));

    expect(within(panel).queryByRole('heading', { name: 'Ceci croccanti' })).not.toBeInTheDocument();
    expect(saveAiRecipe).not.toHaveBeenCalled();
  });

  it('keeps a preview visible with an error when the explicit save fails', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:01:00.000Z' });
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
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:01:00.000Z' });
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
    expect(saveAiRecipe).not.toHaveBeenCalled();
  });

  it('keeps saved recipes readable after revocation and translates quota errors', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:00:00.000Z' });
    vi.mocked(fetchAiRecipes).mockResolvedValue([recipe]);
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' });
    vi.mocked(generateAiRecipe).mockRejectedValue(new ApiClientError(429, 'ai_daily_limit_reached', 'limit'));
    renderPanel();

    const panel = screen.getByRole('region', { name: 'Ricette AI private' });
    expect(await within(panel).findByRole('heading', { name: recipe.title })).toBeInTheDocument();
    const consentCheckbox = await within(panel).findByRole('checkbox', { name: /acconsento all’uso degli ingredienti/i });
    await userEvents.click(consentCheckbox);
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument());
    expect(within(panel).getByRole('heading', { name: recipe.title })).toBeInTheDocument();

    await userEvents.click(consentCheckbox);
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:03:00.000Z' });
    await userEvents.click(within(panel).getByRole('button', { name: 'Salva consenso' }));
    await userEvents.click(await within(panel).findByRole('button', { name: 'Genera ricetta AI' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/cinque ricette AI al giorno/i);
  });

  it('defers remote deletion so the undo action can restore the recipe', async () => {
    const userEvents = userEvent.setup();
    vi.mocked(fetchAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-13T12:00:00.000Z' });
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
});
