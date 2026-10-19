import { describe, expect, it } from 'vitest';
import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import { adaptGeneratedRecipe, adaptPantryRecipe, searchRecipes, type SearchableRecipe } from './recipeSearch';
import type { PantryRecipe } from './types';
import { RECIPES } from './recipes';

const baseRecipe = (overrides: Partial<SearchableRecipe> = {}): SearchableRecipe => ({
  id: 'recipe-1',
  title: 'Pollo al limone',
  ingredientNames: ['Petto di pollo', 'Limone', 'Aglio'],
  createdAt: null,
  ...overrides,
});

describe('searchRecipes', () => {
  it('returns all recipes when the query is empty', () => {
    const recipes = [baseRecipe(), baseRecipe({ id: 'recipe-2' })];
    expect(searchRecipes(recipes, '')).toHaveLength(2);
    expect(searchRecipes(recipes, '')).toEqual(recipes);
  });

  it('returns all recipes when the query is only whitespace', () => {
    const recipes = [baseRecipe(), baseRecipe({ id: 'recipe-2' })];
    expect(searchRecipes(recipes, '   ')).toHaveLength(2);
    expect(searchRecipes(recipes, '\t\n')).toHaveLength(2);
  });

  it('matches the title case-insensitively', () => {
    const recipes = [
      baseRecipe(),
      baseRecipe({ id: 'recipe-2', title: 'Straccetti di manzo con rucola', ingredientNames: ['Manzo', 'Rucola', 'Limone'] }),
    ];
    expect(searchRecipes(recipes, 'POLLO')).toHaveLength(1);
    expect(searchRecipes(recipes, 'pollo al limone')[0]?.id).toBe('recipe-1');
  });

  it('matches the title ignoring diacritics (però → pero)', () => {
    const recipes = [baseRecipe({ id: 'recipe-1', title: 'Carciofi alla giudìa' })];
    expect(searchRecipes(recipes, 'giudia')).toHaveLength(1);
    expect(searchRecipes(recipes, 'giudìa')).toHaveLength(1);
  });

  it('matches only in the title', () => {
    const recipes = [baseRecipe({ id: 'recipe-1', title: 'Orata al forno', ingredientNames: ['Patate', 'Rosmarino'] })];
    expect(searchRecipes(recipes, 'orata')).toHaveLength(1);
    expect(searchRecipes(recipes, 'rosmarino')).toHaveLength(1);
    expect(searchRecipes(recipes, 'merluzzo')).toHaveLength(0);
  });

  it('matches only in an ingredient name', () => {
    const recipes = [baseRecipe({ id: 'recipe-1', title: 'Zuppa di legumi', ingredientNames: ['Ceci', 'Lenticchie'] })];
    expect(searchRecipes(recipes, 'ceci')).toHaveLength(1);
    expect(searchRecipes(recipes, 'cece')).toHaveLength(0);
  });

  it('matches an ingredient from the shared catalog (pantry adapter)', () => {
    const recipes = [adaptPantryRecipe(RECIPES.find((r) => r.id === 'insalata-ceci-tonno')!)];
    expect(searchRecipes(recipes, 'tonno')).toHaveLength(1);
    expect(searchRecipes(recipes, 'ceci')).toHaveLength(1);
  });

  it('returns an empty array when nothing matches', () => {
    const recipes = [baseRecipe(), baseRecipe({ id: 'recipe-2', title: 'Pasta al pomodoro' })];
    expect(searchRecipes(recipes, 'merluzzo')).toEqual([]);
  });

  it('ignores extra whitespace in the query', () => {
    const recipes = [baseRecipe()];
    expect(searchRecipes(recipes, '  pollo  ')).toHaveLength(1);
    expect(searchRecipes(recipes, 'pollo')).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const recipes = [baseRecipe(), baseRecipe({ id: 'recipe-2' })];
    searchRecipes(recipes, 'pollo');
    expect(recipes).toHaveLength(2);
  });
});

describe('adaptPantryRecipe', () => {
  it('resolves ingredient names from the shared catalog and sets createdAt to null', () => {
    const recipe: PantryRecipe = {
      id: 'pasta-tonno-pomodoro',
      title: 'Pasta tonno e pomodoro',
      description: '',
      category: 'fish',
      durationMinutes: 20,
      difficulty: 'easy',
      servings: 2,
      ingredients: [{ ingredientId: 'tuna', amount: '120 g' }],
      steps: [],
      tags: [],
    };
    const adapted = adaptPantryRecipe(recipe);
    expect(adapted.ingredientNames).toContain('Tonno');
    expect(adapted.createdAt).toBeNull();
    expect(adapted.id).toBe('pasta-tonno-pomodoro');
  });
});

describe('adaptGeneratedRecipe', () => {
  it('uses ingredient names directly and preserves createdAt', () => {
    const recipe: GeneratedRecipe = {
      id: 'gen-1',
      title: 'Torta di mele',
      description: '',
      ingredients: [{ name: 'Mele', amount: '3' }, { name: 'Farina', amount: '200 g' }],
      steps: [],
      diets: [],
      allergens: [],
      source: 'ai',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const adapted = adaptGeneratedRecipe(recipe);
    expect(adapted.ingredientNames).toEqual(['Mele', 'Farina']);
    expect(adapted.createdAt).toBe('2026-01-01T00:00:00Z');
  });
});
