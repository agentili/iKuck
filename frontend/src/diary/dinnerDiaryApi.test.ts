import { describe, expect, it, vi } from 'vitest';
import type { ApiRequest } from '../api/apiClient';
import { confirmDiaryRecipe, linkDiaryRecipe, reconstructDinnerRecipes } from './dinnerDiaryApi';

const draft = {
  draftId: 'server-draft-1', title: 'Pasta con zucchine', description: 'Pasta con zucchine.',
  ingredients: [{ name: 'Pasta', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' as const }],
  steps: ['Cuoci la pasta.'], servings: 2, durationMinutes: null, diets: null, allergens: null,
  suggestedFields: [],
};
const entry = {
  id: 'entry-1', date: '2026-09-29', text: 'Pasta con zucchine', servings: 2, note: null,
  recipes: [{ recipeId: 'recipe-1', title: 'Pasta con zucchine', source: 'diary' as const }],
  authorId: 'user-1', createdAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:01:00.000Z',
};
const recipe = {
  id: 'recipe-1', title: draft.title, description: draft.description, ingredients: draft.ingredients,
  steps: draft.steps, servings: draft.servings, durationMinutes: draft.durationMinutes, diets: draft.diets,
  allergens: draft.allergens, suggestedFields: draft.suggestedFields, source: 'diary' as const, authorId: 'user-1',
  createdAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:01:00.000Z',
};

describe('Dinner diary API', () => {
  it('requests validated recipe drafts without sending other account data', async () => {
    const request = vi.fn().mockResolvedValue({ drafts: [draft], quota: { allowed: true, used: 1, remaining: 4 } }) as unknown as ApiRequest;

    await expect(reconstructDinnerRecipes({ dinnerText: 'Pasta con zucchine', servings: 2 }, 'csrf-token', request)).resolves.toEqual([draft]);
    expect(request).toHaveBeenCalledWith('/v1/ai-dinner-reconstruction', {
      method: 'POST', body: { dinnerText: 'Pasta con zucchine', servings: 2 }, csrfToken: 'csrf-token',
    });
  });

  it('confirms a draft explicitly and validates the persisted recipe response', async () => {
    const request = vi.fn().mockResolvedValue({ entry, recipe }) as unknown as ApiRequest;

    await expect(confirmDiaryRecipe('entry-1', draft, 'csrf-token', request)).resolves.toEqual({ entry, recipe });
    expect(request).toHaveBeenCalledWith('/v1/dinner-entries/entry-1/confirm-recipe', {
      method: 'POST', body: { draft }, csrfToken: 'csrf-token',
    });
  });

  it('links an existing saved recipe by identity, never by title', async () => {
    const request = vi.fn().mockResolvedValue({ entry }) as unknown as ApiRequest;

    await expect(linkDiaryRecipe('entry-1', { recipeId: 'recipe-1', source: 'diary' }, 'csrf-token', request)).resolves.toEqual(entry);
    expect(request).toHaveBeenCalledWith('/v1/dinner-entries/entry-1/link-recipe', {
      method: 'POST', body: { recipeId: 'recipe-1', source: 'diary' }, csrfToken: 'csrf-token',
    });
  });

  it('rejects invalid API draft and confirmation payloads', async () => {
    const invalidDrafts = vi.fn().mockResolvedValue({ drafts: [{ ...draft, title: '' }] }) as unknown as ApiRequest;
    await expect(reconstructDinnerRecipes({ dinnerText: 'Pasta', servings: null }, 'csrf-token', invalidDrafts)).rejects.toMatchObject({ code: 'invalid_response' });

    const invalidConfirmation = vi.fn().mockResolvedValue({ entry, recipe: { ...recipe, source: 'ai' } }) as unknown as ApiRequest;
    await expect(confirmDiaryRecipe('entry-1', draft, 'csrf-token', invalidConfirmation)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
