import { describe, expect, it } from 'vitest';
import { calculateIngredientDifference, findRecipeNoveltyConflict } from './recipeNovelty.js';

const recipe = (title: string, names: string[]) => ({
  title,
  ingredients: names.map((name) => ({ name, amount: 'q.b.' })),
});

describe('AI recipe novelty', () => {
  it('normalizes case, accents, punctuation and ingredient amounts', () => {
    expect(calculateIngredientDifference(
      recipe('Pasta', ['Olio extravergine di oliva', 'Pomodoro']),
      recipe('Pasta', ['OLIO EXTRAVERGINE DI OLIVA!', 'pomodóro']),
    )).toBe(0);
  });

  it('normalizes common Italian ingredient plurals before comparing recipes', () => {
    expect(calculateIngredientDifference(
      recipe('Verdure e legumi', ['Pomodori', 'Zucchine', 'Ceci', 'Uova']),
      recipe('Legumi e verdure', ['Pomodoro', 'Zucchina', 'Cece', 'Uovo']),
    )).toBe(0);
  });

  it('matches ingredient variants one-to-one instead of overstating novelty', () => {
    expect(calculateIngredientDifference(
      recipe('Olio uno', ['Olio extravergine', 'Olio']),
      recipe('Olio due', ['Olio extravergine di oliva', 'Olio extravergine']),
    )).toBe(0);
  });

  it('rejects recipes with less than 30 percent ingredient difference', () => {
    const existing = recipe('Pasta al pomodoro', ['Pasta', 'Pomodoro', 'Aglio', 'Olio']);
    const candidate = recipe('Pasta al pomodoro croccante', ['Pasta', 'Pomodoro', 'Aglio', 'Olio', 'Pangrattato']);

    expect(calculateIngredientDifference(candidate, existing)).toBeCloseTo(0.2);
    expect(findRecipeNoveltyConflict(candidate, [existing])).toMatchObject({
      reason: 'too_similar',
      title: 'Pasta al pomodoro',
    });
  });

  it('accepts exactly 30 percent ingredient difference from each known recipe', () => {
    const existing = recipe('Ceci speziati', ['alfa', 'bravo', 'charlie', 'delta', 'foxtrot', 'golf', 'hotel']);
    const candidate = recipe('Ortaggi speziati', ['alfa', 'bravo', 'charlie', 'delta', 'foxtrot', 'golf', 'hotel', 'juliet', 'kilo', 'lima']);

    expect(calculateIngredientDifference(candidate, existing)).toBeCloseTo(0.3);
    expect(findRecipeNoveltyConflict(candidate, [existing])).toBeNull();
  });

  it('rejects a repeated title even when its ingredients changed enough', () => {
    const existing = recipe('Risotto ai funghi', ['Riso', 'Funghi']);
    const candidate = recipe('RISOTTO AI FUNGHI!', ['Riso', 'Piselli', 'Zafferano', 'Brodo']);

    expect(findRecipeNoveltyConflict(candidate, [existing])).toMatchObject({
      reason: 'duplicate_title',
      title: 'Risotto ai funghi',
    });
  });

  it('checks novelty against every known recipe, not only the first', () => {
    const old = recipe('Insalata di ceci', ['Ceci', 'Pomodoro', 'Cetriolo', 'Cipolla']);
    const recent = recipe('Ceci al forno', ['Ceci', 'Paprika', 'Cumino', 'Olio']);
    const candidate = recipe('Ceci piccanti', ['Ceci', 'Paprika', 'Cumino', 'Olio', 'Limone']);

    expect(findRecipeNoveltyConflict(candidate, [old, recent])).toMatchObject({
      reason: 'too_similar',
      title: 'Ceci al forno',
    });
  });
});
