import type {
  DietProfilePayload,
  DietType,
  EuAllergen,
  GeneratedRecipeDraft,
  PantryIngredientAssessment,
  PantryIngredientDisposition,
  PantryIngredientExclusion,
  PantryIngredientReview,
  PantryIngredientReviewReason,
  PantryRecipeIngredientWarning,
} from '@ikuck/shared/contracts';
import { normalizeIngredientName } from '@ikuck/shared/ingredients';
import {
  GENERATED_RECIPE_DESCRIPTION_MAX_LENGTH,
  GENERATED_RECIPE_STEP_MAX_LENGTH,
  GENERATED_RECIPE_TITLE_MAX_LENGTH,
  RECIPE_MAX_INGREDIENTS,
} from '@ikuck/shared/limits';
import {
  euAllergensInOrder,
  isGenericPastaProviderAlias,
  resolveFoodFacts,
  type DietCompatibility,
  type FoodResolution,
} from './foodFacts.js';
import { findRecipeNoveltyConflict, type RecipeReference } from './recipeNovelty.js';
import { isGeneratedRecipeCompatible } from './validation.js';

const MAX_RULE_BASED_CANDIDATES = 64;

const PREPARATIONS = [
  { titlePrefix: 'Padellata di', description: 'Una ricetta semplice cotta in padella' },
  { titlePrefix: 'Teglia di', description: 'Una preparazione casalinga al forno' },
  { titlePrefix: 'Piatto rustico con', description: 'Un piatto rustico da condividere' },
  { titlePrefix: 'Ricetta semplice con', description: 'Una ricetta essenziale da preparare' },
] as const;

interface PantryFoodInput {
  inputIndex: number;
  name: string;
  facts: FoodResolution;
}

interface SourceIssue {
  reason: Extract<PantryIngredientReviewReason, 'composition_unverified' | 'diet_incompatible' | 'excluded_allergen'>;
  allergens?: EuAllergen[];
}

const dietTypes: readonly DietType[] = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'];

const unknownFacts = (name: string): FoodResolution => name.length > 120
  ? resolveFoodFacts('')
  : resolveFoodFacts(name);

const sourceIssue = (facts: FoodResolution, dietProfile?: DietProfilePayload): SourceIssue | null => {
  const blockedAllergens = dietProfile === undefined
    ? []
    : euAllergensInOrder([...facts.presentAllergens, ...facts.possibleAllergens]
      .filter((allergen) => dietProfile.excludedAllergens.includes(allergen)));
  if (blockedAllergens.length > 0) return { reason: 'excluded_allergen', allergens: blockedAllergens };

  if (dietProfile !== undefined) {
    const compatibility = facts.diets[dietProfile.diet];
    if (compatibility === 'incompatible') return { reason: 'diet_incompatible' };
    if (compatibility === 'unknown') return { reason: 'composition_unverified' };
  }

  if (!facts.identityComplete || facts.allergenCoverage === 'unknown') {
    return { reason: 'composition_unverified' };
  }
  if (dietProfile !== undefined
    && dietProfile.excludedAllergens.length > 0
    && facts.allergenCoverage !== 'complete') {
    return { reason: 'composition_unverified' };
  }
  return null;
};

const createPantryInputs = (pantryIngredients: readonly string[]): PantryFoodInput[] =>
  pantryIngredients.flatMap((rawName, inputIndex) => {
    const name = rawName.trim();
    if (name.length === 0) return [];
    return [{ inputIndex, name, facts: unknownFacts(name) }];
  });

const uniqueLocalCandidates = (
  pantryInputs: readonly PantryFoodInput[],
  dietProfile?: DietProfilePayload,
): PantryFoodInput[] => {
  const unique = new Map<string, PantryFoodInput>();
  for (const pantryInput of pantryInputs) {
    if (sourceIssue(pantryInput.facts, dietProfile) !== null
      || !pantryInput.facts.localPreparationSupported) continue;
    const identity = pantryInput.facts.identityKey
      ?? `${normalizeIngredientName(pantryInput.name)}:${pantryInput.inputIndex}`;
    if (!unique.has(identity)) unique.set(identity, pantryInput);
  }
  return [...unique.values()];
};

const classifyRecipeIngredients = (names: readonly string[]): {
  diets: DietType[];
  allergens: EuAllergen[];
} | null => {
  const facts = names.map(resolveFoodFacts);
  if (facts.some((ingredient) => !ingredient.identityComplete
    || ingredient.allergenCoverage === 'unknown'
    || !ingredient.localPreparationSupported)) return null;

  return {
    diets: dietTypes.filter((diet) => facts.every((ingredient) => ingredient.diets[diet] === 'compatible')),
    allergens: euAllergensInOrder(facts.flatMap((ingredient) => [
      ...ingredient.presentAllergens,
      ...ingredient.possibleAllergens,
    ])),
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

/** Bound multi-item proposals, but leave the complete eligible pool for singleton coverage. */
const candidateCombinations = (ingredients: string[]): string[][] => {
  const combinations: string[][] = [];
  const seen = new Set<string>();
  const add = (combination: string[]): void => {
    if (combination.length < 2 || combination.length > RECIPE_MAX_INGREDIENTS) return;
    const key = JSON.stringify(combination.map((name) => normalizeIngredientName(name)).sort());
    if (seen.has(key)) return;
    seen.add(key);
    combinations.push(combination);
  };

  for (let offset = 0; offset < ingredients.length; offset += RECIPE_MAX_INGREDIENTS) {
    add(ingredients.slice(offset, offset + RECIPE_MAX_INGREDIENTS));
  }
  for (let size = Math.min(ingredients.length, RECIPE_MAX_INGREDIENTS);
    size >= 2 && combinations.length < MAX_RULE_BASED_CANDIDATES;
    size -= 1) {
    for (let offset = 0; offset < ingredients.length && combinations.length < MAX_RULE_BASED_CANDIDATES; offset += 1) {
      add(Array.from({ length: size }, (_value, index) => ingredients[(offset + index) % ingredients.length]!));
    }
  }
  return combinations;
};

const mappedOutputIndexes = (
  source: PantryFoodInput,
  outputFacts: readonly FoodResolution[],
  outputNames: readonly string[],
): number[] => {
  if (!source.facts.identityComplete || source.facts.identityParts.length === 0) return [];
  if (source.facts.genericPasta) {
    return outputFacts.flatMap((facts, index) => facts.identityParts.includes('generic-pasta')
      || isGenericPastaProviderAlias(outputNames[index] ?? '') ? [index] : []);
  }

  const availableParts = outputFacts.flatMap((facts) => facts.identityParts);
  const remaining = [...availableParts];
  for (const part of source.facts.identityParts) {
    const found = remaining.indexOf(part);
    if (found < 0) return [];
    remaining.splice(found, 1);
  }

  const sourceParts = new Set(source.facts.identityParts);
  return outputFacts.flatMap((facts, index) => facts.identityParts.some((part) => sourceParts.has(part)) ? [index] : []);
};

const createReview = (
  pantryInputs: readonly PantryFoodInput[],
  resultSource: PantryIngredientReview['resultSource'],
  dietProfile: DietProfilePayload | undefined,
  usedOutputIndexes: ReadonlyMap<number, readonly number[]>,
  recipeIngredientCount: number,
  eligibleLocalCandidateCount: number,
  searchExhausted: boolean,
): PantryIngredientReview => {
  const assessments: PantryIngredientAssessment[] = pantryInputs.map((pantryInput, sourceIndex) => {
    const { facts } = pantryInput;
    const issue = sourceIssue(facts, dietProfile);
    const recipeIngredientIndexes = [...(usedOutputIndexes.get(sourceIndex) ?? [])];
    let disposition: PantryIngredientDisposition;
    let reason: PantryIngredientReviewReason | undefined;

    if (issue !== null) {
      disposition = 'excluded';
      reason = issue.reason;
    } else if (recipeIngredientIndexes.length > 0) {
      disposition = 'used';
    } else {
      disposition = 'not_selected';
      if (resultSource === 'local'
        && recipeIngredientCount === RECIPE_MAX_INGREDIENTS
        && eligibleLocalCandidateCount > recipeIngredientCount) {
        reason = 'recipe_limit';
      } else if (resultSource !== 'provider' && !facts.localPreparationSupported) {
        reason = 'local_preparation_unavailable';
      } else if (searchExhausted) {
        reason = 'search_exhausted';
      } else {
        reason = 'not_selected';
      }
    }

    return {
      inputIndex: pantryInput.inputIndex,
      name: pantryInput.name,
      disposition,
      evidence: facts.genericPasta && disposition === 'used' && resultSource === 'provider'
        ? 'provider_declared'
        : facts.evidence,
      allergenCoverage: facts.allergenCoverage,
      presentAllergens: facts.presentAllergens,
      possibleAllergens: facts.possibleAllergens,
      recipeIngredientIndexes,
      ...(reason === undefined ? {} : { reason }),
      ...(facts.genericPasta && disposition === 'used' && resultSource === 'provider'
        ? { warning: "Composizione proposta, non verifica del prodotto: controlla l'etichetta. L'assenza di altri allergeni non è verificata." }
        : {}),
    };
  });

  const excludedIngredients: PantryIngredientExclusion[] = assessments.flatMap<PantryIngredientExclusion>((assessment) => {
    if (assessment.disposition !== 'excluded' || assessment.reason === undefined) return [];
    if (assessment.reason === 'excluded_allergen') {
      const allergens = dietProfile === undefined ? [] : euAllergensInOrder(
        [...assessment.presentAllergens, ...assessment.possibleAllergens]
          .filter((allergen) => dietProfile.excludedAllergens.includes(allergen)),
      );
      return [{ name: assessment.name, reason: 'excluded_allergen', allergens }];
    }
    if (assessment.reason === 'diet_incompatible' || assessment.reason === 'composition_unverified') {
      return [{ name: assessment.name, reason: assessment.reason }];
    }
    return [];
  });

  return {
    resultSource,
    consideredIngredients: pantryInputs.map(({ name }) => name),
    assessments,
    excludedIngredients,
  };
};

const outputIndexesForPantryInputs = (
  pantryInputs: readonly PantryFoodInput[],
  outputFacts: readonly FoodResolution[],
  outputNames: readonly string[],
): Map<number, number[]> => new Map(pantryInputs.flatMap((pantryInput, sourceIndex) => {
  const indexes = mappedOutputIndexes(pantryInput, outputFacts, outputNames);
  return indexes.length === 0 ? [] : [[sourceIndex, indexes]];
}));

const sourceComponents = (source: PantryFoodInput): FoodResolution[] => {
  if (source.facts.identityParts.length < 2) return [source.facts];

  const componentNames = normalizeIngredientName(source.name).split(/\s+e\s+/u).filter(Boolean);
  const components = componentNames.map(resolveFoodFacts);
  const sourceParts = [...source.facts.identityParts].sort();
  const componentParts = components.flatMap((component) => component.identityParts).sort();
  if (components.length < 2
    || components.some((component) => !component.identityComplete)
    || componentParts.length !== sourceParts.length
    || componentParts.some((part, index) => part !== sourceParts[index])) {
    return [source.facts];
  }
  return components;
};

const sourceFactsForOutput = (source: PantryFoodInput, outputFacts: FoodResolution): FoodResolution[] => {
  if (source.facts.genericPasta) return [source.facts];
  const outputParts = new Set(outputFacts.identityParts);
  return sourceComponents(source).filter((component) =>
    component.identityParts.some((part) => outputParts.has(part)));
};

const warningsForProviderIngredients = (
  effectiveFacts: readonly FoodResolution[][],
  outputNames: readonly string[],
): PantryRecipeIngredientWarning[] => {
  return effectiveFacts.flatMap((facts, ingredientIndex) => {
    const allergenCoverage = facts.some((ingredient) => ingredient.allergenCoverage === 'unknown')
      ? 'unknown'
      : facts.some((ingredient) => ingredient.allergenCoverage === 'partial') ? 'partial' : 'complete';
    if (allergenCoverage === 'complete') return [];
    const name = outputNames[ingredientIndex];
    if (name === undefined) return [];
    const presentAllergens = euAllergensInOrder(facts.flatMap((ingredient) => ingredient.presentAllergens));
    const presentSet = new Set(presentAllergens);
    return [{
      ingredientIndex,
      name,
      allergenCoverage,
      presentAllergens,
      possibleAllergens: euAllergensInOrder(facts.flatMap((ingredient) => ingredient.possibleAllergens)
        .filter((allergen) => !presentSet.has(allergen))),
      warning: "Composizione non completamente verificata dal solo nome: controlla l'etichetta. L'assenza di altri allergeni non è verificata.",
    }];
  });
};

export interface PantryRecipeEvaluation {
  recipe: GeneratedRecipeDraft | null;
  ingredientReview: PantryIngredientReview;
}

const emptyReview = (pantryInputs: readonly PantryFoodInput[], dietProfile?: DietProfilePayload): PantryIngredientReview =>
  createReview(pantryInputs, 'none', dietProfile, new Map(), 0, 0, true);

export const reviewPantryIngredients = (
  pantryIngredients: readonly string[],
  dietProfile?: DietProfilePayload,
): PantryIngredientReview => emptyReview(createPantryInputs(pantryIngredients), dietProfile);

const effectiveRecipeFacts = (
  recipe: GeneratedRecipeDraft,
  outputFacts: readonly FoodResolution[],
  pantryInputs: readonly PantryFoodInput[],
  mappings: ReadonlyMap<number, readonly number[]>,
): FoodResolution[][] => outputFacts.map((facts, outputIndex) => {
  const mappedSources = [...mappings.entries()]
    .filter((mapping) => mapping[1].includes(outputIndex))
    .map((mapping) => pantryInputs[mapping[0]]!);
  if (facts.identityComplete) {
    return [facts, ...mappedSources.flatMap((source) => sourceFactsForOutput(source, facts))];
  }
  const name = recipe.ingredients[outputIndex]?.name ?? '';
  if (isGenericPastaProviderAlias(name) && mappedSources.some((source) => source.facts.genericPasta)) {
    return mappedSources.filter((source) => source.facts.genericPasta).map((source) => source.facts);
  }
  return [];
});

const combinedDietStatus = (facts: readonly FoodResolution[], diet: DietType): DietCompatibility => {
  const statuses = facts.map((ingredient) => ingredient.diets[diet]);
  if (statuses.includes('incompatible')) return 'incompatible';
  if (statuses.includes('unknown')) return 'unknown';
  return 'compatible';
};

const declaredAllergensIncompatibleWithDiet: Readonly<Record<DietType, readonly EuAllergen[]>> = {
  omnivore: [],
  vegetarian: ['fish', 'crustaceans', 'molluscs'],
  pescatarian: [],
  vegan: ['milk', 'eggs', 'fish', 'crustaceans', 'molluscs'],
};

const hasDeclaredAllergenIncompatibleWithDiet = (allergens: readonly EuAllergen[], diet: DietType): boolean =>
  allergens.some((allergen) => declaredAllergensIncompatibleWithDiet[diet].includes(allergen));

/** Validate a provider response against the exact final composition and source identities. */
export const evaluateProviderPantryRecipeDraft = (
  pantryIngredients: readonly string[],
  providerDraft: GeneratedRecipeDraft,
  dietProfile?: DietProfilePayload,
): PantryRecipeEvaluation => {
  const pantryInputs = createPantryInputs(pantryIngredients);
  const outputNames = providerDraft.ingredients.map(({ name }) => name);
  const outputFacts = outputNames.map(resolveFoodFacts);
  const mappings = outputIndexesForPantryInputs(pantryInputs, outputFacts, outputNames);

  if (outputFacts.some((facts, index) => !facts.identityComplete
    && !(isGenericPastaProviderAlias(outputNames[index] ?? '')
      && [...mappings.values()].some((indexes) => indexes.includes(index))))) {
    return { recipe: null, ingredientReview: emptyReview(pantryInputs, dietProfile) };
  }
  if (![...mappings.keys()].some((sourceIndex) => pantryInputs[sourceIndex] !== undefined)) {
    return { recipe: null, ingredientReview: emptyReview(pantryInputs, dietProfile) };
  }

  const perIngredientFacts = effectiveRecipeFacts(providerDraft, outputFacts, pantryInputs, mappings);
  if (perIngredientFacts.some((facts) => facts.length === 0)) {
    return { recipe: null, ingredientReview: emptyReview(pantryInputs, dietProfile) };
  }
  const mappedSourceFacts = [...mappings.keys()].map((sourceIndex) => pantryInputs[sourceIndex]!.facts);
  const allFacts = [...perIngredientFacts.flat(), ...mappedSourceFacts];
  const factPresentAllergens = euAllergensInOrder(allFacts.flatMap((facts) => facts.presentAllergens));
  const possibleAllergens = euAllergensInOrder(allFacts.flatMap((facts) => facts.possibleAllergens));
  const allergenCoverage = allFacts.some((facts) => facts.allergenCoverage === 'unknown')
    ? 'unknown'
    : allFacts.some((facts) => facts.allergenCoverage === 'partial') ? 'partial' : 'complete';

  if (factPresentAllergens.some((allergen) => !providerDraft.allergens.includes(allergen))) {
    return { recipe: null, ingredientReview: emptyReview(pantryInputs, dietProfile) };
  }
  const presentAllergens = euAllergensInOrder([...factPresentAllergens, ...providerDraft.allergens]);
  const recipeAllergens = euAllergensInOrder([...presentAllergens, ...possibleAllergens]);
  if (dietProfile !== undefined) {
    const excludedRisks = recipeAllergens.some((allergen) => dietProfile.excludedAllergens.includes(allergen));
    if (excludedRisks || dietProfile.excludedAllergens.length > 0 && allergenCoverage !== 'complete') {
      return { recipe: null, ingredientReview: emptyReview(pantryInputs, dietProfile) };
    }
    if (allFacts.some((facts) => sourceIssue(facts, dietProfile) !== null)) {
      return { recipe: null, ingredientReview: emptyReview(pantryInputs, dietProfile) };
    }
  }

  const contradictoryDietClaim = providerDraft.diets.some((diet) =>
    combinedDietStatus(allFacts, diet) === 'incompatible'
    || hasDeclaredAllergenIncompatibleWithDiet(providerDraft.allergens, diet));
  const supportedDiets = providerDraft.diets.filter((diet) =>
    combinedDietStatus(allFacts, diet) === 'compatible'
    && !hasDeclaredAllergenIncompatibleWithDiet(providerDraft.allergens, diet));
  if (contradictoryDietClaim || supportedDiets.length === 0
    || dietProfile !== undefined && !supportedDiets.includes(dietProfile.diet)) {
    return { recipe: null, ingredientReview: emptyReview(pantryInputs, dietProfile) };
  }

  const recipe: GeneratedRecipeDraft = {
    ...providerDraft,
    diets: supportedDiets,
    allergens: recipeAllergens,
  };
  const ingredientReview = createReview(
    pantryInputs,
    'provider',
    dietProfile,
    mappings,
    recipe.ingredients.length,
    0,
    false,
  );
  const recipeIngredientWarnings = warningsForProviderIngredients(perIngredientFacts, outputNames);
  if (recipeIngredientWarnings.length > 0) ingredientReview.recipeIngredientWarnings = recipeIngredientWarnings;
  return { recipe, ingredientReview };
};

/** Evaluates the complete pantry and builds a private local-only draft when safe. */
export const evaluatePantryRecipeDraft = (
  pantryIngredients: readonly string[],
  existingRecipes: RecipeReference[],
  random: () => number = Math.random,
  dietProfile?: DietProfilePayload,
): PantryRecipeEvaluation => {
  const pantryInputs = createPantryInputs(pantryIngredients);
  const eligibleInputs = uniqueLocalCandidates(pantryInputs, dietProfile);
  const shuffledNames = shuffle(eligibleInputs.map(({ name }) => name), random);
  const candidateNames = [
    ...candidateCombinations(shuffledNames),
    ...shuffledNames.map((name) => [name]),
  ];

  for (const [index, names] of candidateNames.entries()) {
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
    if (findRecipeNoveltyConflict(candidate, existingRecipes) !== null) continue;

    const outputFacts = candidate.ingredients.map(({ name }) => resolveFoodFacts(name));
    const mappings = outputIndexesForPantryInputs(
      pantryInputs,
      outputFacts,
      candidate.ingredients.map(({ name }) => name),
    );
    return {
      recipe: candidate,
      ingredientReview: createReview(
        pantryInputs,
        'local',
        dietProfile,
        mappings,
        candidate.ingredients.length,
        eligibleInputs.length,
        false,
      ),
    };
  }

  const noResultReview = createReview(pantryInputs, 'none', dietProfile, new Map(), 0, eligibleInputs.length, true);
  return { recipe: null, ingredientReview: noResultReview };
};

/** Backward-compatible draft-only helper for existing callers and rules tests. */
export const generatePantryRecipeDraft = (
  pantryIngredients: readonly string[],
  existingRecipes: RecipeReference[],
  random: () => number = Math.random,
  dietProfile?: DietProfilePayload,
): GeneratedRecipeDraft | null => evaluatePantryRecipeDraft(pantryIngredients, existingRecipes, random, dietProfile).recipe;