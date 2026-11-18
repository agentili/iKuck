import { describe, expect, it } from 'vitest';
import { parseIngredientInput, registerIngredient } from '@ikuck/shared/ingredients';
import {
  GENERATED_RECIPE_DESCRIPTION_MAX_LENGTH,
  GENERATED_RECIPE_STEP_MAX_LENGTH,
  GENERATED_RECIPE_TITLE_MAX_LENGTH,
  RECIPE_MAX_INGREDIENTS,
} from '@ikuck/shared/limits';
import type { DietProfilePayload } from '@ikuck/shared/contracts';
import type { RecipeReference } from './recipeNovelty.js';
import { generatePantryRecipeDraft } from './pantryRecipe.js';
import { parseGeneratedRecipeDraft } from './validation.js';

const sulphiteExcludingProfile: DietProfilePayload = {
  diet: 'omnivore',
  excludedAllergens: ['sulphites'],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

describe('generatePantryRecipeDraft', () => {
  it('creates a structured suggestion from known pantry ingredients', () => {
    const recipe = generatePantryRecipeDraft(['Orata', 'Patate'], [], () => 0);

    expect(recipe).toMatchObject({
      title: 'Padellata di Patate e Orata',
      ingredients: [
        { name: 'Patate', amount: 'q.b.' },
        { name: 'Orata', amount: 'q.b.' },
      ],
      diets: ['omnivore', 'pescatarian'],
      allergens: ['fish'],
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

  it('keeps fallback drafts saveable for 31 to 100 long pantry ingredients', () => {
    const ingredients = Array.from({ length: 100 }, (_value, index) => `${'Pomodoro '.repeat(12)}${index}`);
    const recipe = generatePantryRecipeDraft(ingredients, [], () => 0);

    expect(recipe).not.toBeNull();
    expect(recipe?.ingredients).toHaveLength(RECIPE_MAX_INGREDIENTS);
    expect(recipe?.title.length).toBeLessThanOrEqual(GENERATED_RECIPE_TITLE_MAX_LENGTH);
    expect(recipe?.description.length).toBeLessThanOrEqual(GENERATED_RECIPE_DESCRIPTION_MAX_LENGTH);
    expect(recipe?.steps.every((step) => step.length <= GENERATED_RECIPE_STEP_MAX_LENGTH)).toBe(true);
    expect(parseGeneratedRecipeDraft(recipe)).not.toBeNull();
  });

  it('selects a matching vegan fallback combination when the pantry also contains meat', () => {
    const profile: DietProfilePayload = {
      diet: 'vegan',
      excludedAllergens: [],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    };
    const recipe = generatePantryRecipeDraft(['Pollo', 'Ceci'], [], () => 0, profile);

    expect(recipe?.diets).toContain('vegan');
    expect(recipe?.ingredients.map(({ name }) => name)).toEqual(['Ceci']);
  });

  it('considers the compatible subset before the bounded combination search', () => {
    const safe = [
      'Acqua', 'Sale', 'Pepe', 'Riso', 'Ceci', 'Lenticchie', 'Piselli', 'Limone',
      'Rucola', 'Pomodoro', 'Pomodorini', 'Olive', 'Zucchine', 'Peperoni', 'Spinaci',
      'Melanzane', 'Carote', 'Sedano', 'Cipolla', 'Aglio', 'Prezzemolo', 'Basilico', 'Patate',
    ];
    const mixed = [
      ...safe.slice(0, 4), 'Pollo', ...safe.slice(4, 11), 'Tacchino',
      ...safe.slice(11, 18), 'Manzo', ...safe.slice(18),
    ];
    const recipe = generatePantryRecipeDraft(mixed, [], () => 0.99, {
      diet: 'vegan', excludedAllergens: [],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    });

    expect(recipe).not.toBeNull();
    expect(recipe?.ingredients.map(({ name }) => name)).toEqual(safe);
    expect(parseGeneratedRecipeDraft(recipe)).not.toBeNull();
  });

  it('filters excluded allergens before applying the recipe ingredient limit', () => {
    const ingredients = [...Array.from({ length: 30 }, (_, index) => `Latte ${index}`), 'Riso'];
    const recipe = generatePantryRecipeDraft(ingredients, [], () => 0.99, {
      diet: 'omnivore', excludedAllergens: ['milk'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    });

    expect(recipe?.ingredients).toEqual([{ name: 'Riso', amount: 'q.b.' }]);
  });

  it('fails closed when an ingredient has no known diet and allergen classification', () => {
    expect(generatePantryRecipeDraft(['Ingrediente senza classificazione'], [], () => 0)).toBeNull();
  });

  it('fails closed when category inference has no explicit allergen facts', () => {
    expect(generatePantryRecipeDraft(['Curry'], [], () => 0)).toBeNull();
  });

  it('does not treat generic Sugo as vegan or celery-free', () => {
    const profile: DietProfilePayload = {
      diet: 'vegan',
      excludedAllergens: ['celery'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    };

    expect(generatePantryRecipeDraft(['Sugo'], [], () => 0, profile)).toBeNull();
  });

  it.each([
    'Olio',
    'Fagioli e ceci',
    'Pasta',
    'Spaghetti',
    'Penne',
    'Couscous',
    'Pangrattato',
    'Pane grattugiato',
    'Fagioli',
  ])('fails closed for the ambiguous pantry label %s', (ingredient) => {
    const profile: DietProfilePayload = {
      diet: 'vegan',
      excludedAllergens: ['celery'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    };

    expect(generatePantryRecipeDraft([ingredient], [], () => 0, profile)).toBeNull();
  });

  it.each([
    ['Riso', ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], []],
    ['Pomodoro', ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], []],
    ['Ceci', ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], []],
    ['Sedano', ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], ['celery']],
    ['Latte', ['omnivore', 'vegetarian', 'pescatarian'], ['milk']],
    ['Uova', ['omnivore', 'vegetarian', 'pescatarian'], ['eggs']],
  ] as const)(
    'retains explicit safety facts for %s',
    (ingredient, expectedDiets, expectedAllergens) => {
      const recipe = generatePantryRecipeDraft([ingredient], [], () => 0);

      expect(recipe).not.toBeNull();
      expect(recipe?.diets).toEqual(expectedDiets);
      expect(recipe?.allergens).toEqual(expectedAllergens);
    },
  );

  it('preserves the shared Sugo pantry identity while keeping its recipe facts untrusted', () => {
    expect(parseIngredientInput('Sugo')).toMatchObject([{ id: 'tomato_sauce', known: true }]);
  });

  it.each([
    ['sugo', 'tomato_sauce'],
    ['passata', 'tomato_sauce'],
    ['olio', 'olive_oil'],
    ['olio d oliva', 'olive_oil'],
    ['olio extravergine', 'olive_oil'],
    ['olio evo', 'olive_oil'],
    ['pasta', 'pasta'],
    ['spaghetti', 'pasta'],
    ['penne', 'pasta'],
    ['couscous', 'couscous'],
    ['pangrattato', 'breadcrumbs'],
    ['pane grattugiato', 'breadcrumbs'],
    ['fagioli', 'cannellini_beans'],
  ])('rejects the Home-normalized identity for ambiguous alias %s', (input, id) => {
    const pantry = parseIngredientInput(input);
    expect(pantry).toMatchObject([{ id, known: true }]);
    expect(generatePantryRecipeDraft(pantry.map(({ label }) => label), [], () => 0, {
      diet: 'vegan',
      excludedAllergens: ['celery'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    })).toBeNull();
  });

  it.each([
    'Passata di pomodoro e ceci',
    'Olio extravergine di oliva e riso',
    'Fagioli cannellini e ceci',
    'Pasta e riso',
    'Cous cous e ceci',
    'Pangrattato e ceci',
  ])('does not trust a blocked identity inside the compound label %s', (input) => {
    expect(generatePantryRecipeDraft(parseIngredientInput(input).map(({ label }) => label), [], () => 0)).toBeNull();
  });

  it('uses a safe subset after Home normalizes an ambiguous pantry alias', () => {
    const pantry = parseIngredientInput('Sugo, Riso');
    const recipe = generatePantryRecipeDraft(pantry.map(({ label }) => label), [], () => 0, {
      diet: 'vegan',
      excludedAllergens: ['celery'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    });

    expect(recipe).not.toBeNull();
    expect(recipe?.ingredients).toEqual([{ name: 'Riso', amount: 'q.b.' }]);
    expect(recipe?.diets).toContain('vegan');
  });

  it('fails closed for custom catalog entries without explicit allergen facts', () => {
    registerIngredient({
      id: 'recipe-test-unknown-allergen-facts',
      label: 'Ingrediente custom senza allergeni noti',
      aliases: ['ingrediente custom senza allergeni noti'],
      category: 'vegetable',
      easyToFind: true,
      staple: false,
    });

    expect(generatePantryRecipeDraft(['Ingrediente custom senza allergeni noti'], [], () => 0)).toBeNull();
  });

  it('fails closed when one pantry label combines separately classified ingredients', () => {
    expect(generatePantryRecipeDraft(['Orata, Patate'], [], () => 0)).toBeNull();
  });

  it('fails closed for pantry categories with unknown diet status', () => {
    expect(generatePantryRecipeDraft(['Vino'], [], () => 0)).toBeNull();
  });

  it('keeps each seafood allergen when one label names more than one seafood family', () => {
    const recipe = generatePantryRecipeDraft(['Gambero e cozze'], [], () => 0);

    expect(recipe?.allergens).toEqual(['crustaceans', 'molluscs']);
  });

  it('keeps both peanut and tree-nut allergens when one label names both', () => {
    const recipe = generatePantryRecipeDraft(['Arachidi e mandorle'], [], () => 0);

    expect(recipe?.allergens).toEqual(['peanuts', 'nuts']);
  });

  it.each(['Uvetta', 'Datteri'])(
    'rejects the dried-fruit label %s when sulphites are excluded',
    (ingredient) => {
      expect(generatePantryRecipeDraft([ingredient], [], () => 0, sulphiteExcludingProfile)).toBeNull();
    },
  );

  it.each(['Prugne secche', 'Albicocche secche'])(
    'keeps the unsupported dried-fruit label %s fail-closed',
    (ingredient) => {
      expect(generatePantryRecipeDraft([ingredient], [], () => 0)).toBeNull();
      expect(generatePantryRecipeDraft([ingredient], [], () => 0, sulphiteExcludingProfile)).toBeNull();
    },
  );

  it.each(['Uvetta', 'Datteri'])(
    'preserves the dried-fruit sulphite fact through pantry normalization for %s',
    (ingredient) => {
      const parsed = parseIngredientInput(ingredient);
      expect(parsed).toMatchObject([{ label: ingredient, known: false }]);

      const labels = parsed.map(({ label }) => label);
      const recipe = generatePantryRecipeDraft(labels, [], () => 0);

      expect(recipe).not.toBeNull();
      expect(recipe?.allergens).toContain('sulphites');
      expect(generatePantryRecipeDraft(labels, [], () => 0, sulphiteExcludingProfile)).toBeNull();
    },
  );

  it.each(['Prugne secche', 'Albicocche secche'])(
    'keeps normalized unsupported dried-fruit label %s fail-closed',
    (ingredient) => {
      const parsed = parseIngredientInput(ingredient);
      expect(parsed).toMatchObject([{ label: ingredient, known: false }]);

      const labels = parsed.map(({ label }) => label);
      expect(generatePantryRecipeDraft(labels, [], () => 0)).toBeNull();
      expect(generatePantryRecipeDraft(labels, [], () => 0, sulphiteExcludingProfile)).toBeNull();
    },
  );

  it.each(['Uvetta e Datteri', 'Uvetta e Mandorle'])(
    'retains the sulphite fact from a compound dried-fruit label %s',
    (ingredient) => {
      const recipe = generatePantryRecipeDraft([ingredient], [], () => 0);

      expect(recipe?.allergens).toContain('sulphites');
      expect(generatePantryRecipeDraft([ingredient], [], () => 0, sulphiteExcludingProfile)).toBeNull();
    },
  );

  it.each([
    { source: 'raw', ingredients: ['Uvetta', 'Riso'] },
    { source: 'Home-normalized', ingredients: parseIngredientInput('Uvetta, Riso').map(({ label }) => label) },
  ])('uses only Riso from a mixed $source pantry when sulphites are excluded', ({ ingredients }) => {
    const recipe = generatePantryRecipeDraft(ingredients, [], () => 0, sulphiteExcludingProfile);

    expect(recipe).not.toBeNull();
    expect(recipe?.ingredients.map(({ name }) => name)).toEqual(['Riso']);
  });

  it.each([
    ['Mandorle', ['nuts']],
    ['Arachidi', ['peanuts']],
    ['Arachidi e mandorle', ['peanuts', 'nuts']],
  ] as const)('preserves ordinary nut allergen facts for %s', (ingredient, expectedAllergens) => {
    const recipe = generatePantryRecipeDraft([ingredient], [], () => 0);

    expect(recipe?.allergens).toEqual(expectedAllergens);
    expect(recipe?.allergens).not.toContain('sulphites');
  });

  it('rejects a compound celery label when celery is excluded', () => {
    const profile: DietProfilePayload = {
      diet: 'vegan',
      excludedAllergens: ['celery'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    };

    expect(generatePantryRecipeDraft(['Sedano e carote'], [], () => 0, profile)).toBeNull();
  });

  it('preserves the known celery allergen inside a compound label', () => {
    const recipe = generatePantryRecipeDraft(['Sedano e carote'], [], () => 0);

    expect(recipe?.allergens).toContain('celery');
  });
});
