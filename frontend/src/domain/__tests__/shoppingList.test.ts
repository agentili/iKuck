import { describe, expect, it } from 'vitest';
import {
  createShoppingListItemFromRecipe,
  parseRecipeAmount,
  validateShoppingListItemDetails,
} from '../shoppingList';

describe('shopping list domain', () => {
  it('accepts manual items with or without optional quantity details', () => {
    expect(validateShoppingListItemDetails('Pasta', null, null, null)).toEqual([]);
    expect(validateShoppingListItemDetails('Pasta', 500, 'g', null)).toEqual([]);
  });

  it('rejects invalid labels, quantities, units and notes', () => {
    expect(validateShoppingListItemDetails('   ', null, null, null)).toContain('label_required');
    expect(validateShoppingListItemDetails('Pasta', 0, 'g', null)).toContain('quantity_positive');
    expect(validateShoppingListItemDetails('Pasta', 10, null, null)).toContain('unit_required');
    expect(validateShoppingListItemDetails('Pasta', 10, 'piece', null)).not.toContain('unit_required');
    expect(validateShoppingListItemDetails('Pasta', null, 'g', null)).toContain('quantity_required');
    expect(validateShoppingListItemDetails('Pasta', null, null, 'x'.repeat(121))).toContain('note_too_long');
  });

  it('parses recognized recipe amounts and preserves uncertain amounts as notes', () => {
    expect(parseRecipeAmount('1.5 kg')).toEqual({ quantity: 1.5, unit: 'kg', note: null });
    expect(parseRecipeAmount('2')).toEqual({ quantity: 2, unit: 'piece', note: null });
    expect(parseRecipeAmount('q.b.')).toEqual({ quantity: null, unit: null, note: 'q.b.' });
    expect(parseRecipeAmount('1 spicchio')).toEqual({ quantity: null, unit: null, note: '1 spicchio' });
  });

  it('builds a source-aware item payload from a recipe ingredient', () => {
    const item = createShoppingListItemFromRecipe(
      { id: 'recipe-1', title: 'Pasta', description: '', category: 'vegetables', durationMinutes: 10, difficulty: 'easy', servings: 2, ingredients: [], steps: [], tags: [] },
      { ingredientId: 'pasta', amount: '180 g' },
      'Pasta',
    );

    expect(item).toMatchObject({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: 180,
      unit: 'g',
      note: null,
      purchased: false,
      sourceRecipeId: 'recipe-1',
    });
  });
});
