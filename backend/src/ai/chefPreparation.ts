import type { GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { GENERATED_RECIPE_STEP_MAX_LENGTH } from '@ikuck/shared/limits';

const actions = new Map([
  ['WASH', 'Lava'], ['CUT', 'Taglia'], ['MIX', 'Mescola'], ['ADD', 'Aggiungi'],
  ['MASH', 'Schiaccia'], ['DRAIN', 'Scola'], ['PEEL', 'Sbuccia'], ['BLEND', 'Frulla'],
  ['BAKE', 'Cuoci in forno'], ['PAN', 'Cuoci in padella'], ['STEAM', 'Cuoci a vapore'],
  ['GRILL', 'Cuoci alla griglia'], ['REST', 'Lascia riposare'], ['SERVE', 'Servi'],
]);
const timed = new Set(['BAKE', 'PAN', 'STEAM', 'GRILL', 'REST']);
const amount = /^(?:[1-9]\d{0,4}(?:[.,]\d{1,3})?|0[.,]\d{1,3}|[1-9]\d?\/[1-9]\d?)(?: (?:g|kg|ml|cl|l|pz|cucchiaio|cucchiai|cucchiaino|cucchiaini))?$/i;
const step = /^([A-Z]+) ([1-9]\d?(?:,[1-9]\d?)*)(?: ([1-9]\d{0,2})(?: ([1-9]\d{1,2}))?)?$/;

export const CHEF_PREPARATION_RULES = [
  `Nel campo steps usa solo stringhe nel formato AZIONE ID[,ID...] [MINUTI [GRADI]], con ID da 1 nell’ordine di ingredients. Azioni: ${[...actions.keys()].join(', ')}. Usa ogni ID in almeno un passo. Niente testo libero.`,
  'Minuti opzionali (1–480) solo per BAKE, PAN, STEAM, GRILL e REST. Per BAKE puoi anche specificare i gradi Celsius (40–280) dopo i minuti. Esempi: "CUT 1", "BAKE 1,2 30 180", "ADD 3".',
  'Dosi: solo numero positivo o frazione positiva; unità facoltativa tra g, kg, ml, cl, l, pz, cucchiaio, cucchiai, cucchiaino, cucchiaini. Nessun altro testo. Usa un titolo descrittivo, non istruzioni.',
];

export const renderChefPreparation = (draft: GeneratedRecipeDraft): GeneratedRecipeDraft | null => {
  if (draft.ingredients.some(item => !amount.test(item.amount) || /^0[.,]0+$/.test(item.amount.split(' ')[0] ?? ''))) return null;
  const seen = new Set<number>();
  const steps: string[] = [];
  for (const raw of draft.steps) {
    const match = step.exec(raw);
    if (match === null) return null;
    const [, action, references, minutes, degrees] = match;
    const label = actions.get(action!);
    if (label === undefined || (minutes !== undefined && (!timed.has(action!) || Number(minutes) > 480))
      || (degrees !== undefined && (action !== 'BAKE' || Number(degrees) < 40 || Number(degrees) > 280))) return null;
    const names: string[] = [];
    for (const ref of references!.split(',')) {
      const index = Number(ref) - 1;
      const ingredient = draft.ingredients[index];
      if (ingredient === undefined) return null;
      seen.add(index);
      names.push(ingredient.name);
    }
    const rendered = `${label}: ${names.join(', ')}${minutes === undefined ? '' : ` — per ${minutes} min`}${degrees === undefined ? '' : `, a ${degrees} °C`}.`;
    if (rendered.length > GENERATED_RECIPE_STEP_MAX_LENGTH) return null;
    steps.push(rendered);
  }
  return seen.size === draft.ingredients.length
    ? { ...draft, description: 'Ricetta generata con gli ingredienti disponibili in dispensa.', steps }
    : null;
};
