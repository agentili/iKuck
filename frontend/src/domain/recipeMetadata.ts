import type { DietType, EuAllergen, RecipeNutrition } from '@ikuck/shared/contracts';

export interface RecipeMetadata {
  diets: DietType[];
  allergens: EuAllergen[];
  nutrition: RecipeNutrition;
}

const catalogEstimate = (
  caloriesPerServing: number,
  proteinGramsPerServing: number,
  carbohydrateGramsPerServing: number,
  fatGramsPerServing: number,
): RecipeNutrition => ({
  caloriesPerServing,
  proteinGramsPerServing,
  carbohydrateGramsPerServing,
  fatGramsPerServing,
  source: 'catalog_estimate',
  isComplete: false,
  missingNutrients: ['sodium'],
});

const metadata = (
  diets: DietType[],
  allergens: EuAllergen[],
  calories: number,
  protein: number,
  carbohydrates: number,
  fat: number,
): RecipeMetadata => ({
  diets,
  allergens,
  nutrition: catalogEstimate(calories, protein, carbohydrates, fat),
});

const allDiets: DietType[] = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'];
const eggFriendlyDiets: DietType[] = ['omnivore', 'vegetarian', 'pescatarian'];

export const RECIPE_METADATA: Record<string, RecipeMetadata> = {
  'pollo-al-limone': metadata(['omnivore'], [], 390, 50, 8, 18),
  'straccetti-manzo-rucola': metadata(['omnivore'], [], 380, 49, 5, 19),
  'polpette-al-pomodoro': metadata(['omnivore'], ['gluten', 'eggs', 'milk'], 560, 38, 32, 29),
  'tacchino-peperoni': metadata(['omnivore'], [], 330, 45, 15, 12),
  'pasta-tonno-pomodoro': metadata(['omnivore', 'pescatarian'], ['gluten', 'fish'], 560, 30, 78, 14),
  'merluzzo-olive-pomodorini': metadata(['omnivore', 'pescatarian'], ['fish'], 310, 39, 18, 10),
  'salmone-al-limone': metadata(['omnivore', 'pescatarian'], ['fish'], 430, 36, 5, 28),
  'insalata-ceci-tonno': metadata(['omnivore', 'pescatarian'], ['fish'], 390, 32, 43, 10),
  'frittata-zucchine': metadata(eggFriendlyDiets, ['eggs', 'milk'], 350, 27, 8, 24),
  'uova-al-pomodoro': metadata(eggFriendlyDiets, ['eggs'], 260, 24, 16, 13),
  'omelette-spinaci': metadata(eggFriendlyDiets, ['eggs', 'milk'], 390, 31, 9, 25),
  'carbonara-semplice': metadata(['omnivore'], ['gluten', 'eggs', 'milk'], 690, 32, 80, 27),
  'pasta-e-ceci': metadata(allDiets, ['gluten'], 600, 25, 92, 14),
  'lenticchie-in-umido': metadata(allDiets, ['celery'], 330, 21, 48, 8),
  'insalata-fagioli-cipolla': metadata(allDiets, [], 300, 17, 43, 8),
  'burger-di-ceci': metadata(eggFriendlyDiets, ['gluten', 'eggs'], 500, 24, 59, 18),
  'pasta-alla-norma': metadata(allDiets, ['gluten', 'milk'], 560, 17, 90, 17),
  'couscous-verdure': metadata(allDiets, ['gluten'], 420, 14, 74, 9),
  'zuppa-rustica-verdure': metadata(allDiets, ['celery'], 230, 7, 42, 5),
  'riso-zucchine-piselli': metadata(allDiets, ['milk'], 400, 15, 70, 8),
};

export const getRecipeMetadata = (recipeId: string): RecipeMetadata | undefined => RECIPE_METADATA[recipeId];
