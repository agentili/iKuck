import { getIngredient } from '../ingredients';
import { findHelpfulIngredients, findRecipeSuggestions } from '../suggestions';
import type { PantryRecipe } from '../types';

const createRecipe = (id: string, ingredientIds: string[], optionalIds: string[] = []): PantryRecipe => ({
  id,
  title: id,
  description: `Description for ${id}`,
  category: 'vegetables',
  durationMinutes: 10,
  difficulty: 'easy',
  servings: 2,
  ingredients: [
    ...ingredientIds.map((ingredientId) => ({ ingredientId, amount: '1' })),
    ...optionalIds.map((ingredientId) => ({ ingredientId, amount: '1', optional: true })),
  ],
  steps: ['Prepare ingredients.', 'Cook ingredients.'],
  tags: ['test'],
});

describe('recipe suggestions', () => {
  const recipes = [
    createRecipe('exact', ['pasta', 'tomato', 'salt']),
    createRecipe('one-easy-missing', ['pasta', 'tomato', 'basil']),
    createRecipe('one-hard-missing', ['pasta', 'tomato', 'salmon']),
    createRecipe('two-missing', ['pasta', 'zucchini', 'peas']),
  ];

  it('returns only complete recipes in standard mode', () => {
    const result = findRecipeSuggestions({
      recipes,
      availableIds: ['pasta', 'tomato', 'salt'],
      allowOneMissing: false,
      random: () => 0.5,
    });

    expect(result.map((item) => item.recipe.id)).toEqual(['exact']);
    expect(result[0].missingIngredientIds).toEqual([]);
  });

  it('includes one easy-to-find missing ingredient in extended mode', () => {
    const result = findRecipeSuggestions({
      recipes,
      availableIds: ['pasta', 'tomato', 'salt'],
      allowOneMissing: true,
      random: () => 0.5,
    });

    expect(result.map((item) => item.recipe.id)).toEqual(['exact', 'one-easy-missing']);
    expect(result[1].missingIngredientIds).toEqual(['basil']);
  });

  it('excludes one hard-to-find missing ingredient', () => {
    const result = findRecipeSuggestions({
      recipes: [createRecipe('hard', ['pasta', 'salmon'])],
      availableIds: ['pasta'],
      allowOneMissing: true,
    });

    expect(result).toEqual([]);
  });

  it('excludes recipes with two missing ingredients', () => {
    const result = findRecipeSuggestions({
      recipes: [createRecipe('two', ['pasta', 'zucchini', 'peas'])],
      availableIds: ['pasta'],
      allowOneMissing: true,
    });

    expect(result).toEqual([]);
  });

  it('ignores optional ingredients when evaluating completeness', () => {
    const result = findRecipeSuggestions({
      recipes: [createRecipe('optional', ['pasta'], ['basil'])],
      availableIds: ['pasta'],
      allowOneMissing: false,
    });

    expect(result[0].missingIngredientIds).toEqual([]);
  });

  it('keeps complete matches first and limits output to six', () => {
    const manyRecipes = [
      ...Array.from({ length: 7 }, (_, index) => createRecipe(`exact-${index}`, ['salt'])),
      createRecipe('extended', ['salt', 'basil']),
    ];

    const result = findRecipeSuggestions({
      recipes: manyRecipes,
      availableIds: ['salt'],
      allowOneMissing: true,
      random: () => 0.25,
    });

    expect(result).toHaveLength(6);
    expect(result.every((item) => item.missingIngredientIds.length === 0)).toBe(true);
  });

  it('returns a fresh array without mutating the recipe catalog', () => {
    const originalOrder = recipes.map((recipe) => recipe.id);
    const first = findRecipeSuggestions({
      recipes,
      availableIds: ['pasta', 'tomato', 'salt'],
      allowOneMissing: true,
      random: () => 0.1,
    });
    const second = findRecipeSuggestions({
      recipes,
      availableIds: ['pasta', 'tomato', 'salt'],
      allowOneMissing: true,
      random: () => 0.9,
    });

    expect(recipes.map((recipe) => recipe.id)).toEqual(originalOrder);
    expect(first).not.toBe(second);
  });

  it('suggests three known, useful and easy-to-find ingredients', () => {
    const result = findHelpfulIngredients(['water', 'salt', 'black_pepper', 'olive_oil'], 3);

    expect(result).toHaveLength(3);
    expect(new Set(result.map((ingredient) => ingredient.id)).size).toBe(3);
    expect(result.every((ingredient) => ingredient.easyToFind)).toBe(true);
    expect(result.every((ingredient) => getIngredient(ingredient.id) === ingredient)).toBe(true);
  });
});
