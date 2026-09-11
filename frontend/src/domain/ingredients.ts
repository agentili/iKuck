import type { IngredientDefinition, ParsedIngredient } from './types';

export const INGREDIENTS: readonly IngredientDefinition[] = [
  { id: 'water', label: 'Acqua', aliases: ['acqua'], category: 'staple', easyToFind: true, staple: true },
  { id: 'salt', label: 'Sale', aliases: ['sale'], category: 'staple', easyToFind: true, staple: true },
  { id: 'black_pepper', label: 'Pepe', aliases: ['pepe', 'pepe nero'], category: 'staple', easyToFind: true, staple: true },
  { id: 'olive_oil', label: 'Olio extravergine di oliva', aliases: ['olio', 'olio d oliva', 'olio extravergine', 'olio evo'], category: 'staple', easyToFind: true, staple: true },
  { id: 'pasta', label: 'Pasta', aliases: ['pasta', 'spaghetti', 'penne'], category: 'grain', easyToFind: true, staple: false },
  { id: 'rice', label: 'Riso', aliases: ['riso'], category: 'grain', easyToFind: true, staple: false },
  { id: 'couscous', label: 'Cous cous', aliases: ['cous cous', 'couscous'], category: 'grain', easyToFind: true, staple: false },
  { id: 'breadcrumbs', label: 'Pangrattato', aliases: ['pangrattato', 'pane grattugiato'], category: 'grain', easyToFind: true, staple: false },
  { id: 'chicken_breast', label: 'Petto di pollo', aliases: ['pollo', 'petto di pollo'], category: 'meat', easyToFind: false, staple: false },
  { id: 'beef_strips', label: 'Straccetti di manzo', aliases: ['manzo', 'straccetti', 'straccetti di manzo'], category: 'meat', easyToFind: false, staple: false },
  { id: 'ground_beef', label: 'Carne macinata', aliases: ['macinato', 'carne macinata', 'macinato di manzo'], category: 'meat', easyToFind: false, staple: false },
  { id: 'turkey_breast', label: 'Petto di tacchino', aliases: ['tacchino', 'petto di tacchino'], category: 'meat', easyToFind: false, staple: false },
  { id: 'pancetta', label: 'Pancetta', aliases: ['pancetta', 'guanciale'], category: 'meat', easyToFind: true, staple: false },
  { id: 'tuna', label: 'Tonno', aliases: ['tonno', 'tonno in scatola'], category: 'fish', easyToFind: true, staple: false },
  { id: 'cod', label: 'Merluzzo', aliases: ['merluzzo'], category: 'fish', easyToFind: false, staple: false },
  { id: 'salmon', label: 'Salmone', aliases: ['salmone'], category: 'fish', easyToFind: false, staple: false },
  { id: 'eggs', label: 'Uova', aliases: ['uovo', 'uova'], category: 'egg', easyToFind: true, staple: false },
  { id: 'chickpeas', label: 'Ceci', aliases: ['cece', 'ceci'], category: 'legume', easyToFind: true, staple: false },
  { id: 'lentils', label: 'Lenticchie', aliases: ['lenticchia', 'lenticchie'], category: 'legume', easyToFind: true, staple: false },
  { id: 'cannellini_beans', label: 'Fagioli cannellini', aliases: ['fagioli', 'cannellini', 'fagioli cannellini'], category: 'legume', easyToFind: true, staple: false },
  { id: 'peas', label: 'Piselli', aliases: ['pisello', 'piselli'], category: 'legume', easyToFind: true, staple: false },
  { id: 'lemon', label: 'Limone', aliases: ['limone', 'limoni'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'arugula', label: 'Rucola', aliases: ['rucola'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'tomato', label: 'Pomodoro', aliases: ['pomodoro', 'pomodori'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'tomato_sauce', label: 'Passata di pomodoro', aliases: ['passata', 'sugo', 'passata di pomodoro'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'cherry_tomatoes', label: 'Pomodorini', aliases: ['pomodorino', 'pomodorini'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'olives', label: 'Olive', aliases: ['oliva', 'olive'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'zucchini', label: 'Zucchine', aliases: ['zucchina', 'zucchine'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'bell_peppers', label: 'Peperoni', aliases: ['peperone', 'peperoni'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'spinach', label: 'Spinaci', aliases: ['spinacio', 'spinaci'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'eggplant', label: 'Melanzane', aliases: ['melanzana', 'melanzane'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'carrots', label: 'Carote', aliases: ['carota', 'carote'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'celery', label: 'Sedano', aliases: ['sedano'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'onion', label: 'Cipolla', aliases: ['cipolla', 'cipolle'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'garlic', label: 'Aglio', aliases: ['aglio'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'parsley', label: 'Prezzemolo', aliases: ['prezzemolo'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'basil', label: 'Basilico', aliases: ['basilico'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'potatoes', label: 'Patate', aliases: ['patata', 'patate'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'parmesan', label: 'Parmigiano', aliases: ['parmigiano', 'grana'], category: 'dairy', easyToFind: true, staple: false },
  { id: 'milk', label: 'Latte', aliases: ['latte'], category: 'dairy', easyToFind: true, staple: false },
];

export const DEFAULT_STAPLE_IDS = ['water', 'salt', 'black_pepper', 'olive_oil'] as const;

export const normalizeIngredientName = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[’']/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const ingredientsById = new Map(INGREDIENTS.map((ingredient) => [ingredient.id, ingredient]));
const ingredientsByAlias = new Map<string, IngredientDefinition>();

for (const ingredient of INGREDIENTS) {
  for (const candidate of [ingredient.label, ...ingredient.aliases]) {
    ingredientsByAlias.set(normalizeIngredientName(candidate), ingredient);
  }
}

export const getIngredient = (id: string): IngredientDefinition | undefined =>
  ingredientsById.get(id);

export const parseIngredientInput = (value: string): ParsedIngredient[] => {
  const parsed = value
    .split(/[,;\n]/)
    .map((token) => token.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map((token): ParsedIngredient | null => {
      const normalized = normalizeIngredientName(token);
      if (!normalized) return null;

      const knownIngredient = ingredientsByAlias.get(normalized);
      if (knownIngredient) {
        return { id: knownIngredient.id, label: knownIngredient.label, known: true };
      }

      return {
        id: `custom:${normalized.replace(/\s+/g, '-')}`,
        label: token,
        known: false,
      };
    })
    .filter((ingredient): ingredient is ParsedIngredient => ingredient !== null);

  return [...new Map(parsed.map((ingredient) => [ingredient.id, ingredient])).values()];
};
