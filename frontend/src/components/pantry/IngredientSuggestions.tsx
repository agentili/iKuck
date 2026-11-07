import { Plus, RefreshCw } from 'lucide-react';
import type { IngredientDefinition } from '../../domain/types';

interface IngredientSuggestionsProps {
  ingredients: IngredientDefinition[];
  onAdd: (ingredient: IngredientDefinition) => void;
  onDismiss: (id: string) => void;
  onRefresh: () => void;
  showEmptyState?: boolean;
}

export default function IngredientSuggestions({ ingredients, onAdd, onDismiss, onRefresh, showEmptyState = false }: IngredientSuggestionsProps) {
  if (ingredients.length === 0 && !showEmptyState) return null;

  return (
    <section aria-labelledby="ingredient-suggestions-title" className="ik-disclosure ik-disclosure--ideas p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="ingredient-suggestions-title" className="font-bold text-[var(--color-text)]">Potresti aggiungere</h3>
          <p className="text-sm text-[var(--color-text-muted)]">Questi ingredienti non sono ancora nella tua dispensa e possono aprire nuove ricette.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="ik-button-secondary min-h-10 shrink-0 text-sm"
        >
          <RefreshCw size={16} aria-hidden="true" />
          Cambia tutti i suggerimenti
        </button>
      </div>
      {ingredients.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Ingredienti da valutare">
          {ingredients.map((ingredient) => (
            <li key={ingredient.id} className="flex max-w-full items-center overflow-hidden rounded-full border border-[var(--color-primary)] bg-[var(--color-surface)] text-[var(--color-primary)]">
              <button
                type="button"
                aria-label={`Aggiungi ${ingredient.label}`}
                onClick={() => onAdd(ingredient)}
                className="inline-flex min-h-11 min-w-0 items-center gap-2 px-3 py-2 text-left font-semibold hover:bg-[var(--color-border)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
              >
                <Plus size={16} aria-hidden="true" />
                <span>{ingredient.label}</span>
              </button>
              <button
                type="button"
                aria-label={`Sostituisci ${ingredient.label}`}
                title="Sostituisci questo suggerimento"
                onClick={() => onDismiss(ingredient.id)}
                className="inline-flex min-h-11 shrink-0 items-center border-l border-[var(--color-primary)] px-2 text-[var(--color-primary)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="mt-3 rounded-xl border border-dashed border-[var(--color-primary)] bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-primary)]">
          Non ci sono altri suggerimenti da mostrare.
        </p>
      )}
    </section>
  );
}