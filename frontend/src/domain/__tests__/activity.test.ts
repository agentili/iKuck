import { describe, expect, it } from 'vitest';
import {
  isEmptyRecipePreference,
  validateCookEventDetails,
  validateRecipePreferenceDetails,
} from '../activity';

describe('activity domain', () => {
  it('accepts a cook event with an optional private note', () => {
    expect(validateCookEventDetails('recipe-1', 'Pasta', 2, '2026-09-13T12:00:00.000Z', null)).toEqual([]);
    expect(validateCookEventDetails('recipe-1', 'Pasta', 2, '2026-09-13T12:00:00.000Z', 'Buona')).toEqual([]);
  });

  it('rejects incomplete events and invalid timestamps', () => {
    expect(validateCookEventDetails('', 'Pasta', 2, '2026-09-13T12:00:00.000Z', null)).toContain('recipe_id_required');
    expect(validateCookEventDetails('recipe-1', '', 2, '2026-09-13T12:00:00.000Z', null)).toContain('recipe_title_required');
    expect(validateCookEventDetails('recipe-1', 'Pasta', 0, '2026-09-13T12:00:00.000Z', null)).toContain('servings_positive');
    expect(validateCookEventDetails('recipe-1', 'Pasta', 2, 'not-a-date', null)).toContain('cooked_at_invalid');
  });

  it('accepts nullable ratings from one to five and rejects other values', () => {
    expect(validateRecipePreferenceDetails('recipe-1', true, null, null)).toEqual([]);
    expect(validateRecipePreferenceDetails('recipe-1', false, 1, null)).toEqual([]);
    expect(validateRecipePreferenceDetails('recipe-1', false, 5, null)).toEqual([]);
    expect(validateRecipePreferenceDetails('recipe-1', false, 0, null)).toContain('rating_range');
    expect(validateRecipePreferenceDetails('recipe-1', false, 3.5, null)).toContain('rating_integer');
    expect(validateRecipePreferenceDetails('recipe-1', false, null, 'x'.repeat(501))).toContain('note_too_long');
  });

  it('identifies a preference with no personal signal', () => {
    expect(isEmptyRecipePreference({ favorite: false, rating: null, note: null })).toBe(true);
    expect(isEmptyRecipePreference({ favorite: true, rating: null, note: null })).toBe(false);
    expect(isEmptyRecipePreference({ favorite: false, rating: 4, note: null })).toBe(false);
    expect(isEmptyRecipePreference({ favorite: false, rating: null, note: 'Da rifare' })).toBe(false);
  });
});
