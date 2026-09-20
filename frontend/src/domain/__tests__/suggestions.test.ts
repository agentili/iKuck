import type { CookEvent, DietProfilePayload, RecipePreference } from '@ikuck/shared/contracts';
import { getIngredient } from '../ingredients';
import { getRecipeById, RECIPES } from '../recipes';
import { createSeededRandom, findHelpfulIngredients, findRecipeSuggestions, rankRecipeSuggestions } from '../suggestions';
import type { PantryRecipe, RecipeSuggestion } from '../types';

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
  const now = '2026-09-13T12:00:00.000Z';
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

  it('replaces a dismissed pantry suggestion and can refresh the complete set', () => {
    const initial = findHelpfulIngredients(['water', 'salt', 'black_pepper', 'olive_oil'], 5);
    const replacement = findHelpfulIngredients(
      ['water', 'salt', 'black_pepper', 'olive_oil'],
      5,
      { excludedIds: [initial[0].id] },
    );
    const refreshed = findHelpfulIngredients(
      ['water', 'salt', 'black_pepper', 'olive_oil'],
      5,
      { random: createSeededRandom(1) },
    );

    expect(replacement.map((ingredient) => ingredient.id)).not.toContain(initial[0].id);
    expect(replacement).toHaveLength(5);
    expect(refreshed.map((ingredient) => ingredient.id)).not.toEqual(initial.map((ingredient) => ingredient.id));
    expect(new Set(refreshed.map((ingredient) => ingredient.id)).size).toBe(5);
  });

  it('filters recipes by diet and excluded allergens before pantry availability', () => {
    const availableIds = [...new Set(RECIPES.flatMap((recipe) => recipe.ingredients.map((item) => item.ingredientId)))];
    const profile: DietProfilePayload = {
      diet: 'vegetarian',
      excludedAllergens: ['fish'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    };

    const result = findRecipeSuggestions({ recipes: RECIPES, availableIds, allowOneMissing: false, dietProfile: profile, limit: 20 });

    expect(result.map(({ recipe }) => recipe.id)).not.toContain('pollo-al-limone');
    expect(result.map(({ recipe }) => recipe.id)).not.toContain('pasta-tonno-pomodoro');
    expect(result.map(({ recipe }) => recipe.id)).not.toContain('insalata-ceci-tonno');
    expect(result.map(({ recipe }) => recipe.id)).toContain('pasta-e-ceci');
  });

  it('applies catalog nutrition thresholds without changing pantry matching', () => {
    const recipes = [getRecipeById('pollo-al-limone')!, getRecipeById('tacchino-peperoni')!];
    const availableIds = [...new Set(recipes.flatMap((recipe) => recipe.ingredients.map((item) => item.ingredientId)))];
    const profile: DietProfilePayload = {
      diet: 'omnivore',
      excludedAllergens: [],
      nutrition: { maxCaloriesPerServing: 350, minProteinGramsPerServing: 40 },
    };

    const result = findRecipeSuggestions({ recipes, availableIds, allowOneMissing: false, dietProfile: profile });

    expect(result.map(({ recipe }) => recipe.id)).toEqual(['tacchino-peperoni']);
  });

  it('ranks a favorite before a neutral compatible recipe', () => {
    const candidates: RecipeSuggestion[] = [
      { recipe: createRecipe('neutral', ['salt']), missingIngredientIds: [], quantityWarnings: [] },
      { recipe: createRecipe('favorite', ['salt']), missingIngredientIds: [], quantityWarnings: [] },
    ];
    const preference: RecipePreference = {
      recipeId: 'favorite', favorite: true, rating: null, note: null, createdAt: now, updatedAt: now,
    };

    expect(rankRecipeSuggestions(candidates, { preferences: [preference], random: () => 0.5 }).map(({ recipe }) => recipe.id))
      .toEqual(['favorite', 'neutral']);
  });

  it('uses high ratings as a smaller positive ranking signal', () => {
    const candidates: RecipeSuggestion[] = [
      { recipe: createRecipe('neutral', ['salt']), missingIngredientIds: [], quantityWarnings: [] },
      { recipe: createRecipe('rated', ['salt']), missingIngredientIds: [], quantityWarnings: [] },
    ];
    const preference: RecipePreference = {
      recipeId: 'rated', favorite: false, rating: 5, note: null, createdAt: now, updatedAt: now,
    };

    expect(rankRecipeSuggestions(candidates, { preferences: [preference], random: () => 0.5 }).map(({ recipe }) => recipe.id))
      .toEqual(['rated', 'neutral']);
  });

  it('moves a recently cooked recipe behind an otherwise equal neutral recipe', () => {
    const candidates: RecipeSuggestion[] = [
      { recipe: createRecipe('cooked', ['salt']), missingIngredientIds: [], quantityWarnings: [] },
      { recipe: createRecipe('fresh', ['salt']), missingIngredientIds: [], quantityWarnings: [] },
    ];
    const event: CookEvent = {
      id: 'event-1', recipeId: 'cooked', recipeTitle: 'cooked', servings: 2, cookedAt: now, note: null, createdAt: now, updatedAt: now,
    };

    expect(rankRecipeSuggestions(candidates, { events: [event], random: () => 0.5 }).map(({ recipe }) => recipe.id))
      .toEqual(['fresh', 'cooked']);
  });

  it('produces repeatable but seed-dependent variety without mutating candidates', () => {
    const candidates: RecipeSuggestion[] = ['one', 'two', 'three', 'four'].map((id) => ({
      recipe: createRecipe(id, ['salt']), missingIngredientIds: [], quantityWarnings: [],
    }));
    const originalOrder = candidates.map(({ recipe }) => recipe.id);
    const first = rankRecipeSuggestions(candidates, { random: createSeededRandom(1) }).map(({ recipe }) => recipe.id);
    const repeat = rankRecipeSuggestions(candidates, { random: createSeededRandom(1) }).map(({ recipe }) => recipe.id);
    const otherSeed = rankRecipeSuggestions(candidates, { random: createSeededRandom(7) }).map(({ recipe }) => recipe.id);

    expect(repeat).toEqual(first);
    expect(otherSeed).not.toEqual(first);
    expect(candidates.map(({ recipe }) => recipe.id)).toEqual(originalOrder);
  });
});
