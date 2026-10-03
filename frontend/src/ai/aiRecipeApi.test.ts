import { describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../api/apiClient';
import type { DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { deleteAiRecipe, fetchAiConsent, fetchAiConsentStatus, fetchAiRecipes, generateAiRecipe, saveAiRecipe, updateAiConsent, updateDinnerAiConsent } from './aiRecipeApi';

const profile: DietProfilePayload = {
  diet: 'vegan',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

const generatedRecipe: GeneratedRecipe = {
  id: 'recipe-9',
  source: 'ai',
  title: 'Ceci al forno',
  description: 'Semplice.',
  ingredients: [{ name: 'Ceci', amount: '240 g' }],
  steps: ['Cuoci.'],
  diets: ['vegan'],
  allergens: [],
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-13T12:00:00.000Z',
};

describe('AI recipe API', () => {
  it('uses the server-selected provider for Dinner consent status and update', async () => {
    const consentStatus = { consent: { enabled: true, updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'gemini' as const };
    const request = vi.fn()
      .mockResolvedValueOnce(consentStatus)
      .mockResolvedValueOnce(consentStatus) as unknown as ApiRequest;

    await expect(fetchAiConsentStatus(request)).resolves.toEqual(consentStatus);
    await expect(updateDinnerAiConsent('gemini', 'csrf-token', '2026-09-13T12:00:00.000Z', request)).resolves.toEqual(consentStatus);

    expect(request).toHaveBeenNthCalledWith(1, '/v1/ai-recipes/consent');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/ai-recipes/consent', {
      method: 'PUT',
      body: { dinnerProvider: 'gemini', expectedRevision: '2026-09-13T12:00:00.000Z' },
      csrfToken: 'csrf-token',
    });
  });

  it('rejects an unknown server-selected provider so Home cannot show an incomplete consent disclosure', async () => {
    const request = vi.fn().mockResolvedValue({
      consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
      selectedProvider: 'unknown-provider',
    }) as unknown as ApiRequest;

    await expect(fetchAiConsentStatus(request)).rejects.toMatchObject({ code: 'ai_consent_status_invalid' });
  });

  it('loads and updates server-side consent with the CSRF token', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' }, selectedProvider: 'openai' })
      .mockResolvedValueOnce({ consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:01:00.000Z' }, selectedProvider: 'openai' }) as unknown as ApiRequest;

    await expect(fetchAiConsent(request)).resolves.toMatchObject({ enabled: false });
    await expect(updateAiConsent(true, 'csrf-token', '2026-09-13T12:00:00.000Z', request, 'openai')).resolves.toMatchObject({ enabled: true, homeProvider: 'openai' });

    expect(request).toHaveBeenNthCalledWith(1, '/v1/ai-recipes/consent');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/ai-recipes/consent', {
      method: 'PUT',
      body: { enabled: true, homeProvider: 'openai', expectedRevision: '2026-09-13T12:00:00.000Z' },
      csrfToken: 'csrf-token',
    });
  });

  it('keeps Home and Dinner revocations available without a revision', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ consent: { enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' } })
      .mockResolvedValueOnce({
        consent: { enabled: false, updatedAt: '2026-09-13T12:03:00.000Z' }, selectedProvider: 'gemini',
      }) as unknown as ApiRequest;

    await updateAiConsent(false, 'csrf-token', undefined, request);
    await updateDinnerAiConsent(null, 'csrf-token', undefined, request);

    expect(request).toHaveBeenNthCalledWith(1, '/v1/ai-recipes/consent', {
      method: 'PUT', body: { enabled: false }, csrfToken: 'csrf-token',
    });
    expect(request).toHaveBeenNthCalledWith(2, '/v1/ai-recipes/consent', {
      method: 'PUT', body: { dinnerProvider: null }, csrfToken: 'csrf-token',
    });
  });

  it('sends only the stable pantry labels and profile, and supports private recipe deletion', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ recipes: [] })
      .mockResolvedValueOnce({ recipe: { id: 'recipe-1', source: 'ai' } })
      .mockResolvedValueOnce(undefined) as unknown as ApiRequest;

    await expect(fetchAiRecipes(request)).resolves.toEqual([]);
    await expect(generateAiRecipe({ ingredients: ['Ceci', 'Pomodoro'], constraints: [] }, profile, 'csrf-token', request))
      .resolves.toMatchObject({ id: 'recipe-1' });
    await expect(deleteAiRecipe('recipe-1', 'csrf-token', request)).resolves.toBeUndefined();

    expect(request).toHaveBeenNthCalledWith(1, '/v1/ai-recipes');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/ai-recipes', {
      method: 'POST',
      body: { ingredients: ['Ceci', 'Pomodoro'], constraints: [], dietProfile: profile },
      csrfToken: 'csrf-token',
    });
    expect(request).toHaveBeenNthCalledWith(3, '/v1/ai-recipes/recipe-1', {
      method: 'DELETE',
      csrfToken: 'csrf-token',
    });
  });

  it('omits persistence metadata when sending a stored diet profile', async () => {
    const request = vi.fn().mockResolvedValue({ recipe: { id: 'recipe-2', source: 'ai' } }) as unknown as ApiRequest;
    const storedProfile = { ...profile, updatedAt: '2026-09-13T12:00:00.000Z' };

    await expect(generateAiRecipe({ ingredients: ['Ceci'], constraints: [] }, storedProfile, 'csrf-token', request))
      .resolves.toMatchObject({ id: 'recipe-2' });

    expect(request).toHaveBeenCalledWith('/v1/ai-recipes', {
      method: 'POST',
      body: { ingredients: ['Ceci'], constraints: [], dietProfile: profile },
      csrfToken: 'csrf-token',
    });
  });

  it('stores a generated preview only when the user confirms the explicit save', async () => {
    const request = vi.fn().mockResolvedValue({ recipe: generatedRecipe }) as unknown as ApiRequest;

    await expect(saveAiRecipe(generatedRecipe, 'csrf-token', request)).resolves.toMatchObject({ id: 'recipe-9' });

    expect(request).toHaveBeenCalledWith('/v1/ai-recipes/save', {
      method: 'POST',
      body: { recipe: generatedRecipe },
      csrfToken: 'csrf-token',
    });
  });
});
