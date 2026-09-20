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
    <section aria-labelledby="ingredient-suggestions-title" className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="ingredient-suggestions-title" className="font-bold text-gray-950">Potresti aggiungere</h3>
          <p className="text-sm text-gray-600">Questi ingredienti non sono ancora nella tua dispensa e possono aprire nuove ricette.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border-2 border-emerald-200 bg-white px-3 py-2 text-sm font-bold text-emerald-900 hover:border-emerald-500 hover:bg-emerald-100"
        >
          <RefreshCw size={16} aria-hidden="true" />
          Cambia tutti i suggerimenti
        </button>
      </div>
      {ingredients.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Ingredienti da valutare">
          {ingredients.map((ingredient) => (
            <li key={ingredient.id} className="flex max-w-full items-center overflow-hidden rounded-full border border-emerald-200 bg-white text-emerald-900">
              <button
                type="button"
                aria-label={`Aggiungi ${ingredient.label}`}
                onClick={() => onAdd(ingredient)}
                className="inline-flex min-h-11 min-w-0 items-center gap-2 px-3 py-2 text-left font-semibold transition hover:bg-emerald-100 focus:outline-none focus:ring-4 focus:ring-inset focus:ring-emerald-200"
              >
                <Plus size={16} aria-hidden="true" />
                <span>{ingredient.label}</span>
              </button>
              <button
                type="button"
                aria-label={`Sostituisci ${ingredient.label}`}
                title="Sostituisci questo suggerimento"
                onClick={() => onDismiss(ingredient.id)}
                className="inline-flex min-h-11 shrink-0 items-center border-l border-emerald-200 px-2 text-emerald-700 transition hover:bg-emerald-100 hover:text-emerald-950 focus:outline-none focus:ring-4 focus:ring-inset focus:ring-emerald-200"
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="mt-3 rounded-xl border border-dashed border-emerald-200 bg-white/70 px-3 py-2 text-sm font-medium text-emerald-950">
          Non ci sono altri suggerimenti da mostrare.
        </p>
      )}
    </section>
  );
}
