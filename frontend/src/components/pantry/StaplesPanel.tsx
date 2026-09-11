import { INGREDIENTS } from '../../domain/ingredients';

interface StaplesPanelProps {
  stapleIds: string[];
  onToggle: (id: string) => void;
}

export default function StaplesPanel({ stapleIds, onToggle }: StaplesPanelProps) {
  const staples = INGREDIENTS.filter((ingredient) => ingredient.staple);

  return (
    <details className="rounded-2xl border border-gray-200 bg-white p-4">
      <summary className="min-h-11 cursor-pointer select-none py-2 font-semibold text-gray-800">
        Ingredienti di base
        <span className="ml-2 text-sm font-normal text-gray-500">{stapleIds.length} attivi</span>
      </summary>
      <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Ingredienti di base disponibili</legend>
        {staples.map((ingredient) => (
          <label key={ingredient.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-gray-50 px-3 py-2">
            <input type="checkbox" checked={stapleIds.includes(ingredient.id)} onChange={() => onToggle(ingredient.id)} className="h-5 w-5 accent-emerald-700" />
            <span>{ingredient.label}</span>
          </label>
        ))}
      </fieldset>
    </details>
  );
}
