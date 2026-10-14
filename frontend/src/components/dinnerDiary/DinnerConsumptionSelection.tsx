import type { PantryLot } from '@ikuck/shared/contracts';
import type { DinnerConsumptionIngredient, PantryConsumptionPlan } from '@ikuck/shared/pantryConsumption';
import { planPantryConsumption } from '@ikuck/shared/pantryConsumption';
import { DIARY_INGREDIENT_AMOUNT_MAX_LENGTH } from '@ikuck/shared/limits';
import { getIngredient, INGREDIENTS } from '../../domain/ingredients';

interface DinnerConsumptionSelectionProps {
  mode: 'free-text' | 'recipe';
  ingredients: DinnerConsumptionIngredient[];
  lots: readonly PantryLot[];
  servings: number | null;
  noneUsed: boolean;
  onIngredientsChange: (ingredients: DinnerConsumptionIngredient[]) => void;
  onNoneUsedChange: (noneUsed: boolean) => void;
  disabled?: boolean;
  confirmedPlan?: PantryConsumptionPlan | null;
  confirmedNoIngredientsUsed?: boolean;
  confirmedFallbackMessage?: string | null;
}

const formatQuantity = (quantity: number, unit: string): string => (
  `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: 3 }).format(quantity)} ${unit}`
);

const unitLabel = (unit: string): string => ({
  g: 'g', kg: 'kg', ml: 'ml', l: 'l', piece: 'pezzi', pack: 'confezioni',
}[unit] ?? unit);

const describeLine = (line: PantryConsumptionPlan['summary']['lines'][number]): string => {
  if (line.status === 'unused') return `${line.name}: non verrà scalato.`;
  if (line.status === 'presence_consumed') return `Verrà rimossa la presenza di ${line.name}; la quantità non è registrata.`;
  if (line.status === 'unresolved') return `${line.name}: identifica l’ingrediente e indica una quantità certa, oppure deselezionalo.`;
  if (line.status === 'missing') {
    const deficit = line.deficit === null || line.unit === null ? '' : ` (deficit ${formatQuantity(line.deficit, unitLabel(line.unit))})`;
    return `${line.name}: non presente in dispensa${deficit}.`;
  }

  const used = line.consumedQuantity === null || line.unit === null
    ? '0'
    : formatQuantity(line.consumedQuantity, unitLabel(line.unit));
  if (line.deficit !== null && line.deficit > 0 && line.unit !== null) {
    return `Ne userai ${used}; mancano ${formatQuantity(line.deficit, unitLabel(line.unit))} rispetto ai ${formatQuantity(line.requiredQuantity ?? 0, unitLabel(line.unit))} richiesti per ${line.name}.`;
  }
  return `Ne userai ${used} per ${line.name}.`;
};

const describeCommittedPlan = (plan: PantryConsumptionPlan): string[] => plan.summary.lines
  .filter((line) => line.status !== 'unused')
  .map((line) => {
    if (line.status === 'presence_consumed') return `Rimossa la presenza di ${line.name}; quantità non registrata.`;
    if (line.status === 'unresolved') return `${line.name}: quantità non determinata, nessuno stock scalato.`;
    if (line.status === 'missing') {
      const deficit = line.deficit === null || line.unit === null ? '' : `; deficit ${formatQuantity(line.deficit, unitLabel(line.unit))}`;
      return `${line.name}: nessuna quantità scalata${deficit}.`;
    }
    const consumed = line.consumedQuantity === null || line.unit === null
      ? '0'
      : formatQuantity(line.consumedQuantity, unitLabel(line.unit));
    const deficit = line.deficit !== null && line.deficit > 0 && line.unit !== null
      ? `; deficit ${formatQuantity(line.deficit, unitLabel(line.unit))}`
      : '';
    return `Scalati ${consumed} di ${line.name}${deficit}.`;
  });

export default function DinnerConsumptionSelection({
  mode,
  ingredients,
  lots,
  servings,
  noneUsed,
  onIngredientsChange,
  onNoneUsedChange,
  disabled = false,
  confirmedPlan = null,
  confirmedNoIngredientsUsed = false,
  confirmedFallbackMessage = null,
}: DinnerConsumptionSelectionProps) {
  const effectiveIngredients = noneUsed ? [] : ingredients;
  const validServings = servings !== null && Number.isSafeInteger(servings) && servings > 0;
  const plan = planPantryConsumption({
    lots,
    command: {
      operationId: 'preview',
      entryId: 'preview',
      scope: 'guest',
      servings: validServings ? servings : 0,
      ingredients: effectiveIngredients,
    },
    updatedAt: 'preview',
  });

  const updateIngredient = (index: number, next: DinnerConsumptionIngredient): void => {
    onIngredientsChange(ingredients.map((ingredient, currentIndex) => currentIndex === index ? next : ingredient));
  };

  const addIngredient = (): void => {
    onNoneUsedChange(false);
    onIngredientsChange([...ingredients, { ingredientId: null, name: '', amount: '', optional: false, used: true }]);
  };

  const chooseNone = (checked: boolean): void => {
    onNoneUsedChange(checked);
    if (checked) {
      onIngredientsChange(mode === 'free-text' ? [] : ingredients.map((ingredient) => ({ ...ingredient, used: false })));
    }
  };

  return (
    <section aria-label="Ingredienti utilizzati dalla dispensa" className="ik-surface--quiet mt-4 rounded-2xl border border-[var(--ik-border)] p-4">
      <h3 className="text-lg font-bold text-[var(--ik-ink)]">Ingredienti davvero utilizzati</h3>
      <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)]">
        {mode === 'recipe'
          ? 'La ricetta propone ingredienti e quantità per porzione. Verifica cosa avete usato: gli ingredienti facoltativi partono deselezionati.'
          : 'Scegli gli ingredienti della dispensa e indica la quantità per porzione. Il testo della cena non viene interpretato automaticamente.'}
      </p>

      <label className="mt-3 flex min-h-11 items-start gap-3 text-sm font-semibold text-[var(--ik-ink)]">
        <input
          type="checkbox"
          checked={noneUsed}
          disabled={disabled}
          onChange={(event) => chooseNone(event.target.checked)}
          className="mt-1 h-5 w-5"
          style={{ accentColor: 'var(--ik-basil)' }}
        />
        <span>Nessun ingrediente della dispensa utilizzato</span>
      </label>

      {mode === 'free-text' ? (
        <fieldset className="mt-3 space-y-3" disabled={disabled || noneUsed}>
          <legend className="sr-only">Ingredienti scelti per questa cena</legend>
          {ingredients.map((ingredient, index) => {
            const mapped = ingredient.ingredientId !== null ? getIngredient(ingredient.ingredientId) : undefined;
            const name = ingredient.name.trim() || `ingrediente ${index + 1}`;
            return (
              <div key={`free-${index}`} className="grid gap-3 rounded-xl border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                  Ingrediente usato {index + 1}
                  <select
                    aria-label={`Ingrediente usato ${index + 1}`}
                    value={mapped?.id ?? ''}
                    onChange={(event) => {
                      const selected = INGREDIENTS.find((option) => option.id === event.target.value);
                      updateIngredient(index, {
                        ...ingredient,
                        ingredientId: selected?.id ?? null,
                        name: selected?.label ?? '',
                      });
                    }}
                    className="ik-input min-h-11 w-full border-2 px-3 py-2"
                  >
                    <option value="">Scegli un ingrediente</option>
                    {INGREDIENTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                  Quantità per porzione
                  <input
                    type="text"
                    maxLength={DIARY_INGREDIENT_AMOUNT_MAX_LENGTH}
                    aria-label={`Quantità per porzione di ${mapped?.label ?? name}`}
                    value={ingredient.amount}
                    onChange={(event) => updateIngredient(index, { ...ingredient, amount: event.target.value })}
                    placeholder="es. 80 g"
                    className="ik-input min-h-11 w-full border-2 px-3 py-2 font-normal"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => onIngredientsChange(ingredients.filter((_, currentIndex) => currentIndex !== index))}
                  aria-label={`Rimuovi ingrediente ${index + 1}`}
                  className="ik-button-secondary min-h-11 w-fit border-2 px-3 py-2 text-sm font-semibold"
                >
                  Rimuovi
                </button>
              </div>
            );
          })}
          <button type="button" onClick={addIngredient} className="ik-button-secondary min-h-11 border-2 px-4 py-2 font-semibold">
            Aggiungi ingrediente utilizzato
          </button>
        </fieldset>
      ) : (
        <fieldset className="mt-3 space-y-3" disabled={disabled || noneUsed}>
          <legend className="sr-only">Ingredienti della ricetta effettivamente usati</legend>
          {ingredients.map((ingredient, index) => {
            const mapped = ingredient.ingredientId !== null ? getIngredient(ingredient.ingredientId) : undefined;
            const name = ingredient.name.trim() || mapped?.label || `ingrediente ${index + 1}`;
            return (
              <div key={`recipe-${index}`} className="grid gap-3 rounded-xl border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                  Ingrediente {index + 1}
                  <select
                    aria-label={`Ingrediente ricetta ${index + 1}`}
                    value={mapped?.id ?? ''}
                    onChange={(event) => {
                      const selected = INGREDIENTS.find((option) => option.id === event.target.value);
                      updateIngredient(index, {
                        ...ingredient,
                        ingredientId: selected?.id ?? null,
                        name: selected?.label ?? ingredient.name,
                      });
                    }}
                    className="ik-input min-h-11 w-full border-2 px-3 py-2"
                  >
                    <option value="">Associa a un ingrediente della dispensa</option>
                    {INGREDIENTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                  Quantità per porzione
                  <input
                    type="text"
                    maxLength={DIARY_INGREDIENT_AMOUNT_MAX_LENGTH}
                    aria-label={`Quantità per porzione di ${name}`}
                    value={ingredient.amount}
                    onChange={(event) => updateIngredient(index, { ...ingredient, amount: event.target.value })}
                    className="ik-input min-h-11 w-full border-2 px-3 py-2 font-normal"
                  />
                </label>
                <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-[var(--ik-ink)]">
                  <input
                    type="checkbox"
                    checked={ingredient.used}
                    disabled={disabled || noneUsed}
                    onChange={(event) => {
                      if (event.target.checked) onNoneUsedChange(false);
                      updateIngredient(index, { ...ingredient, used: event.target.checked });
                    }}
                    aria-label={`Usato: ${name}`}
                    className="h-5 w-5"
                    style={{ accentColor: 'var(--ik-basil)' }}
                  />
                  {ingredient.optional ? 'Facoltativo: usato davvero' : 'Usato davvero'}
                </label>
              </div>
            );
          })}
        </fieldset>
      )}

      {confirmedPlan !== null ? (
        <div className="mt-4 rounded-xl border border-[var(--ik-border-strong)] bg-[var(--ik-surface)] p-3" role="status" aria-label="Riepilogo dispensa aggiornata">
          <p className="font-bold text-[var(--ik-ink)]">Cena registrata; riepilogo effettivo della dispensa:</p>
          {confirmedPlan.summary.lines.filter((line) => line.status !== 'unused').length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-[var(--ik-ink)]">
              {describeCommittedPlan(confirmedPlan).map((line, index) => <li key={`confirmed-${index}`}>{line}</li>)}
            </ul>
          ) : <p className="mt-1 text-sm text-[var(--ik-ink)]">Nessun ingrediente della dispensa è stato scalato.</p>}
        </div>
      ) : confirmedNoIngredientsUsed ? (
        <p role="status" className="mt-4 rounded-xl border border-[var(--ik-border-strong)] bg-[var(--ik-surface)] p-3 text-sm font-semibold text-[var(--ik-ink)]">
          Cena registrata. Nessun ingrediente della dispensa è stato scalato.
        </p>
      ) : confirmedFallbackMessage !== null ? (
        <p role="status" className="mt-4 rounded-xl border border-[var(--ik-border-strong)] bg-[var(--ik-surface)] p-3 text-sm font-semibold text-[var(--ik-ink)]">{confirmedFallbackMessage}</p>
      ) : null}

      {confirmedPlan === null && !confirmedNoIngredientsUsed && confirmedFallbackMessage === null && (
        <div className="mt-4 rounded-xl bg-[var(--ik-surface)] p-3">
          <p className="text-sm font-bold text-[var(--ik-ink)]">Anteprima sulla dispensa attuale</p>
          {!validServings ? (
            <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">Indica le porzioni per calcolare il consumo.</p>
          ) : noneUsed ? (
            <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">Nessun ingrediente verrà scalato.</p>
          ) : effectiveIngredients.filter((ingredient) => ingredient.used).length === 0 ? (
            <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">Aggiungi gli ingredienti usati oppure conferma esplicitamente che non ne avete usati dalla dispensa.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm text-[var(--ik-ink)]">
              {plan.summary.lines.filter((line) => line.status !== 'unused').map((line, index) => <li key={`preview-${index}`}>{describeLine(line)}</li>)}
            </ul>
          )}
          {plan.unresolvedIngredients.length > 0 && (
            <p className="mt-2 text-sm font-semibold text-rose-800">Prima di confermare, chiarisci ogni ingrediente o quantità ambigua.</p>
          )}
          {plan.summary.deficitCount > 0 && (
            <p className="mt-2 text-sm font-semibold text-amber-900">La registrazione userà solo le scorte presenti e mostrerà il deficit effettivo.</p>
          )}
        </div>
      )}
    </section>
  );
}
