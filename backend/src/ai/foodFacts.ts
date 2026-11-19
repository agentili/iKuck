import type { DietType, EuAllergen } from '@ikuck/shared/contracts';
import { normalizeIngredientName } from '@ikuck/shared/ingredients';

/*
 * Food-fact audit scope:
 * - Regulation (EU) 1169/2011, Annex II: https://eur-lex.europa.eu/eli/reg/2011/1169/oj/eng
 *   defines the 14 allergens represented here; it does not certify a product.
 * - CREA identifies the plain fresh forms of pumpkin (005720) and apples (007120):
 *   https://www.alimentinutrizione.it/tabelle-nutrizionali/005720
 *   https://www.alimentinutrizione.it/tabelle-nutrizionali/007120
 * - Coeliac UK lists quinoa among naturally gluten-free foods and warns that flour
 *   can be contaminated during milling: https://www.coeliac.org.uk/app/uploads/Grains-Page/a-guide-to-grains-nov-2024-1.pdf
 * - Grana Padano describes milk, calf rennet and egg-white lysozyme, noting that
 *   lysozyme is not used in every type: https://www.granapadano.it/it-it/larte-del-saper-fare/il-prodotto-iconico/ingredienti
 * - The Mortadella Bologna specification allows, but does not require, pistachio (Art. 3):
 *   https://mortadellabologna.kleecks-cdn.com/wp-content/uploads/2025/10/Disciplinare-MORTADELLA-BOLOGNA-Guri_rev-PQAIIV_160821.pdf
 *   Commission registry attachment: https://ec.europa.eu/geographical-indications-register/eambrosia-public-api/api/v1/attachments/64856
 * - DPR 187/2001 distinguishes semolina, special and egg pasta (Arts. 6–8):
 *   https://www.normattiva.it/eli/id/2001/05/22/001G0242/CONSOLIDATED
 *
 * These are intrinsic facts for the exact, plain food identity only. They do not
 * certify commercial recipes, labels, processing aids, cross-contamination, or
 * allergens outside the EU-14 model. Sulphite and Mortadella-nut signals below
 * are explicitly conservative policy risks, not claims about every product.
 */

export type DietCompatibility = 'compatible' | 'incompatible' | 'unknown';
export type AllergenCoverage = 'complete' | 'partial' | 'unknown';

export interface FoodResolution {
  identityKey: string | null;
  identityParts: string[];
  identityComplete: boolean;
  presentAllergens: EuAllergen[];
  possibleAllergens: EuAllergen[];
  allergenCoverage: AllergenCoverage;
  diets: Readonly<Record<DietType, DietCompatibility>>;
  localPreparationSupported: boolean;
  evidence: 'name_facts' | 'unverified';
  evidenceNotes: string[];
  recordIds: string[];
  genericPasta: boolean;
}

interface FoodRecord {
  id: string;
  aliases: readonly string[];
  presentAllergens: readonly EuAllergen[];
  possibleAllergens: readonly EuAllergen[];
  allergenCoverage: Exclude<AllergenCoverage, 'unknown'>;
  diets: Readonly<Record<DietType, DietCompatibility>>;
  localPreparationSupported: boolean;
  evidenceNote: string;
  genericPasta?: boolean;
}

const ALL_DIETS: Readonly<Record<DietType, DietCompatibility>> = {
  omnivore: 'compatible', vegetarian: 'compatible', pescatarian: 'compatible', vegan: 'compatible',
};
const MEAT_DIETS: Readonly<Record<DietType, DietCompatibility>> = {
  omnivore: 'compatible', vegetarian: 'incompatible', pescatarian: 'incompatible', vegan: 'incompatible',
};
const SEAFOOD_DIETS: Readonly<Record<DietType, DietCompatibility>> = {
  omnivore: 'compatible', vegetarian: 'incompatible', pescatarian: 'compatible', vegan: 'incompatible',
};
const EGG_DIETS: Readonly<Record<DietType, DietCompatibility>> = {
  omnivore: 'compatible', vegetarian: 'compatible', pescatarian: 'compatible', vegan: 'incompatible',
};
const DAIRY_DIETS: Readonly<Record<DietType, DietCompatibility>> = {
  omnivore: 'compatible', vegetarian: 'compatible', pescatarian: 'compatible', vegan: 'incompatible',
};
const GRANA_DIETS: Readonly<Record<DietType, DietCompatibility>> = {
  omnivore: 'compatible', vegetarian: 'unknown', pescatarian: 'unknown', vegan: 'incompatible',
};

const euAllergenOrder: readonly EuAllergen[] = [
  'gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'nuts',
  'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs',
];

const record = (
  id: string,
  aliases: readonly string[],
  options: Partial<Pick<FoodRecord,
    'presentAllergens' | 'possibleAllergens' | 'allergenCoverage' | 'diets' | 'localPreparationSupported' | 'evidenceNote' | 'genericPasta'>> = {},
): FoodRecord => ({
  id,
  aliases,
  presentAllergens: options.presentAllergens ?? [],
  possibleAllergens: options.possibleAllergens ?? [],
  allergenCoverage: options.allergenCoverage ?? 'complete',
  diets: options.diets ?? ALL_DIETS,
  localPreparationSupported: options.localPreparationSupported ?? true,
  evidenceNote: options.evidenceNote
    ?? 'Plain, single-ingredient name facts cross-checked against EU Annex II; no packaged-product or cross-contamination claim.',
  ...(options.genericPasta === true ? { genericPasta: true } : {}),
});

const foodRecords: readonly FoodRecord[] = [
  record('water', ['acqua']),
  record('salt', ['sale']),
  record('black-pepper', ['pepe', 'pepe nero']),
  record('rice', ['riso']),
  record('chickpeas', ['cece', 'ceci']),
  record('lentils', ['lenticchia', 'lenticchie']),
  record('peas', ['pisello', 'piselli']),
  record('lemon', ['limone', 'limoni']),
  record('arugula', ['rucola']),
  record('tomato', ['pomodoro', 'pomodori']),
  record('cherry-tomato', ['pomodorino', 'pomodorini']),
  record('olives', ['oliva', 'olive']),
  record('zucchini', ['zucchina', 'zucchine']),
  record('bell-pepper', ['peperone', 'peperoni']),
  record('spinach', ['spinacio', 'spinaci']),
  record('eggplant', ['melanzana', 'melanzane']),
  record('carrot', ['carota', 'carote']),
  record('celery', ['sedano'], { presentAllergens: ['celery'] }),
  record('onion', ['cipolla', 'cipolle']),
  record('garlic', ['aglio']),
  record('parsley', ['prezzemolo']),
  record('basil', ['basilico']),
  record('potato', ['patata', 'patate', 'patate novelle'], {
    evidenceNote: 'Patate novelle is an explicit simple-form synonym of Patate; no descriptive or preparation adjective is stripped.',
  }),
  record('pumpkin-fresh', ['zucca', 'zucche'], {
    localPreparationSupported: false,
    evidenceNote: 'Plain fresh pumpkin identity (CREA food 005720) cross-referenced with EU Annex II; not a pumpkin product or contamination claim.',
  }),
  record('apple-fresh', ['mela', 'mele'], {
    localPreparationSupported: false,
    evidenceNote: 'Plain fresh apple identity (CREA food 007120) cross-referenced with EU Annex II; not an apple product or contamination claim.',
  }),
  record('quinoa-plain', ['quinoa'], {
    localPreparationSupported: false,
    evidenceNote: 'Plain quinoa is listed as naturally gluten-free by Coeliac UK; flour and product cross-contamination are expressly outside this identity fact.',
  }),
  record('egg', ['uovo', 'uova'], { presentAllergens: ['eggs'], diets: EGG_DIETS }),
  record('milk', ['latte'], { presentAllergens: ['milk'], diets: DAIRY_DIETS }),
  record('grana-parmigiano-class', ['grana', 'parmigiano', 'parmesan', 'grana padano'], {
    presentAllergens: ['milk'],
    possibleAllergens: ['eggs'],
    allergenCoverage: 'partial',
    diets: GRANA_DIETS,
    evidenceNote: 'Milk is present; egg-white lysozyme is possible for the lossy shared Grana/Parmigiano alias class, not certain for every type. Animal rennet prevents a vegetarian/ pescatarian certification from the name alone.',
  }),
  record('chicken', ['pollo', 'petto di pollo'], { diets: MEAT_DIETS }),
  record('turkey', ['tacchino', 'petto di tacchino'], { diets: MEAT_DIETS }),
  record('beef', ['manzo', 'carne di manzo', 'straccetti di manzo'], { diets: MEAT_DIETS }),
  record('ground-meat', ['carne macinata', 'macinato'], {
    diets: MEAT_DIETS,
    evidenceNote: 'The canonical Carne macinata label identifies meat without specifying a species; only generic meat-diet facts are asserted.',
  }),
  record('pork', ['maiale', 'carne di maiale'], { diets: MEAT_DIETS }),
  ...([
    ['pancetta', ['pancetta']], ['guanciale', ['guanciale']], ['prosciutto', ['prosciutto']],
    ['salame', ['salame']], ['sausage', ['salsiccia']], ['frankfurter', ['wurstel']],
    ['speck', ['speck']], ['bresaola', ['bresaola']],
  ] as const).map(([id, aliases]) => record(`processed-${id}`, aliases, {
    possibleAllergens: ['sulphites'],
    allergenCoverage: 'partial',
    diets: MEAT_DIETS,
    evidenceNote: 'Processed-meat sulphite signal retained as a conservative legacy policy risk, not as a universal ingredient or product-label fact.',
  })),
  record('mortadella', ['mortadella'], {
    possibleAllergens: ['nuts', 'sulphites'],
    allergenCoverage: 'partial',
    diets: MEAT_DIETS,
    evidenceNote: 'Pork meat; pistachio is optional in the Mortadella Bologna specification. Nuts and sulphites remain conservative possible-risk signals, not universal contents.',
  }),
  ...([
    ['tuna', ['tonno']], ['salmon', ['salmone']], ['cod', ['merluzzo']], ['sea-bream', ['orata']],
    ['sea-bass', ['spigola']], ['trout', ['trota']], ['hake', ['nasello']], ['mackerel', ['sgombro']],
    ['anchovy', ['acciuga', 'alici']], ['sardine', ['sarda', 'sarde']], ['herring', ['aringa']],
    ['sole', ['sogliola']], ['turbot', ['rombo']], ['dentex', ['dentice']], ['fish-generic', ['pesce']],
  ] as const).map(([id, aliases]) => record(`fish-${id}`, aliases, {
    presentAllergens: ['fish'],
    diets: SEAFOOD_DIETS,
  })),
  ...([
    ['shrimp', ['gambero', 'gamberi']], ['crab', ['granchio']], ['langoustine', ['scampo', 'scampi']],
    ['lobster', ['astice', 'aragosta']],
  ] as const).map(([id, aliases]) => record(`crustacean-${id}`, aliases, {
    presentAllergens: ['crustaceans'],
    diets: SEAFOOD_DIETS,
  })),
  ...([
    ['squid', ['calamaro', 'calamari']], ['cuttlefish', ['seppia', 'seppie']], ['octopus', ['polpo', 'polpi']],
    ['mussel', ['cozza', 'cozze']], ['clam', ['vongola', 'vongole']],
  ] as const).map(([id, aliases]) => record(`mollusc-${id}`, aliases, {
    presentAllergens: ['molluscs'],
    diets: SEAFOOD_DIETS,
  })),
  record('almond', ['mandorla', 'mandorle'], { presentAllergens: ['nuts'] }),
  record('walnut', ['noce', 'noci'], { presentAllergens: ['nuts'] }),
  record('hazelnut', ['nocciola', 'nocciole'], { presentAllergens: ['nuts'] }),
  record('pine-nut', ['pinolo', 'pinoli'], { presentAllergens: ['nuts'] }),
  record('pistachio', ['pistacchio', 'pistacchi'], { presentAllergens: ['nuts'] }),
  record('cashew', ['anacardo', 'anacardi'], { presentAllergens: ['nuts'] }),
  record('peanut', ['arachide', 'arachidi'], { presentAllergens: ['peanuts'] }),
  record('sesame', ['sesamo'], { presentAllergens: ['sesame'], localPreparationSupported: true }),
  record('mustard', ['senape'], { presentAllergens: ['mustard'], localPreparationSupported: false }),
  record('soy', ['soia', 'edamame'], { presentAllergens: ['soybeans'] }),
  record('lupin', ['lupino', 'lupini'], { presentAllergens: ['lupin'] }),
  record('raisin', ['uvetta'], {
    possibleAllergens: ['sulphites'], allergenCoverage: 'partial',
    evidenceNote: 'Dried-fruit sulphite signal retained as a conservative policy risk; it is not a claim that every product contains sulphites and does not imply tree nuts.',
  }),
  record('date', ['dattero', 'datteri'], {
    possibleAllergens: ['sulphites'], allergenCoverage: 'partial',
    evidenceNote: 'Dried-fruit sulphite signal retained as a conservative policy risk; it is not a claim that every product contains sulphites and does not imply tree nuts.',
  }),
  record('dried-plum', ['prugna secca', 'prugne secche'], {
    possibleAllergens: ['sulphites'], allergenCoverage: 'partial', localPreparationSupported: false,
    evidenceNote: 'Possible sulphites retained conservatively for dried fruit; product-specific ingredients and tree-nut absence are not inferred.',
  }),
  record('dried-apricot', ['albicocca secca', 'albicocche secche'], {
    possibleAllergens: ['sulphites'], allergenCoverage: 'partial', localPreparationSupported: false,
    evidenceNote: 'Possible sulphites retained conservatively for dried fruit; product-specific ingredients and tree-nut absence are not inferred.',
  }),
  record('generic-pasta', ['pasta', 'spaghetti', 'penne'], {
    presentAllergens: ['gluten'],
    possibleAllergens: ['eggs'],
    allergenCoverage: 'partial',
    diets: { omnivore: 'compatible', vegetarian: 'unknown', pescatarian: 'unknown', vegan: 'unknown' },
    localPreparationSupported: false,
    genericPasta: true,
    evidenceNote: 'DPR 187/2001 distinguishes semolina, special and egg pasta. The approved omnivore provider path preserves declared gluten and possible egg risk; the generic name does not establish a concrete product composition.',
  }),
];

const foodByAlias = new Map<string, FoodRecord>();
for (const food of foodRecords) {
  for (const alias of food.aliases) foodByAlias.set(normalizeIngredientName(alias), food);
}

const unknownDiets: Readonly<Record<DietType, DietCompatibility>> = {
  omnivore: 'unknown', vegetarian: 'unknown', pescatarian: 'unknown', vegan: 'unknown',
};

const orderedAllergens = (values: Iterable<EuAllergen>): EuAllergen[] => {
  const found = new Set(values);
  return euAllergenOrder.filter((allergen) => found.has(allergen));
};

const unknownResolution = (): FoodResolution => ({
  identityKey: null,
  identityParts: [],
  identityComplete: false,
  presentAllergens: [],
  possibleAllergens: [],
  allergenCoverage: 'unknown',
  diets: unknownDiets,
  localPreparationSupported: false,
  evidence: 'unverified',
  evidenceNotes: [],
  recordIds: [],
  genericPasta: false,
});

const recordResolution = (food: FoodRecord): FoodResolution => ({
  identityKey: food.id,
  identityParts: [food.id],
  identityComplete: true,
  presentAllergens: orderedAllergens(food.presentAllergens),
  possibleAllergens: orderedAllergens(food.possibleAllergens),
  allergenCoverage: food.allergenCoverage,
  diets: food.diets,
  localPreparationSupported: food.localPreparationSupported,
  evidence: 'name_facts',
  evidenceNotes: [food.evidenceNote],
  recordIds: [food.id],
  genericPasta: food.genericPasta === true,
});

const combineDietStatuses = (components: readonly FoodResolution[]): Readonly<Record<DietType, DietCompatibility>> => {
  const diets: DietType[] = ['omnivore', 'vegetarian', 'pescatarian', 'vegan'];
  return Object.fromEntries(diets.map((diet) => {
    const statuses = components.map((component) => component.diets[diet]);
    const status: DietCompatibility = statuses.includes('incompatible')
      ? 'incompatible'
      : statuses.includes('unknown') ? 'unknown' : 'compatible';
    return [diet, status];
  })) as Readonly<Record<DietType, DietCompatibility>>;
};

const combineFoodResolutions = (components: readonly FoodResolution[]): FoodResolution => {
  const identityComplete = components.every((component) => component.identityComplete);
  const identityParts = components.flatMap((component) => component.identityParts).sort();
  const presentAllergens = orderedAllergens(components.flatMap((component) => component.presentAllergens));
  const presentSet = new Set(presentAllergens);
  const coverage: AllergenCoverage = !identityComplete || components.some((component) => component.allergenCoverage === 'unknown')
    ? 'unknown'
    : components.some((component) => component.allergenCoverage === 'partial') ? 'partial' : 'complete';
  return {
    identityKey: identityComplete ? identityParts.join('&') : null,
    identityParts,
    identityComplete,
    presentAllergens,
    possibleAllergens: orderedAllergens(components.flatMap((component) => component.possibleAllergens)
      .filter((allergen) => !presentSet.has(allergen))),
    allergenCoverage: coverage,
    diets: combineDietStatuses(components),
    localPreparationSupported: identityComplete && components.every((component) => component.localPreparationSupported),
    evidence: identityComplete ? 'name_facts' : 'unverified',
    evidenceNotes: [...new Set(components.flatMap((component) => component.evidenceNotes))],
    recordIds: components.flatMap((component) => component.recordIds),
    genericPasta: identityComplete && components.length === 1 && components[0]?.genericPasta === true,
  };
};

/** Resolve exact aliases first, then only explicitly additive “X e Y” forms. */
export const resolveFoodFacts = (value: string): FoodResolution => {
  const normalized = normalizeIngredientName(value);
  if (!normalized) return unknownResolution();

  const exact = foodByAlias.get(normalized);
  if (exact !== undefined) return recordResolution(exact);

  const additiveParts = normalized.split(/\s+e\s+/u).filter(Boolean);
  if (additiveParts.length > 1) {
    return combineFoodResolutions(additiveParts.map((part) => resolveFoodFacts(part)));
  }

  return unknownResolution();
};

const pastaProviderAliases = new Set([
  'pasta di semola',
  'pasta senza uova',
  'pasta di semola senza uova',
]);

/** Explicitly permitted provider renames still inherit the generic pantry-Pasta risks. */
export const isGenericPastaProviderAlias = (value: string): boolean =>
  pastaProviderAliases.has(normalizeIngredientName(value));

/** True only for identities resolved as exactly the same named component set. */
export const identityPartsAreCovered = (source: FoodResolution, output: FoodResolution): boolean => {
  if (!source.identityComplete || source.identityParts.length === 0 || !output.identityComplete) return false;
  const remaining = [...output.identityParts];
  for (const part of source.identityParts) {
    const index = remaining.indexOf(part);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
};

export const euAllergensInOrder = (values: Iterable<EuAllergen>): EuAllergen[] => orderedAllergens(values);
