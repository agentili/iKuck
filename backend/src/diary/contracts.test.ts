import { describe, expect, it } from 'vitest';
import { isDiaryDraftSet, isDiaryIngredient, isDiaryRecipeDraft, isDinnerEntry, isDinnerRecipeLink, isSavedRecipe } from '@ikuck/shared/dinnerDiary';

const timestamp = '2024-02-29T12:30:00+01:00';
const ingredient = { name: 'Pasta', amount: '200 g', ingredientId: 'pasta', optional: false, provenance: 'provided' };
const draft = { draftId: 'd1', title: 'Pasta', description: '', ingredients: [ingredient], steps: ['Cook'], servings: null, durationMinutes: 20, diets: null, allergens: null, suggestedFields: ['amounts'] };
const entry = { id: 'e1', date: '2024-02-29', text: '  Dinner  ', servings: 2, note: null, recipes: [{ recipeId: 'r1', title: 'Pasta', source: 'diary' }], authorId: null, createdAt: timestamp, updatedAt: timestamp };

 describe('dinner diary contracts', () => {
  it('accepts valid shapes, preserves source text, partial known amounts and draft revision', () => {
    expect(isDinnerRecipeLink(entry.recipes[0])).toBe(true);
    expect(isDinnerEntry(entry)).toBe(true);
    expect(isDiaryIngredient({ ...ingredient, amount: '' })).toBe(true);
    expect(isDiaryRecipeDraft(draft)).toBe(true);
    const { draftId, ...savedFields } = draft;
    expect(draftId).toBe('d1');
    expect(isSavedRecipe({ ...savedFields, id: 'r1', source: 'diary', authorId: null, createdAt: timestamp, updatedAt: timestamp })).toBe(true);
    expect(isDiaryDraftSet({ entryId: 'e1', entryUpdatedAt: timestamp, drafts: [draft] })).toBe(true);
  });

  it('rejects impossible dates and timestamps without timezone', () => {
    expect(isDinnerEntry({ ...entry, date: '2023-02-29' })).toBe(false);
    expect(isDinnerEntry({ ...entry, date: '2024-04-31' })).toBe(false);
    expect(isDinnerEntry({ ...entry, createdAt: '2024-02-29T12:30:00' })).toBe(false);
  });

  it('rejects blank/long text, extra keys and invalid enums', () => {
    expect(isDinnerEntry({ ...entry, text: '  ' })).toBe(false);
    expect(isDinnerEntry({ ...entry, text: 'x'.repeat(5001) })).toBe(false);
    expect(isDinnerEntry({ ...entry, extra: true })).toBe(false);
    expect(isDiaryRecipeDraft({ ...draft, suggestedFields: ['title', 'bogus'] })).toBe(false);
    expect(isDiaryRecipeDraft({ ...draft, suggestedFields: ['title', 'title'] })).toBe(false);
  });

  it('enforces bounds, finite integers, ingredient IDs, and null unknown metadata', () => {
    expect(isDinnerEntry({ ...entry, servings: 1.5 })).toBe(false);
    expect(isDinnerEntry({ ...entry, servings: Infinity })).toBe(false);
    expect(isDinnerEntry({ ...entry, recipes: Array(11).fill(entry.recipes[0]) })).toBe(false);
    expect(isDiaryRecipeDraft({ ...draft, durationMinutes: 1.2 })).toBe(false);
    expect(isDiaryRecipeDraft({ ...draft, servings: 101 })).toBe(false);
    expect(isDiaryRecipeDraft({ ...draft, ingredients: [{ ...ingredient, ingredientId: '' }] })).toBe(false);
    expect(isDiaryRecipeDraft({ ...draft, diets: ['vegan', 'vegan'] })).toBe(false);
    expect(isDiaryRecipeDraft({ ...draft, diets: null, allergens: null })).toBe(true);
  });
});
