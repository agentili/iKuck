import { describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../api/apiClient';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import { deleteAiRecipe, fetchAiConsent, fetchAiRecipes, generateAiRecipe, updateAiConsent } from './aiRecipeApi';

const profile: DietProfilePayload = {
  diet: 'vegan',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

describe('AI recipe API', () => {
  it('loads and updates server-side consent with the CSRF token', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' } })
      .mockResolvedValueOnce({ consent: { enabled: true, updatedAt: '2026-09-13T12:01:00.000Z' } }) as unknown as ApiRequest;

    await expect(fetchAiConsent(request)).resolves.toMatchObject({ enabled: false });
    await expect(updateAiConsent(true, 'csrf-token', request)).resolves.toMatchObject({ enabled: true });

    expect(request).toHaveBeenNthCalledWith(1, '/v1/ai-recipes/consent');
    expect(request).toHaveBeenNthCalledWith(2, '/v1/ai-recipes/consent', {
      method: 'PUT',
      body: { enabled: true },
      csrfToken: 'csrf-token',
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
});
