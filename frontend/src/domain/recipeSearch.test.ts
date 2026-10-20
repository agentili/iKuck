import { describe, expect, it } from 'vitest';
import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { adaptGeneratedRecipe, adaptPantryRecipe, adaptSavedRecipe, searchRecipes, type SearchableRecipe } from './recipeSearch';
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

describe('adaptSavedRecipe', () => {
  const savedRecipe = (overrides: Partial<SavedRecipe> = {}): SavedRecipe => ({
    id: 'saved-1',
    title: 'Orata al forno',
    description: '',
    ingredients: [
      { name: 'Orata', amount: '1', ingredientId: null, optional: false, provenance: 'provided' },
      { name: 'Patate', amount: '300 g', ingredientId: null, optional: false, provenance: 'provided' },
    ],
    steps: ['Inforna per 20 minuti'],
    servings: 2,
    durationMinutes: null,
    diets: null,
    allergens: null,
    suggestedFields: [],
    source: 'diary',
    authorId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T11:00:00.000Z',
    ...overrides,
  });

  it('converts id, title, ingredient names and createdAt', () => {
    expect(adaptSavedRecipe(savedRecipe())).toEqual({
      id: 'saved-1',
      title: 'Orata al forno',
      ingredientNames: ['Orata', 'Patate'],
      createdAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('returns every adapted recipe when the query is empty or whitespace', () => {
    const recipes = [
      adaptSavedRecipe(savedRecipe()),
      adaptSavedRecipe(savedRecipe({ id: 'saved-2', title: 'Pasta al pesto' })),
    ];
    expect(searchRecipes(recipes, '')).toEqual(recipes);
    expect(searchRecipes(recipes, '   ')).toEqual(recipes);
  });

  it('matches on the title and on an ingredient name (orata)', () => {
    const byTitle = adaptSavedRecipe(
      savedRecipe({
        id: 'saved-title',
        title: 'Orata al forno',
        ingredients: [{ name: 'Patate', amount: '', ingredientId: null, optional: false, provenance: 'provided' }],
      })
    );
    const byIngredient = adaptSavedRecipe(
      savedRecipe({
        id: 'saved-ingredient',
        title: 'Zuppa di pesce',
        ingredients: [{ name: 'Orata', amount: '', ingredientId: null, optional: false, provenance: 'provided' }],
      })
    );
    const recipes = [byTitle, byIngredient];
    expect(searchRecipes(recipes, 'orata')).toHaveLength(2);
    expect(searchRecipes(recipes, 'ORATA').map((recipe) => recipe.id)).toEqual(['saved-title', 'saved-ingredient']);
    expect(searchRecipes(recipes, 'zuppa')).toEqual([byIngredient]);
    expect(searchRecipes(recipes, 'merluzzo')).toEqual([]);
  });

  it('matches an accented title ignoring diacritics (giudìa → giudia)', () => {
    const adapted = adaptSavedRecipe(savedRecipe({ id: 'saved-accent', title: 'Carciofi alla giudìa' }));
    expect(searchRecipes([adapted], 'giudia')).toHaveLength(1);
    expect(searchRecipes([adapted], 'giudìa')).toHaveLength(1);
    expect(searchRecipes([adapted], 'GIUDIA')).toHaveLength(1);
    expect(searchRecipes([adapted], 'carciofi')).toHaveLength(1);
    expect(searchRecipes([adapted], 'giudizio')).toHaveLength(0);
  });

  it('does not mutate the input recipe', () => {
    const recipe = savedRecipe();
    const snapshot = structuredClone(recipe);
    const adapted = adaptSavedRecipe(recipe);
    adapted.ingredientNames.push('Limone');
    adapted.title = 'Titolo riscritto';
    searchRecipes([adapted], 'orata');
    expect(recipe).toEqual(snapshot);
    expect(recipe.ingredients.map((ingredient) => ingredient.name)).toEqual(['Orata', 'Patate']);
  });

  it('does not crash when ingredient.name is undefined', () => {
    const recipe = savedRecipe({
      ingredients: [
        { name: undefined, amount: '', ingredientId: 'tuna', optional: false, provenance: 'provided' },
        { name: undefined, amount: '', ingredientId: null, optional: false, provenance: 'provided' },
      ] as unknown as SavedRecipe['ingredients'],
    });
    const adapted = adaptSavedRecipe(recipe);
    expect(adapted.ingredientNames).toEqual(['Tonno', '']);
    expect(adapted.ingredientNames.every((name) => typeof name === 'string')).toBe(true);
    expect(searchRecipes([adapted], 'tonno')).toHaveLength(1);
    expect(searchRecipes([adapted], '')).toEqual([adapted]);
    expect(searchRecipes([adapted], 'merluzzo')).toEqual([]);
  });
});
