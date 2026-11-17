import type { GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { findRecipeNoveltyConflict, type RecipeReference } from './recipeNovelty.js';

const MAX_RULE_BASED_CANDIDATES = 64;

const PREPARATIONS = [
  { titlePrefix: 'Padellata di', description: 'Una ricetta semplice cotta in padella' },
  { titlePrefix: 'Teglia di', description: 'Una preparazione casalinga al forno' },
  { titlePrefix: 'Piatto rustico con', description: 'Un piatto rustico da condividere' },
  { titlePrefix: 'Ricetta semplice con', description: 'Una ricetta essenziale da preparare' },
] as const;

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
): GeneratedRecipeDraft | null => {
  const uniqueIngredients = [...new Map(
    pantryIngredients
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => [name.normalize('NFD').toLocaleLowerCase('it-IT'), name] as const),
  ).values()];
  if (uniqueIngredients.length === 0) return null;

  const combinations = candidateCombinations(shuffle(uniqueIngredients, random));
  for (const [index, names] of combinations.entries()) {
    const preparation = PREPARATIONS[index % PREPARATIONS.length]!;
    const displayNames = names.join(', ');
    const titleNames = names.slice(0, 2).join(' e ');
    const candidate: GeneratedRecipeDraft = {
      title: `${preparation.titlePrefix} ${titleNames}`.slice(0, 240),
      description: `${preparation.description} con ${displayNames}.`.slice(0, 240),
      ingredients: names.map((name) => ({ name, amount: 'q.b.' })),
      steps: [
        `Prepara gli ingredienti: ${displayNames}.`,
        'Cuoci gli ingredienti insieme finché raggiungono la cottura desiderata, mescolando quando serve.',
        'Regola il condimento a piacere e servi.',
      ],
      diets: [],
      allergens: [],
    };
    if (findRecipeNoveltyConflict(candidate, existingRecipes) === null) return candidate;
  }

  return null;
};
