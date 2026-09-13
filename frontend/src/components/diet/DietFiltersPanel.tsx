import type { DietProfilePayload, EuAllergen } from '@ikuck/shared/contracts';
import { DIET_TYPES, EU_ALLERGENS, ALLERGEN_LABELS, DIET_LABELS } from '../../domain/dietary';

interface DietFiltersPanelProps {
  profile: DietProfilePayload;
  onChange: (profile: DietProfilePayload) => void;
  onReset: () => void;
}

export default function DietFiltersPanel({ profile, onChange, onReset }: DietFiltersPanelProps) {
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
    <section aria-labelledby="diet-filters-title" className="rounded-2xl border-2 border-emerald-100 bg-emerald-50/60 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="diet-filters-title" className="text-xl font-black text-gray-950">Preferenze alimentari</h2>
          <p id="diet-filters-help" className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-700">
            Gli allergeni sono esclusioni bloccanti. I valori nutrizionali sono stime indicative e non sostituiscono un parere medico.
          </p>
        </div>
        <button type="button" onClick={onReset} className="min-h-10 rounded-xl border-2 border-emerald-800 bg-white px-3 py-2 text-sm font-bold text-emerald-900 hover:bg-emerald-100">
          Ripristina filtri
        </button>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <label htmlFor="diet-select" className="grid gap-1.5 text-sm font-bold text-gray-800 sm:col-span-1">
          Dieta
          <select
            id="diet-select"
            value={profile.diet}
            aria-describedby="diet-filters-help"
            onChange={(event) => onChange({ ...profile, diet: event.target.value as DietProfilePayload['diet'] })}
            className="min-h-11 rounded-xl border-2 border-emerald-200 bg-white px-3 py-2 font-semibold outline-none focus:border-emerald-700"
          >
            {DIET_TYPES.map((diet) => <option key={diet} value={diet}>{DIET_LABELS[diet]}</option>)}
          </select>
        </label>
        <label htmlFor="max-calories" className="grid gap-1.5 text-sm font-bold text-gray-800">
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
            className="min-h-11 rounded-xl border-2 border-emerald-200 bg-white px-3 py-2 font-semibold outline-none focus:border-emerald-700"
          />
        </label>
        <label htmlFor="min-protein" className="grid gap-1.5 text-sm font-bold text-gray-800">
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
            className="min-h-11 rounded-xl border-2 border-emerald-200 bg-white px-3 py-2 font-semibold outline-none focus:border-emerald-700"
          />
        </label>
      </div>

      <fieldset className="mt-5" aria-describedby="diet-filters-help">
        <legend className="text-sm font-bold text-gray-800">Escludi allergeni</legend>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {EU_ALLERGENS.map((allergen) => (
            <label key={allergen} className="flex min-h-11 items-center gap-3 rounded-xl border border-emerald-100 bg-white px-3 py-2 text-sm font-semibold text-gray-800">
              <input
                type="checkbox"
                checked={profile.excludedAllergens.includes(allergen)}
                aria-label={`Escludi ${ALLERGEN_LABELS[allergen]}`}
                onChange={(event) => toggleAllergen(allergen, event.target.checked)}
                className="h-5 w-5 accent-emerald-700"
              />
              {ALLERGEN_LABELS[allergen]}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
