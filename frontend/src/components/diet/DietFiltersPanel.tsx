import type { DietProfilePayload, EuAllergen } from '@ikuck/shared/contracts';
import { DIET_TYPES, EU_ALLERGENS, ALLERGEN_LABELS, DIET_LABELS } from '../../domain/dietary';
import { Button } from '../../components/shared';

interface DietFiltersPanelProps {
  profile: DietProfilePayload;
  onChange: (profile: DietProfilePayload) => void;
  onReset: () => void;
}

export default function DietFiltersPanel({ profile, onChange, onReset }: DietFiltersPanelProps) {
  const activeFilterCount = Number(profile.diet !== 'omnivore')
    + profile.excludedAllergens.length
    + Number(profile.nutrition.maxCaloriesPerServing !== null)
    + Number(profile.nutrition.minProteinGramsPerServing !== null);
  const activeFilterLabel = activeFilterCount === 0 ? 'Nessun filtro attivo' : `${activeFilterCount} ${activeFilterCount === 1 ? 'attivo' : 'attivi'}`;

  const updateNutrition = (key: 'maxCaloriesPerServing' | 'minProteinGramsPerServing', value: string) => {
    const parsed = value.trim() === '' ? null : Number(value);
    onChange({
      ...profile,
      nutrition: { ...profile.nutrition, [key]: parsed },
    });
  };

  const toggleAllergen = (allergen: EuAllergen, checked: boolean) => {
    const excludedAllergens = checked
      ? [...profile.excludedAllergens, allergen]
      : profile.excludedAllergens.filter((item) => item !== allergen);
    onChange({ ...profile, excludedAllergens });
  };

  return (
    <details aria-labelledby="diet-filters-title" className="ik-disclosure">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="diet-filters-title" className="text-xl font-black text-[var(--color-text)]">Filtri alimentari</h2>
          <p id="diet-filters-help" className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)]">
            Gli allergeni sono esclusioni bloccanti. I valori nutrizionali sono stime indicative e non sostituiscono un parere medico.
          </p>
          </div>
          <span className="badge badge-primary">{activeFilterLabel}</span>
        </div>
      </summary>

      <div className="mt-5 flex justify-end">
        <Button variant="secondary" size="sm" onClick={onReset}>
          Ripristina filtri
        </Button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label htmlFor="diet-select" className="grid gap-1.5 text-sm font-bold text-[var(--color-text)] sm:col-span-1">
          Dieta
          <select
            id="diet-select"
            value={profile.diet}
            aria-describedby="diet-filters-help"
            onChange={(event) => onChange({ ...profile, diet: event.target.value as DietProfilePayload['diet'] })}
            className="ik-input min-h-11"
          >
            {DIET_TYPES.map((diet) => <option key={diet} value={diet}>{DIET_LABELS[diet]}</option>)}
          </select>
        </label>
        <label htmlFor="max-calories" className="grid gap-1.5 text-sm font-bold text-[var(--color-text)]">
          Calorie massime per porzione
          <input
            id="max-calories"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={profile.nutrition.maxCaloriesPerServing ?? ''}
            aria-describedby="diet-filters-help"
            onChange={(event) => updateNutrition('maxCaloriesPerServing', event.target.value)}
            className="ik-input min-h-11"
          />
        </label>
        <label htmlFor="min-protein" className="grid gap-1.5 text-sm font-bold text-[var(--color-text)]">
          Proteine minime per porzione (g)
          <input
            id="min-protein"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={profile.nutrition.minProteinGramsPerServing ?? ''}
            aria-describedby="diet-filters-help"
            onChange={(event) => updateNutrition('minProteinGramsPerServing', event.target.value)}
            className="ik-input min-h-11"
          />
        </label>
      </div>

      <fieldset className="mt-5" aria-describedby="diet-filters-help">
        <legend className="text-sm font-bold text-[var(--color-text)]">Escludi allergeni</legend>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {EU_ALLERGENS.map((allergen) => (
            <label key={allergen} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-text)]">
              <input
                type="checkbox"
                checked={profile.excludedAllergens.includes(allergen)}
                aria-label={`Escludi ${ALLERGEN_LABELS[allergen]}`}
                onChange={(event) => toggleAllergen(allergen, event.target.checked)}
                className="h-5 w-5 accent-[var(--color-primary)]"
              />
              {ALLERGEN_LABELS[allergen]}
            </label>
          ))}
        </div>
      </fieldset>
    </details>
  );
}