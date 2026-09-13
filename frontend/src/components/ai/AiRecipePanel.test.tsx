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
  updateAiConsent,
} from '../../ai/aiRecipeApi';

vi.mock('../../ai/aiRecipeApi', () => ({
  deleteAiRecipe: vi.fn(),
  fetchAiConsent: vi.fn(),
  fetchAiRecipes: vi.fn(),
  generateAiRecipe: vi.fn(),
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

describe('AiRecipePanel', () => {
  beforeEach(() => {
    vi.mocked(fetchAiConsent).mockReset();
    vi.mocked(fetchAiRecipes).mockReset();
    vi.mocked(updateAiConsent).mockReset();
    vi.mocked(generateAiRecipe).mockReset();
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

  it('saves consent before showing generation and renders a private recipe without changing pantry props', async () => {
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
});
