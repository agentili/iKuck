import { describe, expect, it } from 'vitest';
import { isFoodItem, matchFoodIngredient } from './foodFilter.js';

describe('Bring food filter', () => {
  it('accepts known ingredient labels and aliases after shared normalization', () => {
    expect(matchFoodIngredient('  Olìo   d’Oliva  ')).toMatchObject({ id: 'olive_oil', known: true });
    expect(matchFoodIngredient('POMODORI')).toMatchObject({ id: 'tomato', known: true });
    expect(isFoodItem('Latte')).toBe(true);
  });

  it('rejects unknown, compound, and empty labels without guessing', () => {
    expect(matchFoodIngredient('Detersivo piatti')).toBeNull();
    expect(matchFoodIngredient('Ceci e detersivo')).toBeNull();
    expect(matchFoodIngredient('   ')).toBeNull();
    expect(isFoodItem('Detersivo piatti')).toBe(false);
  });
});
