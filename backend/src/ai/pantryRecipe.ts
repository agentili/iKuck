import type { DietProfilePayload, DietType, EuAllergen, GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import {
  INGREDIENTS,
  getIngredient,
  inferIngredientCategory,
  normalizeIngredientName,
  parseIngredientInput,
  type IngredientCategory,
} from '@ikuck/shared/ingredients';
import {
  GENERATED_RECIPE_DESCRIPTION_MAX_LENGTH,
  GENERATED_RECIPE_STEP_MAX_LENGTH,
  GENERATED_RECIPE_TITLE_MAX_LENGTH,
  RECIPE_MAX_INGREDIENTS,
} from '@ikuck/shared/limits';
import { findRecipeNoveltyConflict, type RecipeReference } from './recipeNovelty.js';
import { isGeneratedRecipeCompatible } from './validation.js';

const MAX_RULE_BASED_CANDIDATES = 64;

const PREPARATIONS = [
  { titlePrefix: 'Padellata di', description: 'Una ricetta semplice cotta in padella' },
  { titlePrefix: 'Teglia di', description: 'Una preparazione casalinga al forno' },
  { titlePrefix: 'Piatto rustico con', description: 'Un piatto rustico da condividere' },
  { titlePrefix: 'Ricetta semplice con', description: 'Una ricetta essenziale da preparare' },
] as const;

const diets: readonly DietType[] = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'];
const allergens: readonly EuAllergen[] = [
  'gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk',
  'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs',
];
const connectors = new Set(['a', 'al', 'alla', 'alle', 'd', 'da', 'dal', 'dalla', 'dei', 'del', 'della', 'delle', 'di', 'e', 'in']);
const safeStapleIds = new Set(['water', 'salt', 'black_pepper', 'olive_oil']);
// Audit new catalog identities before allowing inferred allergen absence.
const explicitIngredientFactIds = new Set([
  'water', 'salt', 'black_pepper', 'olive_oil',
  'pasta', 'rice', 'couscous', 'breadcrumbs',
  'chicken_breast', 'beef_strips', 'ground_beef', 'turkey_breast', 'pancetta',
  'tuna', 'cod', 'salmon', 'eggs',
  'chickpeas', 'lentils', 'cannellini_beans', 'peas',
  'lemon', 'arugula', 'tomato', 'tomato_sauce', 'cherry_tomatoes', 'olives',
  'zucchini', 'bell_peppers', 'spinach', 'eggplant', 'carrots', 'celery',
  'onion', 'garlic', 'parsley', 'basil', 'potatoes', 'parmesan', 'milk',
]);
// Shared pantry aliases are identity shortcuts, not evidence of a product's full composition.
const unclassifiedIngredientFactAliases = new Set([
  'sugo', 'passata',
  'olio', 'olio d oliva', 'olio extravergine', 'olio evo',
  'pasta', 'spaghetti', 'penne', 'couscous', 'pangrattato', 'pane grattugiato',
  'fagioli',
]);
// Pantry normalization discards which alias was entered. Block the whole base-catalog
// equivalence class: a canonical label cannot recover missing composition evidence.
const unclassifiedIngredientDefinitions = INGREDIENTS.filter((ingredient) =>
  [ingredient.label, ...ingredient.aliases].some((alias) =>
    unclassifiedIngredientFactAliases.has(normalizeIngredientName(alias))));
const unclassifiedIngredientFactIds = new Set(unclassifiedIngredientDefinitions.map(({ id }) => id));
const unclassifiedIngredientFactLabels = [...new Set([
  ...unclassifiedIngredientFactAliases,
  ...unclassifiedIngredientDefinitions.flatMap(({ label, aliases }) =>
    [label, ...aliases].map(normalizeIngredientName)),
])];
const crustaceanNames = new Set(['gambero', 'gamberi', 'granchio', 'scampi', 'astice', 'aragosta']);
const molluscNames = new Set(['calamaro', 'seppia', 'polpo', 'cozza', 'cozze', 'vongola', 'vongole']);
const fishNames = new Set(['tonno', 'salmone', 'merluzzo', 'orata', 'spigola', 'trota', 'pesce', 'nasello', 'sgombro', 'acciuga', 'alici', 'sarde', 'aringa', 'sogliola', 'rombo', 'dentice']);
const treeNutNames = new Set(['mandorla', 'mandorle', 'noce', 'noci', 'nocciola', 'nocciole', 'pinolo', 'pinoli', 'pistacchio', 'pistacchi', 'anacardo', 'anacardi']);
const processedMeatNames = new Set(['pancetta', 'guanciale', 'prosciutto', 'salame', 'salsiccia', 'wurstel', 'speck', 'bresaola', 'mortadella']);
const driedFruitNames = new Set(['uvetta', 'datteri', 'prugne', 'albicocche']);
const explicitIngredientFactNames = new Set([
  ...crustaceanNames,
  ...molluscNames,
  ...fishNames,
  ...treeNutNames,
  ...processedMeatNames,
  ...driedFruitNames,
  'arachide', 'arachidi', 'senape', 'sesamo',
]);

interface ClassifiedIngredient {
  category: IngredientCategory;
  allergens: EuAllergen[];
}

/** The shared catalog is category-only; ambiguous and unsupported labels must not imply diet safety. */
const classifyPantryIngredient = (name: string): ClassifiedIngredient | null => {
  const normalized = normalizeIngredientName(name);
  if (normalized.length === 0) return null;
  if (unclassifiedIngredientFactLabels.some((label) => ` ${normalized} `.includes(` ${label} `))) return null;
  const tokens = normalized.split(' ');
  const parsedInput = parseIngredientInput(name);
  if (parsedInput.length !== 1) return null;
  const knownInput = parsedInput[0]?.known ? parsedInput[0] : undefined;
  const known = knownInput === undefined ? undefined : getIngredient(knownInput.id);
  const ingredientTokens = tokens.filter((token) => !/^\d+$/.test(token) && !connectors.has(token));
  const hasExplicitIngredientFacts = (known !== undefined
    && explicitIngredientFactIds.has(known.id)
    && !unclassifiedIngredientFactIds.has(known.id)
    && !unclassifiedIngredientFactAliases.has(normalized))
    || (ingredientTokens.length > 0 && ingredientTokens.every((token) => {
      if (unclassifiedIngredientFactAliases.has(token)) return false;
      const parsedToken = parseIngredientInput(token)[0];
      return parsedToken?.known === true
        && explicitIngredientFactIds.has(parsedToken.id)
        && !unclassifiedIngredientFactIds.has(parsedToken.id)
        || explicitIngredientFactNames.has(token);
    }));
  if (!hasExplicitIngredientFacts) return null;

  let category = known?.category;
  if (category === undefined) {
    for (const token of tokens) {
      if (/^\d+$/.test(token) || connectors.has(token)) continue;
      const inferred = inferIngredientCategory(token);
      if (inferred === undefined || category !== undefined && category !== inferred) return null;
      category = inferred;
    }
  }
  if (category === undefined || category === 'other' || category === 'sweet' || category === 'baking' || category === 'drink') return null;
  if (category === 'staple' && (known === undefined || !safeStapleIds.has(known.id))) return null;

  const words = new Set(tokens);
  let ingredientAllergens: EuAllergen[] = [];
  switch (category) {
    case 'fish': {
      const seafoodAllergens = new Set<EuAllergen>();
      if ([...words].some((word) => crustaceanNames.has(word))) seafoodAllergens.add('crustaceans');
      if ([...words].some((word) => molluscNames.has(word))) seafoodAllergens.add('molluscs');
      if ([...words].some((word) => fishNames.has(word)) || seafoodAllergens.size === 0) seafoodAllergens.add('fish');
      ingredientAllergens = [...seafoodAllergens];
      break;
    }
    case 'egg':
      ingredientAllergens = ['eggs'];
      break;
    case 'dairy':
      ingredientAllergens = ['milk'];
      break;
    case 'nuts': {
      const nutAllergens = new Set<EuAllergen>();
      if (words.has('arachide') || words.has('arachidi')) nutAllergens.add('peanuts');
      if ([...words].some((word) => treeNutNames.has(word)) || nutAllergens.size === 0) nutAllergens.add('nuts');
      ingredientAllergens = [...nutAllergens];
      break;
    }
    case 'grain':
      ingredientAllergens = known?.id === 'rice' ? [] : ['gluten'];
      break;
    case 'legume': {
      const legumeAllergens: EuAllergen[] = [];
      if (words.has('soia') || words.has('edamame')) legumeAllergens.push('soybeans');
      if (words.has('lupino') || words.has('lupini')) legumeAllergens.push('lupin');
      if (words.has('arachide') || words.has('arachidi')) legumeAllergens.push('peanuts');
      ingredientAllergens = legumeAllergens;
      break;
    }
    case 'vegetable':
      ingredientAllergens = known?.id === 'celery' || ingredientTokens.some((token) => {
        const parsedToken = parseIngredientInput(token)[0];
        return parsedToken?.known === true && parsedToken.id === 'celery';
      }) ? ['celery'] : [];
      break;
    case 'meat':
      ingredientAllergens = [...words].some((word) => processedMeatNames.has(word)) ? ['sulphites'] : [];
      break;
    case 'fruit':
      ingredientAllergens = [...words].some((word) => driedFruitNames.has(word)) ? ['sulphites'] : [];
      break;
    case 'spice':
      ingredientAllergens = words.has('senape') ? ['mustard'] : words.has('sesamo') ? ['sesame'] : [];
      break;
    case 'staple':
      break;
    default:
      return null;
  }
  return { category, allergens: ingredientAllergens };
};

const classifyRecipeIngredients = (names: string[]): { diets: DietType[]; allergens: EuAllergen[] } | null => {
  const classified = names.map(classifyPantryIngredient);
  if (classified.some((ingredient) => ingredient === null)) return null;
  const ingredients = classified.filter((ingredient): ingredient is ClassifiedIngredient => ingredient !== null);
  const disallowedDiets = new Set<DietType>();
  const foundAllergens = new Set<EuAllergen>();
  for (const ingredient of ingredients) {
    if (ingredient.category === 'meat') {
      disallowedDiets.add('vegetarian');
      disallowedDiets.add('pescatarian');
      disallowedDiets.add('vegan');
    } else if (ingredient.category === 'fish') {
      disallowedDiets.add('vegetarian');
      disallowedDiets.add('vegan');
    } else if (ingredient.category === 'egg' || ingredient.category === 'dairy') {
      disallowedDiets.add('vegan');
    }
    for (const allergen of ingredient.allergens) foundAllergens.add(allergen);
  }
  return {
    diets: diets.filter((diet) => !disallowedDiets.has(diet)),
    allergens: allergens.filter((allergen) => foundAllergens.has(allergen)),
  };
};

const shuffle = <T>(items: T[], random: () => number): T[] => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = Math.max(0, Math.min(random(), 0.999999999));
    const swapIndex = Math.floor(sample * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
};

const candidateCombinations = (ingredients: string[]): string[][] => {
  const combinations: string[][] = [];
  const seen = new Set<string>();

  for (let size = ingredients.length; size > 0 && combinations.length < MAX_RULE_BASED_CANDIDATES; size -= 1) {
    for (let offset = 0; offset < ingredients.length && combinations.length < MAX_RULE_BASED_CANDIDATES; offset += 1) {
      const combination = Array.from({ length: size }, (_value, index) => ingredients[(offset + index) % ingredients.length]!);
      const key = JSON.stringify(combination.map((name) => name.normalize('NFD').toLocaleLowerCase('it-IT')).sort());
      if (seen.has(key)) continue;
      seen.add(key);
      combinations.push(combination);
    }
  }

  return combinations;
};

/** Builds a private, local-only draft and rejects every saved recipe conflict. */
export const generatePantryRecipeDraft = (
  pantryIngredients: string[],
  existingRecipes: RecipeReference[],
  random: () => number = Math.random,
  dietProfile?: DietProfilePayload,
): GeneratedRecipeDraft | null => {
  const uniqueIngredients = [...new Map(
    pantryIngredients
      .map((name) => name.trim())
      .filter((name) => {
        if (name.length === 0 || name.length > 120) return false;
        const classification = classifyRecipeIngredients([name]);
        return classification !== null
          && (dietProfile === undefined || isGeneratedRecipeCompatible(classification, dietProfile));
      })
      .map((name) => [name.normalize('NFD').toLocaleLowerCase('it-IT'), name] as const),
  ).values()].slice(0, RECIPE_MAX_INGREDIENTS);
  if (uniqueIngredients.length === 0) return null;

  const combinations = candidateCombinations(shuffle(uniqueIngredients, random));
  for (const [index, names] of combinations.entries()) {
    const classification = classifyRecipeIngredients(names);
    if (classification === null) continue;
    const preparation = PREPARATIONS[index % PREPARATIONS.length]!;
    const displayNames = names.join(', ');
    const titleNames = names.slice(0, 2).join(' e ');
    const candidate: GeneratedRecipeDraft = {
      title: `${preparation.titlePrefix} ${titleNames}`.slice(0, GENERATED_RECIPE_TITLE_MAX_LENGTH),
      description: `${preparation.description} con ${displayNames}.`.slice(0, GENERATED_RECIPE_DESCRIPTION_MAX_LENGTH),
      ingredients: names.map((name) => ({ name, amount: 'q.b.' })),
      steps: [
        `Prepara gli ingredienti: ${displayNames}.`.slice(0, GENERATED_RECIPE_STEP_MAX_LENGTH),
        'Cuoci gli ingredienti insieme finché raggiungono la cottura desiderata, mescolando quando serve.',
        'Regola il condimento a piacere e servi.',
      ],
      diets: classification.diets,
      allergens: classification.allergens,
    };
    if (dietProfile !== undefined && !isGeneratedRecipeCompatible(candidate, dietProfile)) continue;
    if (findRecipeNoveltyConflict(candidate, existingRecipes) === null) return candidate;
  }

  return null;
};
