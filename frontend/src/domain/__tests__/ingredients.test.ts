import {
  DEFAULT_STAPLE_IDS,
  getIngredient,
  normalizeIngredientName,
  parseIngredientInput,
} from '../ingredients';

describe('ingredient domain', () => {
  it('normalizes case, accents, apostrophes and extra spaces', () => {
    expect(normalizeIngredientName('  Olìo   d’Oliva  ')).toBe('olio d oliva');
  });

  it('maps aliases separated by commas, semicolons and new lines', () => {
    expect(parseIngredientInput('pomodori, uova; ceci\ntonno')).toEqual([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'eggs', label: 'Uova', known: true },
      { id: 'chickpeas', label: 'Ceci', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);
  });

  it('deduplicates aliases that resolve to the same ingredient', () => {
    expect(parseIngredientInput('pomodoro, pomodori')).toEqual([
      { id: 'tomato', label: 'Pomodoro', known: true },
    ]);
  });

  it('preserves an unknown ingredient as a custom item', () => {
    expect(parseIngredientInput('Tempeh')).toEqual([
      { id: 'custom:tempeh', label: 'Tempeh', known: false },
    ]);
  });

  it('drops blank tokens', () => {
    expect(parseIngredientInput(' , ; \n ')).toEqual([]);
  });

  it('defines the four configurable default staples', () => {
    expect(DEFAULT_STAPLE_IDS).toEqual(['water', 'salt', 'black_pepper', 'olive_oil']);
    expect(DEFAULT_STAPLE_IDS.every((id) => getIngredient(id)?.staple)).toBe(true);
  });

  it('returns undefined for an ingredient outside the catalog', () => {
    expect(getIngredient('not-real')).toBeUndefined();
  });
});
