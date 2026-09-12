import { Plus } from 'lucide-react';
import type { IngredientDefinition } from '../../domain/types';

interface IngredientSuggestionsProps {
  ingredients: IngredientDefinition[];
  onAdd: (ingredient: IngredientDefinition) => void;
}

export default function IngredientSuggestions({ ingredients, onAdd }: IngredientSuggestionsProps) {
  if (ingredients.length === 0) return null;

  return (
    <section aria-labelledby="ingredient-suggestions-title" className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h3 id="ingredient-suggestions-title" className="font-bold text-gray-950">Potresti aggiungere</h3>
          <p className="text-sm text-gray-600">Ingredienti utili per aprire nuove ricette.</p>
        </div>
        <span className="text-sm font-medium text-emerald-800">Scelti dalla dispensa</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {ingredients.map((ingredient) => (
          <button
            key={ingredient.id}
            type="button"
            aria-label={`Aggiungi ${ingredient.label}`}
            onClick={() => onAdd(ingredient)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-2 font-semibold text-emerald-900 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-4 focus:ring-emerald-200"
          >
            <Plus size={16} aria-hidden="true" />
            {ingredient.label}
          </button>
        ))}
      </div>
    </section>
  );
}
