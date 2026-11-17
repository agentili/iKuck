import { describe, expect, it } from 'vitest';
import type { RecipeReference } from './recipeNovelty.js';
import { generatePantryRecipeDraft } from './pantryRecipe.js';

describe('generatePantryRecipeDraft', () => {
  it('creates a structured suggestion from known pantry ingredients', () => {
    const recipe = generatePantryRecipeDraft(['Orata', 'Patate'], [], () => 0);

    expect(recipe).toMatchObject({
      title: 'Padellata di Patate e Orata',
      ingredients: [
        { name: 'Patate', amount: 'q.b.' },
        { name: 'Orata', amount: 'q.b.' },
      ],
      diets: [],
      allergens: [],
    });
    expect(recipe?.steps).toHaveLength(3);
  });

  it('changes the suggested order with a different shuffle', () => {
    const forward = generatePantryRecipeDraft(['Orata', 'Patate'], [], () => 0);
    const reverse = generatePantryRecipeDraft(['Orata', 'Patate'], [], () => 0.99);

    expect(forward?.title).not.toBe(reverse?.title);
  });

  it('returns null when every ingredient combination conflicts with saved recipes', () => {
    const existing: RecipeReference[] = [{
      title: 'Teglia di Orata',
      ingredients: [{ name: 'Orata', amount: '1' }],
    }];

    expect(generatePantryRecipeDraft(['Orata'], existing, () => 0)).toBeNull();
  });

  it('tries another ingredient combination when the full set is already saved', () => {
    const existing: RecipeReference[] = [{
      title: 'Padellata di Orata e Patate',
      ingredients: [{ name: 'Orata', amount: '1' }, { name: 'Patate', amount: '300 g' }],
    }];
    const recipe = generatePantryRecipeDraft(['Orata', 'Patate'], existing, () => 0);

    expect(recipe).not.toBeNull();
    expect(recipe?.ingredients).toHaveLength(1);
    expect(['Orata', 'Patate']).toContain(recipe?.ingredients[0]?.name);
  });
});
