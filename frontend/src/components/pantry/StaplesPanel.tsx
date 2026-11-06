import { INGREDIENTS } from '@ikuck/shared/ingredients';

interface StaplesPanelProps {
  stapleIds: string[];
  onToggle: (id: string) => void;
}

export default function StaplesPanel({ stapleIds, onToggle }: StaplesPanelProps) {
  const staples = INGREDIENTS.filter((ingredient) => ingredient.staple);

  return (
    <details className="ik-disclosure min-w-0 border p-4">
      <summary className="flex min-h-11 cursor-pointer select-none flex-wrap items-center gap-2 py-2 font-semibold text-[var(--ik-ink)]">
        <span>Ingredienti di base</span>
        <span className="text-sm font-normal text-[var(--ik-ink-muted)]">{stapleIds.length} attivi</span>
      </summary>
      <fieldset className="mt-3 grid min-w-0 gap-2 border-t border-[var(--ik-border)] pt-3 sm:grid-cols-2">
        <legend className="sr-only">Ingredienti di base disponibili</legend>
        {staples.map((ingredient) => (
          <label key={ingredient.id} className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-3 py-2 text-[var(--ik-ink)]">
            <input type="checkbox" checked={stapleIds.includes(ingredient.id)} onChange={() => onToggle(ingredient.id)} className="h-5 w-5 shrink-0 accent-[var(--ik-basil)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)]" />
            <span className="min-w-0">{ingredient.label}</span>
          </label>
        ))}
      </fieldset>
    </details>
  );
}
