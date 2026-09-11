import { INGREDIENTS } from '../ingredients';
import { RECIPES, getRecipeById } from '../recipes';

describe('recipe catalog', () => {
  it('contains exactly four recipes for every supported category', () => {
    expect(RECIPES).toHaveLength(20);

    for (const category of ['meat', 'fish', 'eggs', 'legumes', 'vegetables']) {
      expect(RECIPES.filter((recipe) => recipe.category === category)).toHaveLength(4);
    }
  });

  it('uses unique stable recipe ids', () => {
    expect(new Set(RECIPES.map((recipe) => recipe.id)).size).toBe(RECIPES.length);
  });

  it('references only known ingredients', () => {
    const ingredientIds = new Set(INGREDIENTS.map((ingredient) => ingredient.id));

    for (const recipe of RECIPES) {
      expect(recipe.ingredients.every((item) => ingredientIds.has(item.ingredientId))).toBe(true);
    }
  });

  it('provides enough content to cook every recipe', () => {
    for (const recipe of RECIPES) {
      expect(recipe.description.trim().length).toBeGreaterThan(20);
      expect(recipe.durationMinutes).toBeGreaterThan(0);
      expect(recipe.servings).toBe(2);
      expect(recipe.ingredients.length).toBeGreaterThanOrEqual(3);
      expect(recipe.ingredients.every((item) => item.amount.trim().length > 0)).toBe(true);
      expect(recipe.steps.length).toBeGreaterThanOrEqual(2);
      expect(recipe.steps.every((step) => step.trim().length > 10)).toBe(true);
      expect(recipe.tags.length).toBeGreaterThan(0);
    }
  });

  it('retrieves a recipe by id without relying on navigation state', () => {
    expect(getRecipeById('pasta-tonno-pomodoro')?.title).toBe('Pasta tonno e pomodoro');
    expect(getRecipeById('not-real')).toBeUndefined();
  });
});
